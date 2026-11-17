/**
 * 字幕双语对照翻译。
 *
 * 转写稿（平台字幕 / 本地 Whisper / OCR / 画面理解）本身就是时间轴对齐的段落数组，
 * 这里按批把「文本」送模型翻译，再把译文按 index 对回原来的时间戳，缓存成
 * ~/.dsh/video-translations/<docId>.<lang>.json，面板「原文」页签可以逐段显示对照。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { VideoError } from './util.js';
import { currentRoute, streamCompletion } from './analyze.js';

export const TRANSLATE_DIR = join(homedir(), '.dsh', 'video-translations');
export const TRANSLATE_LANGS = { zh: '中文', en: 'English' };

const BATCH_SEGMENTS = 40;
const BATCH_CHARS = 3200;
const MAX_TRANSLATIONS = 6000;
const MAX_TOKENS = 3000;

const SYSTEM = [
  '你在做视频字幕的双语对照翻译。用户会给出一段 JSON 数组，每一项是一条字幕的文本。',
  '请把每一条翻译成{LANE}，保持口语、简明、自然；专有名词可以保留原文。',
  '只输出一个 JSON 数组：长度必须与输入完全一致，每个元素是一条字幕的译文字符串（不要包含序号、时间戳或解释）。',
  '不要输出任何 JSON 之外的内容。',
].join('\n');

export function safeId(docId) {
  return String(docId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 160);
}

export function translateFile(docId, lang) {
  return join(TRANSLATE_DIR, `${safeId(docId)}.${lang}.json`);
}

export function normalizeLang(value) {
  const lang = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TRANSLATE_LANGS, lang) ? lang : '';
}

function sanitizeSegment(item) {
  if (!item || typeof item !== 'object') return null;
  const start = Number(item.start);
  const end = Number(item.end);
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  const translation = typeof item.translation === 'string' ? item.translation.trim() : '';
  if (!Number.isFinite(start) || !text) return null;
  return {
    start: Math.max(0, start),
    end: Number.isFinite(end) && end > start ? end : start,
    text,
    translation,
  };
}

export async function readTranslation(docId, lang) {
  const normalized = normalizeLang(lang);
  if (!normalized || !docId) return null;
  let raw;
  try {
    raw = await readFile(translateFile(docId, normalized), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const translations = Array.isArray(parsed?.translations)
      ? parsed.translations.map(sanitizeSegment).filter(Boolean)
      : [];
    if (translations.length === 0) return null;
    return {
      docId: String(parsed.docId ?? docId),
      lang: normalized,
      langLabel: TRANSLATE_LANGS[normalized],
      source: parsed.source === 'cache' ? 'cache' : 'llm',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      createdAt: Number(parsed.createdAt) || 0,
      count: translations.length,
      translations,
      cached: true,
    };
  } catch {
    return null;
  }
}

/** 把段落切成若干批：每批不超过 BATCH_SEGMENTS 段，也不超过 BATCH_CHARS 字。 */
export function splitBatches(segments) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const segment of segments) {
    const size = segment.text.length;
    if (current.length > 0 && (current.length >= BATCH_SEGMENTS || chars + size > BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildTranslatePrompt(segments, lang) {
  const label = TRANSLATE_LANGS[lang] ?? '中文';
  const payload = segments.map((segment) => segment.text);
  return [
    `请把下面 ${payload.length} 条字幕翻译成${label}，只输出 JSON 字符串数组（长度 ${payload.length}）。`,
    '输入：',
    JSON.stringify(payload),
  ].join('\n');
}

/** 从模型输出里抠 JSON 数组，并按输入条数对齐（多截少补空串）。 */
export function parseTranslations(rawText, expected) {
  const text = String(rawText ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new VideoError('bad-json', '模型返回的译文不是合法 JSON，请重试一次。');
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new VideoError('bad-json', '模型返回的译文不是合法 JSON，请重试一次。');
  }
  if (!Array.isArray(parsed)) {
    throw new VideoError('bad-json', '模型返回的译文不是数组，请重试一次。');
  }
  const lines = parsed.map((item) => (typeof item === 'string' ? item.trim() : ''));
  while (lines.length < expected) lines.push('');
  return lines.slice(0, expected);
}

async function writeTranslation(data) {
  await mkdir(TRANSLATE_DIR, { recursive: true });
  const file = translateFile(data.docId, data.lang);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function clearTranslation(docId, lang) {
  const { unlink } = await import('node:fs/promises');
  const normalized = normalizeLang(lang);
  if (!normalized || !docId) return false;
  try {
    await unlink(translateFile(docId, normalized));
    return true;
  } catch {
    return false;
  }
}

/**
 * 翻译转写稿。
 *
 * @param {object} ctx       ai holder（llm / agentDefaultModel）
 * @param {object} config    插件配置
 * @param {object} doc       VideoDoc（需要 doc.transcript.segments）
 * @param {object} options   { lang, signal, force, onProgress(percent) }
 * @returns {Promise<object>} { docId, lang, langLabel, source, model, createdAt, count, translations, cached }
 */
export async function runTranslate(ctx, config, doc, { lang, signal, force = false, onProgress } = {}) {
  const normalized = normalizeLang(lang || 'zh');
  if (!normalized) throw new VideoError('bad-lang', '只支持 zh / en 两种目标语言。');
  const transcript = doc?.transcript;
  if (!transcript?.available || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    throw new VideoError('no-transcript', '这个视频还没有字幕或转写稿，先生成文字稿再翻译。');
  }
  const segments = transcript.segments
    .map((item) => {
      const start = Number(item.start);
      const end = Number(item.end);
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!Number.isFinite(start) || !text) return null;
      return { start: Math.max(0, start), end: Number.isFinite(end) && end > start ? end : start, text };
    })
    .filter(Boolean)
    .slice(0, MAX_TRANSLATIONS);
  if (segments.length === 0) {
    throw new VideoError('no-transcript', '这个视频还没有字幕或转写稿，先生成文字稿再翻译。');
  }

  if (!force) {
    const cached = await readTranslation(doc.docId, normalized);
    if (cached) return cached;
  }

  const route = currentRoute(ctx, config);
  if (!route?.provider || !route?.model) {
    throw new VideoError(
      'no-route',
      '没有可用的模型：请先在 Harness 里选择一个模型，或在插件 config 里配置 provider / model。',
    );
  }

  const system = SYSTEM.replace('{LANE}', TRANSLATE_LANGS[normalized]);
  const batches = splitBatches(segments);
  const translations = [];
  let done = 0;
  for (const batch of batches) {
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    const { text } = await streamCompletion(ctx, route, {
      system,
      prompt: buildTranslatePrompt(batch, normalized),
      maxTokens: MAX_TOKENS,
      signal,
    });
    const lines = parseTranslations(text, batch.length);
    for (let i = 0; i < batch.length; i += 1) {
      translations.push({ ...batch[i], translation: lines[i] ?? '' });
    }
    done += batch.length;
    onProgress?.(Math.round((done / segments.length) * 1000) / 10);
  }

  const data = {
    docId: String(doc.docId ?? ''),
    lang: normalized,
    langLabel: TRANSLATE_LANGS[normalized],
    source: 'llm',
    model: route.model,
    createdAt: Date.now(),
    count: translations.length,
    translations,
  };
  await writeTranslation(data);
  return { ...data, cached: false };
}
