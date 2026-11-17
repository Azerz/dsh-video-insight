/**
 * 视频片段收藏（书签）。
 *
 * 面板里在原文/总结的时间戳上点「收藏」，就把那一段（含起止秒数、原字幕文本）
 * 记到 `~/.dsh/video-bookmarks/<docId>.json`，之后可以在「片段」页签里回看、跳转、
 * 复制，或者导出。每个视频最多存 MAX_BOOKMARKS 条，按开始时间升序排列。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { VideoError } from './util.js';

export const BOOKMARKS_DIR = join(homedir(), '.dsh', 'video-bookmarks');
const MAX_BOOKMARKS = 200;
const MAX_TEXT = 500;
const MAX_LABEL = 60;
const DEFAULT_SPAN = 12; // 没有提供结束时间时，给一个默认片段长度（秒）

export function safeId(docId) {
  return String(docId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 160);
}

export function bookmarkFile(docId) {
  return join(BOOKMARKS_DIR, `${safeId(docId)}.json`);
}

function text(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function seconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100) / 100;
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = seconds(raw.start);
  const end = Math.max(start + 0.5, seconds(raw.end) || start + DEFAULT_SPAN);
  const item = {
    id: text(raw.id, 40) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    start,
    end: Math.round(Math.min(end, 24 * 3600) * 100) / 100,
    text: text(raw.text, MAX_TEXT),
    label: text(raw.label, MAX_LABEL),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
  if (!item.text && !item.label) return null;
  return item;
}

async function readFileJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeFileJson(file, value) {
  await mkdir(BOOKMARKS_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function sortItems(items) {
  return items
    .slice()
    .sort((a, b) => a.start - b.start || a.createdAt - b.createdAt)
    .slice(0, MAX_BOOKMARKS);
}

/** 读出某个视频的收藏（文件不存在/损坏都当作空）。 */
export async function readBookmarks(docId) {
  if (!docId) return { docId: '', url: '', title: '', updatedAt: 0, items: [] };
  const data = await readFileJson(bookmarkFile(docId));
  const items = Array.isArray(data?.items)
    ? sortItems(data.items.map(sanitizeItem).filter(Boolean))
    : [];
  return {
    docId: String(data?.docId ?? docId),
    url: text(data?.url, 500),
    title: text(data?.title, 200),
    updatedAt: Number(data?.updatedAt) || 0,
    items,
  };
}

async function withStore(docId, updater) {
  const current = await readBookmarks(docId);
  const next = await updater(current);
  const data = {
    docId,
    url: next.url,
    title: next.title,
    updatedAt: Date.now(),
    items: sortItems(next.items ?? []),
  };
  await writeFileJson(bookmarkFile(docId), data);
  // 保留 updater 附加的字段（item / duplicate），供路由直接回给面板。
  return { ...next, ...data };
}

/** 新增一条收藏（同一时间点附近、文本相同的算重复，直接返回已有的）。 */
export async function addBookmark(docId, payload = {}) {
  const item = sanitizeItem(payload);
  if (!item) throw new VideoError('bad-param', '收藏内容为空，至少要有一段文字或时间点。');
  return withStore(docId, (store) => {
    const duplicate = store.items.find(
      (existing) => Math.abs(existing.start - item.start) < 1.5 && existing.text === item.text,
    );
    if (duplicate) return { ...store, items: store.items, duplicate: true, item: duplicate };
    return {
      ...store,
      url: text(payload.url, 500) || store.url,
      title: text(payload.title, 200) || store.title,
      items: [...store.items, item],
      duplicate: false,
      item,
    };
  });
}

export async function removeBookmark(docId, id) {
  const target = String(id ?? '');
  if (!target) throw new VideoError('bad-param', '缺少片段 id。');
  return withStore(docId, (store) => ({
    ...store,
    items: store.items.filter((item) => item.id !== target),
  }));
}

export async function clearBookmarks(docId) {
  await rm(bookmarkFile(docId), { force: true }).catch(() => {});
  return { docId, items: [] };
}

/** 列出所有视频的收藏数量（供历史页签显示徽标，可选）。 */
export async function bookmarkCounts() {
  let names = [];
  try {
    names = await readdir(BOOKMARKS_DIR);
  } catch {
    return {};
  }
  const counts = {};
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const data = await readFileJson(join(BOOKMARKS_DIR, name));
    const count = Array.isArray(data?.items) ? data.items.length : 0;
    if (count && data?.docId) counts[data.docId] = count;
  }
  return counts;
}
