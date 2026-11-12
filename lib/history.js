/**
 * 最近分析过的视频——只在 host 侧存「摘要」，不存字幕。
 *
 * 面板刷新、换浏览器、甚至重启 App 都还在。写入用 「临时文件 + rename」，
 * 半路挂掉也不会留下半个 JSON 把下次读崩。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HISTORY_FILE = join(homedir(), '.dsh', 'video-history.json');
export const HISTORY_LIMIT = 20;

const TITLE_MAX = 240;
const AUTHOR_MAX = 120;
const COVER_MAX = 1024;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoOrNow(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const docId = text(raw.docId, 200);
  const url = text(raw.url, 2048);
  if (!docId || !url) return null;
  const platform = raw.platform === 'bilibili' ? 'bilibili' : 'youtube';
  return {
    docId,
    url,
    platform,
    id: text(raw.id, 120),
    title: text(raw.title, TITLE_MAX) || '未命名视频',
    author: text(raw.author, AUTHOR_MAX),
    duration: Number.isFinite(Number(raw.duration)) ? Math.max(0, Number(raw.duration)) : 0,
    cover: text(raw.cover, COVER_MAX).replace(/^http:\/\//i, 'https://'),
    hasTranscript: Boolean(raw.hasTranscript),
    analyzedAt: isoOrNow(raw.analyzedAt),
    action: raw.action === 'analyze' ? 'analyze' : 'view',
  };
}

/** 从 VideoDoc 里提取要记住的字段。 */
export function entryFromDoc(doc, action = 'view') {
  if (!doc || typeof doc !== 'object') return null;
  return sanitize({
    docId: doc.docId,
    url: doc.url,
    platform: doc.platform,
    id: doc.id,
    title: doc.title,
    author: doc.author,
    duration: doc.duration,
    cover: doc.cover,
    hasTranscript: Boolean(doc.transcript?.available),
    analyzedAt: new Date().toISOString(),
    action,
  });
}

async function persist(items) {
  await mkdir(join(homedir(), '.dsh'), { recursive: true });
  const body = `${JSON.stringify(items, null, 2)}\n`;
  const tmp = `${HISTORY_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, HISTORY_FILE);
}

export async function readHistory() {
  let text_ = '';
  try {
    text_ = await readFile(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text_);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(sanitize).filter(Boolean).slice(0, HISTORY_LIMIT);
}

/* 记录串行化：面板连点、工具与面板同时写入时不互相覆盖。 */
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 记一条。同一 docId 只保留一条：位置提前、时间刷新；
 * 明确"分析过"的会覆盖之前的"只看过"。
 */
export function recordHistory(doc, action = 'view') {
  const entry = entryFromDoc(doc, action);
  if (!entry) return Promise.resolve([]);
  return enqueue(async () => {
    const items = await readHistory();
    const previous = items.find((item) => item.docId === entry.docId);
    const merged = previous
      ? {
          ...previous,
          ...entry,
          action: previous.action === 'analyze' || entry.action === 'analyze' ? 'analyze' : 'view',
        }
      : entry;
    const next = [merged, ...items.filter((item) => item.docId !== entry.docId)].slice(0, HISTORY_LIMIT);
    await persist(next);
    return next;
  }).catch(() => []);
}

export function removeHistory(docId) {
  const target = text(docId, 200);
  return enqueue(async () => {
    const items = await readHistory();
    const next = items.filter((item) => item.docId !== target);
    if (next.length !== items.length) await persist(next);
    return next;
  }).catch(() => []);
}

export function clearHistory() {
  return enqueue(async () => {
    await persist([]);
    return [];
  }).catch(() => []);
}
