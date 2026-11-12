/**
 * 分析结果持久化：按视频（docId）缓存总结、章节、思维导图与对话记录。
 *
 * 为什么单独存文件而不是塞进解析缓存：解析缓存是内存 LRU（30 分钟就没了），
 * 而用户希望从「历史」里点回来时，之前的分析结果还在——尤其是总结/导图这种
 * 一次要等十几秒、还花 token 的生成物。
 *
 * 存放位置：`~/.dsh/video-analyses/<docId>.json`，每个视频一个文件，原子写入。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ANALYSIS_DIR = join(homedir(), '.dsh', 'video-analyses');
export const ANALYSIS_VERSION = 1;
export const MAX_CHAT_MESSAGES = 40;

const queues = new Map();

function safeDocId(docId) {
  return String(docId ?? '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
}

export function analysisFile(docId) {
  const safe = safeDocId(docId);
  if (!safe) return null;
  return join(ANALYSIS_DIR, `${safe}.json`);
}

function text(value, max = 4000) {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return raw.slice(0, max);
}

/** 只保留面板需要的元信息，避免把字幕/弹幕之类大字段重复落盘。 */
export function docSnapshot(doc) {
  if (!doc || !doc.docId) return null;
  const pages = Array.isArray(doc.pages)
    ? doc.pages.slice(0, 200).map((page) => ({ page: page.page, title: text(page.title, 120), duration: Number(page.duration) || 0 }))
    : [];
  return {
    docId: String(doc.docId),
    url: String(doc.url ?? ''),
    platform: doc.platform ?? '',
    id: String(doc.id ?? ''),
    title: text(doc.title, 300),
    author: text(doc.author, 160),
    duration: Number(doc.duration) || 0,
    cover: text(doc.cover, 1000),
    publishedAt: text(doc.publishedAt, 60),
    description: text(doc.description, 2000),
    stats: doc.stats && typeof doc.stats === 'object' ? doc.stats : null,
    pages,
    hasTranscript: Boolean(doc.transcript?.available ?? doc.hasTranscript),
  };
}

function sanitizeSummary(summary) {
  if (!summary || typeof summary.text !== 'string' || !summary.text.trim()) return null;
  return {
    text: summary.text,
    usage: summary.usage && typeof summary.usage === 'object' ? summary.usage : null,
    // AI 基于总结给出的三条建议追问（面板渲染成可点的 chip）
    suggestions: Array.isArray(summary.suggestions)
      ? summary.suggestions.map((item) => text(item, 80)).filter(Boolean).slice(0, 3)
      : [],
    generatedAt: Number(summary.generatedAt) || Date.now(),
  };
}

function sanitizeChapters(chapters) {
  const items = Array.isArray(chapters?.items) ? chapters.items : [];
  if (items.length === 0) return null;
  return {
    items: items.slice(0, 40).map((item) => ({
      start: Number(item?.start) || 0,
      title: text(item?.title, 120),
      gist: text(item?.gist, 300),
    })),
    source: text(chapters.source, 40) || 'llm',
    generatedAt: Number(chapters.generatedAt) || Date.now(),
  };
}

function sanitizeMindmap(mindmap) {
  if (!mindmap || typeof mindmap !== 'object') return null;
  const clean = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 3) return null;
    const title = text(node.title, 80);
    if (!title) return null;
    const children = Array.isArray(node.children)
      ? node.children.map((child) => clean(child, depth + 1)).filter(Boolean).slice(0, 12)
      : [];
    return { title, children };
  };
  // 兼容两种形状：{title,children} 或 {mindmap:{title,children},generatedAt}
  const source = mindmap.mindmap && typeof mindmap.mindmap === 'object' ? mindmap.mindmap : mindmap;
  const tree = clean(source, 0);
  if (!tree) return null;
  return { mindmap: tree, generatedAt: Number(mindmap.generatedAt) || Date.now() };
}

function sanitizeChat(chat) {
  const list = Array.isArray(chat) ? chat : [];
  return list
    .filter((message) => message && typeof message.text === 'string' && message.text.trim())
    .slice(-MAX_CHAT_MESSAGES)
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: message.text,
      citations: Array.isArray(message.citations)
        ? message.citations.slice(0, 10).map((citation) => ({
            start: Number(citation?.start) || 0,
            end: Number(citation?.end) || 0,
            preview: text(citation?.preview, 120),
          }))
        : [],
      at: Number(message.at) || Date.now(),
    }));
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    version: ANALYSIS_VERSION,
    docId: String(raw.docId ?? ''),
    savedAt: Number(raw.savedAt) || Date.now(),
    doc: raw.doc && typeof raw.doc === 'object' ? docSnapshot(raw.doc) : null,
    summary: sanitizeSummary(raw.summary),
    chapters: sanitizeChapters(raw.chapters),
    mindmap: sanitizeMindmap(raw.mindmap),
    chat: sanitizeChat(raw.chat),
  };
}

/** 读一个视频的分析缓存；不存在/损坏返回 null。 */
export async function readAnalysis(docId) {
  const file = analysisFile(docId);
  if (!file) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.docId && String(parsed.docId) !== String(docId)) return null;
    return sanitize(parsed);
  } catch {
    return null;
  }
}

async function persist(docId, data) {
  const file = analysisFile(docId);
  if (!file) return;
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const payload = sanitize({ ...data, docId, savedAt: Date.now() });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function enqueue(docId, task) {
  const key = safeDocId(docId);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

/**
 * 读-改-写一个视频的分析缓存。updater 拿到当前数据（可能为 null），返回新数据。
 */
export function updateAnalysis(docId, updater) {
  const safe = safeDocId(docId);
  if (!safe) return Promise.resolve(null);
  return enqueue(safe, async () => {
    let current = null;
    const file = analysisFile(safe);
    try {
      current = sanitize(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      current = null;
    }
    const draft = current ?? { version: ANALYSIS_VERSION, docId: safe, savedAt: Date.now(), doc: null, summary: null, chapters: null, mindmap: null, chat: [] };
    const next = updater(draft) ?? draft;
    const data = sanitize({ ...next, docId: safe });
    await persist(safe, data);
    return data;
  });
}

/** 记录/刷新视频元信息（每次解析成功后调用，保证历史里打开也能看到标题封面）。 */
export function rememberDoc(doc) {
  const snapshot = docSnapshot(doc);
  if (!snapshot) return Promise.resolve(null);
  return updateAnalysis(doc.docId, (draft) => ({ ...draft, doc: snapshot }));
}

export function saveSummary(docId, { text, usage, suggestions }) {
  return updateAnalysis(docId, (draft) => ({
    ...draft,
    summary: {
      text,
      usage: usage ?? null,
      suggestions: Array.isArray(suggestions) ? suggestions : [],
      generatedAt: Date.now(),
    },
  }));
}

export function saveChapters(docId, { items, source }) {
  return updateAnalysis(docId, (draft) => ({ ...draft, chapters: { items, source: source ?? 'llm', generatedAt: Date.now() } }));
}

export function saveMindmap(docId, mindmap) {
  return updateAnalysis(docId, (draft) => ({ ...draft, mindmap: { mindmap, generatedAt: Date.now() } }));
}

/** 追加一轮问答（用户问 + 助手答一起传），最多保留 40 条。 */
export function appendChat(docId, messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  return updateAnalysis(docId, (draft) => ({
    ...draft,
    chat: sanitizeChat([...(draft.chat ?? []), ...list]),
  }));
}

export function clearChat(docId) {
  return updateAnalysis(docId, (draft) => ({ ...draft, chat: [] }));
}

export async function removeAnalysis(docId) {
  const file = analysisFile(docId);
  if (!file) return;
  try {
    await unlink(file);
  } catch {
    // 文件不存在时忽略
  }
}

/** /resolve 时挂到 VideoDoc 上的精简结构（只给非空项）。 */
export function analysisView(analysis) {
  if (!analysis) return null;
  const view = {
    savedAt: analysis.savedAt,
    summary: analysis.summary
      ? {
        text: analysis.summary.text,
        usage: analysis.summary.usage,
        suggestions: Array.isArray(analysis.summary.suggestions) ? analysis.summary.suggestions : [],
        generatedAt: analysis.summary.generatedAt,
      }
      : null,
    chapters: analysis.chapters ? { items: analysis.chapters.items, source: analysis.chapters.source, generatedAt: analysis.chapters.generatedAt } : null,
    mindmap: analysis.mindmap ? { mindmap: analysis.mindmap.mindmap, generatedAt: analysis.mindmap.generatedAt } : null,
    chat: Array.isArray(analysis.chat) ? analysis.chat : [],
  };
  if (!view.summary && !view.chapters && !view.mindmap && view.chat.length === 0) return null;
  return view;
}
