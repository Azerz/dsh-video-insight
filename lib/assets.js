/**
 * 视频素材缓存（低清视频 + 镜头切点）。
 *
 * 画面文字识别、画面理解、分镜页签、章节插图都从同一份 480p 视频抽帧；
 * 以前每次都要重新 `yt-dlp` 下载 + 扫一遍切点，现在按视频缓存：
 *
 *   ~/.dsh/video-assets/<docId>/video.<ext>   低清视频（480p 以内，无音轨）
 *   ~/.dsh/video-assets/<docId>/video.json    视频元信息（bytes / duration / downloadedAt）
 *   ~/.dsh/video-assets/<docId>/cuts.json     镜头切点（按 duration + threshold 失效）
 *
 * 缓存按目录 LRU 清理：最多保留 ASSET_MAX_DIRS 个视频、总大小不超过 ASSET_MAX_BYTES。
 * 副作用：抽帧产物（frame-*.jpg / shot-*.jpg）仍然放在临时 workdir，不进缓存。
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { VideoError } from './util.js';
import { downloadVideo } from './media.js';
import { scanCuts } from './cuts.js';

export const ASSETS_DIR = join(homedir(), '.dsh', 'video-assets');
const ASSET_MAX_DIRS = 8;
const ASSET_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

const ALIVE_MS = 1000 * 60 * 60 * 24 * 30; // 30 天不看就清掉

export function safeId(docId) {
  return String(docId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 160);
}

export function assetPaths(docId) {
  const dir = join(ASSETS_DIR, safeId(docId));
  return {
    dir,
    meta: join(dir, 'video.json'),
    cuts: join(dir, 'cuts.json'),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

function normalizeDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 100) / 100;
}

/** 读出可用的低清视频（文件确实存在且非空才算命中）。 */
export async function readVideoAsset(docId) {
  if (!docId) return null;
  const paths = assetPaths(docId);
  const meta = await readJson(paths.meta);
  if (!meta?.file) return null;
  try {
    const info = await stat(meta.file);
    if (!info.size) return null;
    return {
      docId: String(meta.docId ?? docId),
      file: meta.file,
      bytes: info.size,
      duration: normalizeDuration(meta.duration),
      downloadedAt: Number(meta.downloadedAt) || 0,
      cached: true,
    };
  } catch {
    return null;
  }
}

export async function readCutsAsset(docId, { duration = 0, threshold = 0 } = {}) {
  if (!docId) return null;
  const cached = await readJson(assetPaths(docId).cuts);
  if (!cached || !Array.isArray(cached.cuts)) return null;
  const wantDuration = normalizeDuration(duration);
  const wantThreshold = Math.round(Number(threshold) || 0);
  if (wantDuration && Math.abs(cached.duration - wantDuration) > 1) return null;
  if (wantThreshold && Math.round(Number(cached.threshold) || 0) !== wantThreshold) return null;
  return {
    cuts: cached.cuts,
    scanned: Number(cached.scanned) || 0,
    fps: Number(cached.fps) || 4,
    duration: Number(cached.duration) || 0,
    threshold: Number(cached.threshold) || 0,
    createdAt: Number(cached.createdAt) || 0,
    cached: true,
  };
}

async function writeCutsAsset(docId, data) {
  await writeJson(assetPaths(docId).cuts, {
    docId,
    ...data,
    createdAt: Date.now(),
  });
}

/** LRU 清理：按目录 mtime 保留最近的几个，并限制总大小。 */
export async function pruneAssets() {
  let names = [];
  try {
    names = await readdir(ASSETS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const entries = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = join(ASSETS_DIR, entry.name);
    try {
      const info = await stat(dir);
      entries.push({ dir, mtime: info.mtimeMs, size: 0 });
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  const now = Date.now();
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    let size = 0;
    try {
      const files = await readdir(item.dir);
      for (const name of files) {
        try {
          size += (await stat(join(item.dir, name))).size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    item.size = size;
    const tooMany = i >= ASSET_MAX_DIRS;
    const tooBig = total + size > ASSET_MAX_BYTES;
    const tooOld = now - item.mtime > ALIVE_MS && i > 0;
    if (tooMany || tooBig || tooOld) {
      await rm(item.dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    total += size;
  }
}

/**
 * 确保有可用的低清视频：命中缓存直接返回，否则用 yt-dlp 下到缓存目录。
 *
 * @returns {Promise<{docId, file, bytes, duration, downloadedAt, cached:boolean}>}
 */
export async function ensureVideoAsset({ doc, settings = {}, tools, onPhase, onProgress, signal, force = false } = {}) {
  const docId = String(doc?.docId ?? '');
  if (!docId) throw new VideoError('bad-param', '缺少 docId，无法缓存视频素材。');
  if (!tools?.ytdlp?.available) {
    throw new VideoError('ocr-needs-ytdlp', '画面识别需要用 yt-dlp 下载视频：请先 `brew install yt-dlp`。');
  }
  if (!force) {
    const hit = await readVideoAsset(docId);
    if (hit) {
      onPhase?.('复用已经下载好的低清视频…');
      return hit;
    }
  }
  const paths = assetPaths(docId);
  await mkdir(paths.dir, { recursive: true });
  onPhase?.('正在下载一份低清视频用来抽帧…');
  const downloaded = await downloadVideo({
    url: doc.url,
    platform: doc.platform,
    tools,
    workdir: paths.dir,
    cookie: settings.bilibiliCookie,
    onProgress,
    signal,
  });
  const meta = {
    docId,
    file: downloaded.file,
    bytes: downloaded.bytes,
    duration: normalizeDuration(doc?.duration),
    platform: doc?.platform ?? '',
    url: doc?.url ?? '',
    downloadedAt: Date.now(),
  };
  await writeJson(paths.meta, meta);
  await pruneAssets().catch(() => {});
  return { ...meta, cached: false };
}

/**
 * 确保有镜头切点：命中缓存直接返回，否则跑一遍 scanCuts 并写回。
 */
export async function ensureCutsAsset({
  doc,
  video,
  ffmpeg,
  tools,
  asr = {},
  duration = 0,
  threshold,
  onPhase,
  onProgress,
  signal,
  force = false,
} = {}) {
  const docId = String(doc?.docId ?? '');
  const file = video?.file ?? video;
  if (!docId || !file) throw new VideoError('bad-param', '缺少 docId / video，无法扫镜头切点。');
  const ffmpegPath = ffmpeg || tools?.ffmpeg?.path;
  const cutThreshold = Math.max(6, Math.min(40, Math.round(Number(threshold) || Number(asr.cutThreshold) || 27)));
  if (!force) {
    const hit = await readCutsAsset(docId, { duration, threshold: cutThreshold });
    if (hit) {
      onPhase?.(`复用上次扫到的 ${hit.cuts.length} 个镜头切点…`);
      return hit;
    }
  }
  const scanned = await scanCuts({
    ffmpeg: ffmpegPath,
    video: file,
    duration,
    threshold: cutThreshold,
    signal,
    onProgress,
  });
  const data = {
    cuts: scanned.cuts,
    scanned: scanned.scanned,
    fps: scanned.fps,
    duration: normalizeDuration(duration),
    threshold: cutThreshold,
  };
  await writeCutsAsset(docId, data).catch(() => {});
  return { ...data, cached: false };
}

/** 清掉某个视频的素材缓存（视频 + 切点）。 */
export async function clearAssets(docId) {
  if (!docId) return false;
  try {
    await rm(assetPaths(docId).dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
