/**
 * 本地缓存生命周期管理。
 *
 * 所有缓存都放在 `~/.dsh/` 下，按用途分目录：
 *   video-assets       低清视频 + 切点 + 缩略图（下载代价最高，LRU 保留最近几个）
 *   video-storyboards  分镜拼图（每视频最多 2 张）
 *   video-transcripts  本地转写 / OCR / 画面理解稿
 *   video-analyses     总结 / 章节 / 思维导图 / 对话缓存
 *   video-outlines     章节画面描述
 *   video-translations 双语翻译稿
 *
 * 策略：按「最近访问时间」保留 keepDays 天；assets 另有「最近 N 个视频 + 总量上限」的 LRU；
 * 分镜按视频（docId）分组保留最近 keepCount 个视频。清理是惰性的：插件启动后、以及每次
 * GET /storage 时按 PRUNE_INTERVAL_MS 节流跑一次。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readdir, stat, rm, readFile, writeFile } from 'node:fs/promises';

import { pruneAssets } from './assets.js';

const HOME = homedir();

export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 最多每 6 小时清理一次
const PRUNE_STATE_FILE = join(HOME, '.dsh', 'video-storage-prune.json');

/** 各类缓存的目录与保留策略（assets 的容量上限由 assets.js 自己处理）。 */
export const STORAGE_KINDS = [
  { id: 'assets', dir: join(HOME, '.dsh', 'video-assets'), keepDays: 30, keepCount: 8, group: false },
  { id: 'storyboards', dir: join(HOME, '.dsh', 'video-storyboards'), keepDays: 90, keepCount: 60, group: true },
  { id: 'transcripts', dir: join(HOME, '.dsh', 'video-transcripts'), keepDays: 90, keepCount: 0, group: false },
  { id: 'analyses', dir: join(HOME, '.dsh', 'video-analyses'), keepDays: 90, keepCount: 0, group: false },
  { id: 'outlines', dir: join(HOME, '.dsh', 'video-outlines'), keepDays: 90, keepCount: 0, group: false },
  { id: 'translations', dir: join(HOME, '.dsh', 'video-translations'), keepDays: 90, keepCount: 0, group: false },
];

/** 只读统计：模型与组件体积（不参与自动清理，删了要重下几百 MB）。 */
const READONLY_DIRS = [
  { id: 'models', dir: join(HOME, '.dsh', 'video-models') },
  { id: 'tools', dir: join(HOME, '.dsh', 'video-tools') },
];

async function dirStats(dir) {
  const out = { files: 0, bytes: 0, newestAt: 0, oldestAt: 0 };
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const nested = await dirStats(path);
        out.files += nested.files;
        out.bytes += nested.bytes;
        if (nested.newestAt) out.newestAt = Math.max(out.newestAt || 0, nested.newestAt);
        if (nested.oldestAt) out.oldestAt = out.oldestAt ? Math.min(out.oldestAt, nested.oldestAt) : nested.oldestAt;
        continue;
      }
      const info = await stat(path);
      out.files += 1;
      out.bytes += info.size;
      out.newestAt = Math.max(out.newestAt, info.mtimeMs);
      out.oldestAt = out.oldestAt ? Math.min(out.oldestAt, info.mtimeMs) : info.mtimeMs;
    } catch {
      // ignore
    }
  }
  return out;
}

/** 分镜文件名 `<docId>.json` / `<docId>-1.jpg` → 归组用的 docId。 */
function groupKeyOf(name) {
  const base = name.replace(/-(\d+)\.jpg$/i, '').replace(/\.(json|jpe?g|png)$/i, '');
  return base;
}

/**
 * 清理一个目录：按文件（或按分组）的 mtime 保留最近 keepDays 天内的，
 * 并限制分组数量 keepCount（0 = 不限制）。返回删除统计。
 */
export async function pruneDirectory(dir, { keepDays = 90, keepCount = 0, group = false, now = Date.now() } = {}) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, freedBytes: 0 };
  }
  const items = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      items.push({ path, name: entry.name, mtime: info.mtimeMs, bytes: info.size, key: group ? groupKeyOf(entry.name) : entry.name });
    } catch {
      // ignore
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  const keepKeys = new Set();
  if (group && keepCount > 0) {
    for (const item of items) {
      if (keepKeys.size >= keepCount) break;
      keepKeys.add(item.key);
    }
  }
  let removed = 0;
  let freedBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const expired = keepDays > 0 && now - item.mtime > keepDays * 24 * 60 * 60 * 1000;
    const overflow = group && keepCount > 0 ? !keepKeys.has(item.key) : index >= keepCount && keepCount > 0;
    if (!expired && !overflow) continue;
    try {
      await rm(item.path, { force: true });
      removed += 1;
      freedBytes += item.bytes;
    } catch {
      // ignore
    }
  }
  return { removed, freedBytes };
}

async function readPruneState() {
  try {
    const raw = await readFile(PRUNE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writePruneState(state) {
  try {
    await mkdir(join(HOME, '.dsh'), { recursive: true });
    await writeFile(PRUNE_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }
}

/** 存储概览：各类缓存大小 + 只读的模型/组件体积 + 上次清理时间。 */
export async function storageStatus() {
  const kinds = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const kind of STORAGE_KINDS) {
    const stats = await dirStats(kind.dir);
    kinds.push({ ...kind, ...stats });
    totalBytes += stats.bytes;
    totalFiles += stats.files;
  }
  const readonly = [];
  for (const item of READONLY_DIRS) {
    const stats = await dirStats(item.dir);
    readonly.push({ ...item, ...stats });
  }
  const state = await readPruneState();
  return {
    kinds,
    readonly,
    totalBytes,
    totalFiles,
    lastPrunedAt: Number(state.lastPrunedAt) || 0,
    lastPrune: state.lastPrune || null,
    policy: { pruneIntervalHours: PRUNE_INTERVAL_MS / 3600000 },
  };
}

/** 清空某类缓存（kind='all' 清全部可清类型）。返回清理后的概览。 */
export async function clearStorage(kind = 'all') {
  const targets = STORAGE_KINDS.filter((item) => kind === 'all' || item.id === kind);
  let removed = 0;
  let freedBytes = 0;
  for (const target of targets) {
    const before = await dirStats(target.dir);
    try {
      await rm(target.dir, { recursive: true, force: true });
      await mkdir(target.dir, { recursive: true });
    } catch {
      // ignore
    }
    removed += before.files;
    freedBytes += before.bytes;
  }
  return { removed, freedBytes, status: await storageStatus() };
}

/** 执行一次过期清理（assets 用 LRU，其余按 keepDays / 分组数量）。 */
export async function pruneStorage({ now = Date.now() } = {}) {
  const detail = {};
  let removed = 0;
  let freedBytes = 0;
  for (const kind of STORAGE_KINDS) {
    if (kind.id === 'assets') {
      const before = await dirStats(kind.dir);
      await pruneAssets().catch(() => {});
      const after = await dirStats(kind.dir);
      detail.assets = { removed: Math.max(0, before.files - after.files), freedBytes: Math.max(0, before.bytes - after.bytes) };
    } else {
      detail[kind.id] = await pruneDirectory(kind.dir, { keepDays: kind.keepDays, keepCount: kind.keepCount, group: kind.group, now });
    }
    removed += detail[kind.id].removed || 0;
    freedBytes += detail[kind.id].freedBytes || 0;
  }
  const lastPrunedAt = Date.now();
  await writePruneState({ lastPrunedAt, lastPrune: { removed, freedBytes, detail } });
  return { removed, freedBytes, detail, status: await storageStatus() };
}

/** 节流清理：距上次清理不足 PRUNE_INTERVAL_MS 时直接跳过（force 时强制执行）。 */
export async function maybePruneStorage({ force = false, now = Date.now() } = {}) {
  const state = await readPruneState();
  const last = Number(state.lastPrunedAt) || 0;
  if (!force && last && now - last < PRUNE_INTERVAL_MS) return { skipped: true, lastPrunedAt: last };
  return { skipped: false, ...(await pruneStorage({ now })) };
}
