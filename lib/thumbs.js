/**
 * 章节缩略图 / 关键画面截图。
 *
 * 面板里给章节列表配一张小图（也用于「关键画面」页签）：从已缓存的低清视频里
 * 按秒截一帧，存成 320px 宽的 JPEG，同一个时间点只截一次。
 *
 * 存储：`~/.dsh/video-assets/<docId>/thumbs/<秒>.jpg`，与视频/切点缓存同目录，
 * 因为两者生命周期一致（视频被 LRU 清掉时缩略图一起清掉）。
 */

import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { VideoError } from './util.js';
import { assetPaths, ensureVideoAsset } from './assets.js';
import { runProcess } from './media.js';

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 4;

function secondsOf(value, duration) {
  const seconds = Math.max(0, Number(value) || 0);
  const limit = Number(duration) > 0 ? Number(duration) - 0.3 : 24 * 3600;
  return Math.round(Math.min(seconds, Math.max(0, limit)) * 10) / 10;
}

export function thumbPath(docId, seconds) {
  const { dir } = assetPaths(docId);
  return join(dir, 'thumbs', `${String(Math.round(Number(seconds) * 10) / 10).replace('.', '_')}.jpg`);
}

/**
 * 取某个时间点的缩略图；返回 `{file, bytes, seconds, cached}`。
 * 第一次调用会复用/下载低清视频，之后同一时间点秒开。
 */
export async function getThumb({
  doc,
  settings = {},
  tools,
  seconds,
  width = THUMB_WIDTH,
  signal,
  force = false,
} = {}) {
  const docId = String(doc?.docId ?? '');
  if (!docId) throw new VideoError('bad-param', '缺少 docId，无法截图。');
  if (!tools?.ffmpeg?.available) {
    throw new VideoError('ocr-no-ffmpeg', '截取画面需要 ffmpeg：请先 `brew install ffmpeg`。');
  }
  const duration = Number(doc?.duration) || 0;
  const at = secondsOf(seconds, duration);
  const file = thumbPath(docId, at);
  if (!force) {
    try {
      const info = await stat(file);
      if (info.size > 0) return { file, bytes: info.size, seconds: at, cached: true };
    } catch {
      // 没有缓存，继续截
    }
  }

  const video = await ensureVideoAsset({ doc, settings, tools, signal });
  await mkdir(dirname(file), { recursive: true });
  const w = Math.max(120, Math.min(640, Math.round(Number(width) || THUMB_WIDTH)));
  await runProcess(
    tools.ffmpeg.path,
    ['-y', '-loglevel', 'error', '-ss', String(at), '-i', video.file, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', String(THUMB_QUALITY), file],
    { signal, code: 'thumb-failed', label: 'ffmpeg（章节缩略图）' },
  );
  const info = await stat(file);
  if (!info.size) throw new VideoError('thumb-failed', '截出来的缩略图是空的。');
  return { file, bytes: info.size, seconds: at, cached: false };
}

/** 读出缩略图字节（给 HTTP 路由用）。 */
export async function readThumb(file) {
  await access(file);
  return readFile(file);
}
