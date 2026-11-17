/**
 * storyboard.js — 「分镜」页签的后端：把视频切成镜头、每镜头取一张，拼成分镜图，
 * 附每个格子的秒数（客户端点格子即可 seek）。可选让视觉模型给每格补一句描述。
 *
 * 与「画面兜底」共用同一套抽帧（captureFrames：按镜头切点抽 + 480p 下载），
 * 区别只是这里把结果当「产物」持久化，而不是只在没字幕时临时用一下。
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createWorkdir, cleanupWorkdir, detectToolchain } from './media.js';
import { captureFrames } from './ocr.js';
import { asrSettings } from './asr.js';
import { buildContactSheet } from './sheet.js';
import { describeSheet, resolveVisionRoute, visionStatus } from './vision.js';
import { VideoError } from './util.js';

export const STORYBOARD_DIR = join(homedir(), '.dsh', 'video-storyboards');
export const STORYBOARD_DEFAULT_FRAMES = 24;
export const STORYBOARD_MAX_FRAMES = 24;

function safeId(docId) {
  return String(docId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 160) || 'video';
}

export function storyboardPaths(docId) {
  const base = safeId(docId);
  return {
    dir: STORYBOARD_DIR,
    meta: join(STORYBOARD_DIR, `${base}.json`),
    image: join(STORYBOARD_DIR, `${base}.jpg`),
  };
}

function sanitizeCells(cells) {
  return (Array.isArray(cells) ? cells : [])
    .map((cell) => ({
      index: Number(cell?.index) || 0,
      row: Number(cell?.row) || 0,
      col: Number(cell?.col) || 0,
      seconds: Math.max(0, Math.round(Number(cell?.seconds) * 100) / 100),
      ...(cell?.description ? { description: String(cell.description).slice(0, 200) } : {}),
    }))
    .filter((cell) => Number.isFinite(cell.seconds));
}

/** 读取已生成的分镜（没有/损坏返回 null）。 */
export async function readStoryboard(docId) {
  if (!docId) return null;
  try {
    const raw = await readFile(storyboardPaths(docId).meta, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.cells) || !data.cells.length) return null;
    return {
      ...data,
      cells: sanitizeCells(data.cells),
      imagePath: storyboardPaths(docId).image,
    };
  } catch {
    return null;
  }
}

async function writeStoryboard(docId, data) {
  const paths = storyboardPaths(docId);
  await mkdir(paths.dir, { recursive: true });
  const tmp = `${paths.meta}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, paths.meta);
}

/**
 * 生成（或重新生成）一个视频的分镜图。
 *
 * @param {object} options
 * @param {object} options.doc 已解析的 VideoDoc（需要 url/duration）
 * @param {object} options.settings 插件设置
 * @param {object} options.aiCtx `{llm, attachments}`，仅在 describe=true 时用到
 * @param {number} [options.frames] 最多多少格（4–24，默认 24）
 * @param {number} [options.cols] 列数（2–6，默认 3）
 * @param {boolean} [options.describe] 是否让视觉模型给每格补一句描述
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} [options.onPhase]
 * @param {(info: {percent?: number, stage?: string}) => void} [options.onProgress]
 */
export async function generateStoryboard({
  doc,
  settings = {},
  aiCtx = null,
  frames = STORYBOARD_DEFAULT_FRAMES,
  cols = 3,
  describe = false,
  signal,
  onPhase,
  onProgress,
} = {}) {
  if (!doc?.url) throw new VideoError('bad-url', '缺少视频链接。');
  const asr = asrSettings(settings);
  const tools = await detectToolchain(asr, { fresh: false });
  const workdir = await createWorkdir();
  const started = Date.now();
  const wanted = Math.max(4, Math.min(STORYBOARD_MAX_FRAMES, Math.round(Number(frames) || STORYBOARD_DEFAULT_FRAMES)));
  const columns = Math.max(2, Math.min(6, Math.round(Number(cols) || 3)));
  let cuts = 0;
  let sheet = null;
  try {
    const captured = await captureFrames({
      doc,
      settings,
      workdir,
      tools,
      asr,
      onPhase,
      onProgress,
      signal,
      maxFrames: wanted,
    });
    cuts = Number(captured.cuts) || 0;
    onPhase?.(`正在把 ${captured.frames.length} 帧拼成一张分镜图…`);
    sheet = await buildContactSheet({
      frames: captured.frames,
      workdir,
      ffmpeg: tools.ffmpeg.path,
      cols: columns,
      signal,
    });

    const cells = sheet.layout.map((cell) => {
      const frame = captured.frames[cell.index] ?? captured.frames[0];
      return {
        index: cell.index,
        row: cell.row,
        col: cell.col,
        seconds: Math.round(Number(frame?.seconds ?? cell.seconds ?? 0) * 100) / 100,
      };
    });

    // 可选：视觉模型给每格补一句描述（把已经拼好的图再发一次，不再抽帧）
    if (describe) {
      const vision = await visionStatus(aiCtx, asr, { fresh: true });
      if (vision?.available) {
        const route = await resolveVisionRoute(aiCtx, asr);
        onPhase?.('正在让视觉模型给每一格写一句描述…');
        const described = await describeSheet({
          llm: aiCtx.llm,
          route,
          attachments: aiCtx.attachments,
          sheet,
          signal,
          maxTokens: 2400,
        });
        const bySeconds = new Map((described ?? []).map((item) => [Math.round(Number(item.seconds) * 100) / 100, String(item.description ?? '')]));
        for (const cell of cells) {
          const text = bySeconds.get(cell.seconds);
          if (text) cell.description = text.slice(0, 200);
        }
      } else {
        onPhase?.('没有可用的视觉模型，分镜只保留画面和时间点。');
      }
    }

    const paths = storyboardPaths(doc.docId);
    await mkdir(paths.dir, { recursive: true });
    await copyFile(sheet.file, paths.image);
    const data = {
      docId: doc.docId,
      url: doc.url,
      title: doc.title ?? '',
      platform: doc.platform ?? '',
      duration: Number(doc.duration) || 0,
      generatedAt: Date.now(),
      tookMs: Date.now() - started,
      frameSampling: String(asr.frameSampling ?? 'cuts'),
      cuts,
      frames: cells.length,
      cols: sheet.cols,
      rows: sheet.rows,
      cellWidth: sheet.cellWidth,
      cellHeight: sheet.cellHeight,
      described: cells.some((cell) => cell.description),
      cells,
    };
    await writeStoryboard(doc.docId, data);
    return { ...data, imagePath: paths.image, cached: false };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

/** 分镜图文件（供 HTTP 路由直接读）。 */
export async function readStoryboardImage(docId) {
  const paths = storyboardPaths(docId);
  try {
    return await readFile(paths.image);
  } catch {
    return null;
  }
}

/** 删除某个视频的分镜缓存。 */
export async function clearStoryboard(docId) {
  const paths = storyboardPaths(docId);
  for (const file of [paths.meta, paths.image]) {
    // eslint-disable-next-line no-await-in-loop
    await unlink(file).catch(() => {});
  }
  return true;
}
