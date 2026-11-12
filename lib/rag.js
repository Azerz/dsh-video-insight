/**
 * 转写稿检索（RAG 的 R）：把字幕切成语义窗口，用 BM25 召回与问题相关的段落。
 *
 * 为什么用 BM25 而不是向量：插件不引入任何依赖（embedding 需要模型 + 推理运行时），
 * 而视频转写稿的关键词重合度足够高——问「为什么学校扼杀创造力」，字幕里就会出现
 * 「学校」「创造力」等词；中文用 bigram 切分即可达到可用的召回率。
 */

import { toSimplified } from './zh.js';

const K1 = 1.4;
const B = 0.75;
const CHUNK_MIN_CHARS = 140;
const CHUNK_MAX_CHARS = 320;
const CHUNK_GAP_SECONDS = 6;
const DEFAULT_LIMIT = 7;
const CACHE_LIMIT = 8;

const ASCII_WORD = /[a-z0-9][a-z0-9_+-]*/g;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

const indexCache = new Map();

function lruGet(key) {
  if (!indexCache.has(key)) return null;
  const value = indexCache.get(key);
  indexCache.delete(key);
  indexCache.set(key, value);
  return value;
}

function lruPut(key, value) {
  if (indexCache.has(key)) indexCache.delete(key);
  indexCache.set(key, value);
  while (indexCache.size > CACHE_LIMIT) {
    indexCache.delete(indexCache.keys().next().value);
  }
}

/** 文本 → 检索 token：英文/数字词 + 中文 bigram（单字窗口用单字）。 */
export function tokenize(text) {
  // 先做繁→简归一化：YouTube 中文（台湾）字幕常是繁体，用户问题多半是简体。
  const raw = toSimplified(String(text ?? '')).toLowerCase();
  if (!raw) return [];
  const tokens = [];
  for (const word of raw.match(ASCII_WORD) ?? []) {
    if (word.length >= 2) tokens.push(word);
  }
  for (const run of raw.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 把转写段落合并成检索窗口。
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function chunkSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const chunks = [];
  let current = null;

  const flush = () => {
    if (current && current.text.trim()) {
      chunks.push({ start: current.start, end: current.end, text: current.text.trim() });
    }
    current = null;
  };

  for (const segment of list) {
    const text = String(segment?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(segment.start) || 0;
    const end = Number.isFinite(Number(segment.end)) ? Number(segment.end) : start;

    if (!current) {
      current = { start, end, text };
      continue;
    }
    const gap = start - current.end;
    const wouldBe = current.text.length + text.length + 1;
    if (gap > CHUNK_GAP_SECONDS || wouldBe > CHUNK_MAX_CHARS) {
      flush();
      current = { start, end, text };
      continue;
    }
    current.text += ` ${text}`;
    current.end = Math.max(current.end, end);
    if (current.text.length >= CHUNK_MIN_CHARS) flush();
  }
  flush();
  return chunks;
}

/** 内存缓存：同一份转写稿只切一次。 */
export function buildIndex(doc) {
  const segments = doc?.transcript?.available ? doc.transcript.segments : [];
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const docId = String(doc?.docId ?? '');
  const signature = `${docId}|${doc.transcript.source ?? ''}|${segments.length}|${doc.transcript.chars ?? ''}`;
  const cached = lruGet(signature);
  if (cached) return cached;

  const chunks = chunkSegments(segments);
  if (chunks.length === 0) return null;

  const df = new Map();
  let totalLength = 0;
  const prepared = chunks.map((chunk, index) => {
    const tokens = tokenize(chunk.text);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    totalLength += tokens.length;
    return { ...chunk, index, tf, length: tokens.length };
  });

  const index = {
    docId,
    signature,
    chars: Number(doc.transcript.chars) || 0,
    chunks: prepared,
    df,
    avgdl: totalLength / prepared.length,
  };
  lruPut(signature, index);
  return index;
}

function bm25Score(chunk, queryTokens, index) {
  const total = index.chunks.length;
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.tf.get(token);
    if (!tf) continue;
    const df = index.df.get(token) ?? 0;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / (index.avgdl || 1)));
    // 中文 bigram 越长越具体，加一点权重，避免被高频二字词淹没
    if (token.length > 2) score += idf * 0.15;
  }
  return score;
}

/**
 * 检索与 query 相关的窗口。
 * @returns {Array<{start:number,end:number,text:string,score:number}>}
 */
export function searchChunks(doc, query, { limit = DEFAULT_LIMIT } = {}) {
  const index = buildIndex(doc);
  if (!index) return [];
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const scored = index.chunks
    .map((chunk) => ({ start: chunk.start, end: chunk.end, text: chunk.text, score: bm25Score(chunk, queryTokens, index) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  for (const chunk of scored) {
    if (picked.length >= limit) break;
    // 时间窗口大面积重叠的窗口只保留得分最高的那个
    const overlap = picked.some((item) => {
      const left = Math.max(item.start, chunk.start);
      const right = Math.min(item.end, chunk.end);
      const shared = right - left;
      return shared > 0 && shared > Math.min(item.end - item.start, chunk.end - chunk.start) * 0.5;
    });
    if (!overlap) picked.push(chunk);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** 检索结果 → 喂给模型的段落块（带时间戳）。 */
export function formatRetrieval(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return chunks
    .map((chunk) => `[${formatClock(chunk.start)}-${formatClock(chunk.end)}] ${chunk.text}`)
    .join('\n');
}

/** 检索结果 → 前端可点击的引用列表。 */
export function citationsOf(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  return chunks.map((chunk) => ({
    start: Math.round(chunk.start * 10) / 10,
    end: Math.round(chunk.end * 10) / 10,
    preview: String(chunk.text ?? '').slice(0, 90),
    score: Math.round((chunk.score ?? 0) * 100) / 100,
  }));
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
