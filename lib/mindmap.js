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

const MAX_TRANSCRIPT_CHARS = 24000;
const CACHE_LIMIT = 32;
const MAX_TOP = 10;
const MAX_CHILD = 6;
const MAX_DEPTH = 2;

export const MINDMAP_SYSTEM = [
  '你是一位擅长做「视频知识地图」的中文编辑。',
  '你的任务：只根据用户提供的视频字幕，生成一份可作为思维导图渲染的结构化大纲。',
  '',
  '输出规则（必须严格遵守）：',
  '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  '2. 结构：{"title":"<视频标题>","children":[{"title":"<一级主题>","children":[{"title":"<二级要点>"}]}]}。',
  '3. 层级：根 + 两层（根 → 一级主题 → 二级要点）；一级主题 6-10 个，每个一级主题下 2-4 个二级要点。',
  '4. 每个 title 不超过 18 个汉字，短句或名词短语，不要标点结尾，不要编号。',
  '5. 顺序严格跟随视频内容推进；一级主题要能拼出完整的叙事/论证结构。',
  '6. 只依据字幕内容，不要编造视频里没有的观点、数字或引语；字幕没有覆盖的部分不要硬造。',
  '7. 全中文（专有名词可保留原文）。',
].join('\n');

/** 缓存：docId → {signature, mindmap, generatedAt, usage}。Map 的插入顺序当 LRU。 */
const cache = new Map();

function signatureOf(doc) {
  const transcript = doc?.transcript;
  return [
    doc?.docId ?? '',
    transcript?.source ?? '',
    Number(transcript?.chars) || 0,
    Array.isArray(transcript?.segments) ? transcript.segments.length : 0,
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
export function buildMindmapPrompt(doc) {
  const transcript = doc?.transcript;
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const sampled = sampleSegments(segments, MAX_TRANSCRIPT_CHARS);
  return [
    `视频标题：${doc?.title || '（未知）'}`,
    `平台：${doc?.platform ?? '未知'}｜作者：${doc?.author ?? '未知'}｜时长：${doc?.duration ? Math.round(doc.duration) + ' 秒' : '未知'}`,
    '',
    `【字幕】来源：${transcript?.source ?? '未知'}，语言：${transcript?.lang || '未知'}，共 ${transcript?.chars ?? 0} 字`,
    renderTimestamped(sampled, { budget: MAX_TRANSCRIPT_CHARS }),
    '',
    '请按系统提示的规则，输出这份视频的思维导图 JSON。',
  ].join('\n');
}

function cleanTitle(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 40);
}

function cleanNode(raw, depth, fallbackTitle) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title ?? raw.name ?? raw.text, depth === 0 ? fallbackTitle : '');
  if (!title) return null;
  const children = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const node = cleanNode(child, depth + 1);
      if (node) children.push(node);
      if (children.length >= (depth === 0 ? MAX_TOP : MAX_CHILD)) break;
    }
  }
  return children.length > 0 ? { title, children } : { title };
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
  const root = cleanNode(parsed, 0, doc?.title);
  if (!root || !root.children || root.children.length === 0) return null;
  return root;
}

/**
 * 生成（或命中缓存）思维导图。
 * @returns {Promise<{mindmap:object, generatedAt:number, usage:object|null, cached:boolean}>}
 */
export async function runMindmap(ctx, config, doc, { signal, force = false } = {}) {
  if (!force) {
    const hit = readMindmapCache(doc);
    if (hit) {
      return { mindmap: hit.mindmap, generatedAt: hit.generatedAt, usage: hit.usage ?? null, cached: true };
    }
  }

  const route = currentRoute(ctx, config);
  const { text, usage } = await streamCompletion(ctx, route, {
    system: MINDMAP_SYSTEM,
    prompt: buildMindmapPrompt(doc),
    maxTokens: 2000,
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
