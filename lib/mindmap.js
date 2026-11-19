/**
 * dsh-video host 半 · 思维导图
 *
 * 面板右侧「思维导图」页签用：把字幕（或本地转写）交给默认模型，
 * 生成一棵 {title, children[]} 的树，浏览器半只负责折叠渲染。
 *
 * 与总结/追问共用同一条 `ctx.llm.stream()` 通道和 PANEL_SESSION，
 * 不额外要求用户配 key。结果在内存里按「文档 + 字幕指纹」缓存，
 * 同一视频切换页签不会重复花钱；带 force 才重新生成。
 */

import { VideoError, renderTimestamped, sampleSegments } from './util.js';
import { currentRoute, streamCompletion } from './analyze.js';
import { langInstruction, normalizeLang } from './lang.js';

const MAX_TRANSCRIPT_CHARS = 24000;
const CACHE_LIMIT = 32;
const MAX_TOP = 10;
const MAX_CHILD = 6;
const MAX_DEPTH = 2;

export const MINDMAP_SYSTEM_ZH = [
  '你是一位擅长做「视频知识地图」的中文编辑。',
  '你的任务：只根据用户提供的视频字幕，生成一份可作为思维导图渲染的结构化大纲。',
  '',
  '输出规则（必须严格遵守）：',
  '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  '2. 结构：{"title":"<视频标题>","children":[{"title":"<一级主题>","t":<该主题开始的秒数>,"children":[{"title":"<二级要点>","t":<秒数>}]}]}。',
  '3. 层级：根 + 两层（根 → 一级主题 → 二级要点）；一级主题 6-10 个，每个一级主题下 2-4 个二级要点。',
  '4. 每个 title 不超过 18 个汉字，短句或名词短语，不要标点结尾，不要编号。',
  '5. 顺序严格跟随视频内容推进；一级主题要能拼出完整的叙事/论证结构。',
  '6. 只依据字幕内容，不要编造视频里没有的观点、数字或引语；字幕没有覆盖的部分不要硬造。',
  '7. 全中文（专有名词可保留原文）。',
  '8. 每个节点尽量带 "t"：该主题在视频里对应的时间点（整数秒，参考字幕行首的 [mm:ss]）；实在无法判断时可以省略，不要瞎编。',
].join('\n');

/** 兼容旧引用：默认中文模板。 */
export const MINDMAP_SYSTEM = MINDMAP_SYSTEM_ZH;

const MINDMAP_SYSTEM_EN = [
  'You are an editor who builds knowledge maps for videos.',
  'Task: from the given transcript only, produce a structured outline that can be rendered as a mind map.',
  '',
  'Output rules (strict):',
  '1. Output exactly one JSON object; no Markdown fences, no explanations.',
  '2. Shape: {"title":"<video title>","children":[{"title":"<top topic>","t":<seconds>,"children":[{"title":"<sub point>","t":<seconds>}]}]}.',
  '3. Levels: root + two levels; 6-10 top topics, each with 2-4 sub points.',
  '4. Each title max 12 words, short phrase, no trailing punctuation, no numbering.',
  '5. Keep the chronology of the video; top topics together should form the full narrative/argument.',
  '6. Use only the transcript; never invent opinions, numbers or quotes not present.',
  '7. English (keep proper nouns as-is).',
  '8. Include "t" whenever possible: the second where the topic appears (integer, derived from [mm:ss] at line starts); omit it when impossible rather than guessing.',
].join('\n');

/** 按语言取导图系统提示。 */
export function mindmapSystem(lang) {
  const id = normalizeLang(lang);
  if (id === 'zh') return MINDMAP_SYSTEM_ZH;
  return id === 'en' ? MINDMAP_SYSTEM_EN : `${MINDMAP_SYSTEM_EN}\n\n${langInstruction(id)}`;
}

/** 缓存：docId → {signature, mindmap, generatedAt, usage}。Map 的插入顺序当 LRU。 */
const cache = new Map();

function signatureOf(doc) {
  const transcript = doc?.transcript;
  return [
    doc?.docId ?? '',
    transcript?.source ?? '',
    Number(transcript?.chars) || 0,
    Array.isArray(transcript?.segments) ? transcript.segments.length : 0,
    normalizeLang(doc?.__lang ?? 'zh'),
  ].join('|');
}

export function clearMindmapCache(docId) {
  if (docId) cache.delete(String(docId));
  else cache.clear();
}

export function readMindmapCache(doc) {
  const signature = signatureOf(doc);
  const hit = cache.get(doc?.docId);
  if (!hit || hit.signature !== signature) return null;
  // 重新插入，保持 LRU 顺序
  cache.delete(doc.docId);
  cache.set(doc.docId, hit);
  return hit;
}

function writeMindmapCache(doc, entry) {
  const docId = String(doc?.docId ?? '');
  if (!docId) return;
  cache.delete(docId);
  cache.set(docId, { signature: signatureOf(doc), ...entry });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** 元信息 + 字幕采样（超长时均匀抽样，保留头尾）。 */
export function buildMindmapPrompt(doc, lang = 'zh') {
  const transcript = doc?.transcript;
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const sampled = sampleSegments(segments, MAX_TRANSCRIPT_CHARS);
  return [
    `${normalizeLang(lang) === 'zh' ? '视频标题' : 'Video title'}：${doc?.title || (normalizeLang(lang) === 'zh' ? '（未知）' : '(unknown)')}`,
    `${normalizeLang(lang) === 'zh' ? '平台' : 'Platform'}：${doc?.platform ?? 'unknown'}｜${normalizeLang(lang) === 'zh' ? '作者' : 'Author'}：${doc?.author ?? 'unknown'}｜${normalizeLang(lang) === 'zh' ? '时长' : 'Duration'}：${doc?.duration ? Math.round(doc.duration) + (normalizeLang(lang) === 'zh' ? ' 秒' : ' s') : 'unknown'}`,
    '',
    `【${normalizeLang(lang) === 'zh' ? '字幕' : 'Transcript'}】${normalizeLang(lang) === 'zh' ? '来源' : 'source'}：${transcript?.source ?? 'unknown'}，${normalizeLang(lang) === 'zh' ? '语言' : 'language'}：${transcript?.lang || 'unknown'}，${normalizeLang(lang) === 'zh' ? '共' : 'about'} ${transcript?.chars ?? 0} ${normalizeLang(lang) === 'zh' ? '字' : 'chars'}`,
    renderTimestamped(sampled, { budget: MAX_TRANSCRIPT_CHARS }),
    '',
    normalizeLang(lang) === 'zh' ? '请按系统提示的规则，输出这份视频的思维导图 JSON。' : 'Follow the system rules and output the mind map JSON.',
  ].join('\n');
}

function cleanTitle(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 40);
}

function cleanSeconds(value, duration) {
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').replace(/[^0-9.]/g, ''), 10);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : 24 * 3600;
  return Math.round(Math.min(raw, limit));
}

function cleanNode(raw, depth, fallbackTitle, duration) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title ?? raw.name ?? raw.text, depth === 0 ? fallbackTitle : '');
  if (!title) return null;
  const t = cleanSeconds(raw.t ?? raw.start ?? raw.time ?? raw.at, duration);
  const children = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const node = cleanNode(child, depth + 1, '', duration);
      if (node) children.push(node);
      if (children.length >= (depth === 0 ? MAX_TOP : MAX_CHILD)) break;
    }
  }
  const node = t === null ? { title } : { title, t };
  if (children.length > 0) node.children = children;
  return node;
}

/**
 * 容错解析模型输出：允许前后有解释文字或 ```json 围栏，取第一个 `{` 到最后一个 `}`。
 * 解析失败返回 null，由调用方决定报错。
 */
export function parseMindmap(rawText, doc) {
  const text = String(rawText ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = cleanNode(parsed, 0, doc?.title, doc?.duration);
  if (!root || !root.children || root.children.length === 0) return null;
  return root;
}

/**
 * 生成（或命中缓存）思维导图。
 * @returns {Promise<{mindmap:object, generatedAt:number, usage:object|null, cached:boolean}>}
 */
export async function runMindmap(ctx, config, doc, { signal, force = false, lang = 'zh' } = {}) {
  if (lang) doc = { ...doc, __lang: normalizeLang(lang) };
  if (!force) {
    const hit = readMindmapCache(doc);
    if (hit) {
      return { mindmap: hit.mindmap, generatedAt: hit.generatedAt, usage: hit.usage ?? null, cached: true };
    }
  }

  const route = currentRoute(ctx, config);
  const { text, usage } = await streamCompletion(ctx, route, {
    system: mindmapSystem(lang),
    prompt: buildMindmapPrompt(doc, lang),
    // 英文/多语言下模型常先思考再输出 JSON，预算太小会被思考吃光（表现为 llm-empty）
    maxTokens: 4800,
    signal,
  });
  const mindmap = parseMindmap(text, doc);
  if (!mindmap) {
    throw new VideoError('bad-json', '模型返回的思维导图不是合法 JSON，请重新生成一次。');
  }
  const entry = { mindmap, generatedAt: Date.now(), usage: usage ?? null };
  writeMindmapCache(doc, entry);
  return { ...entry, cached: false };
}
