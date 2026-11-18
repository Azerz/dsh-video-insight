/**
 * storyboard.js — 「分镜」页签的后端：把视频切成镜头、按预算取帧、拼成分镜图，
 * 附每个格子的秒数（客户端点格子即可 seek）。可选让视觉模型给每格补一句描述。
 *
 * 与「画面兜底」共用同一套抽帧（captureFrames：按镜头切点抽 + 480p 下载 + 预算），
 * 区别只是这里把结果当「产物」持久化，而不是只在没字幕时临时用一下。
 *
 * 帧数不再固定：由 lib/budget.js 按「时长 + 剪辑密度」计算（默认约每 20 秒一帧），
 * 一张拼图最多 24 格，超过就自动分成多张（最多 2 张 / 48 格），长视频不会只留 24 张代表帧。
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createWorkdir, cleanupWorkdir, detectToolchain } from './media.js';
import { captureFrames } from './ocr.js';
import { asrSettings } from './asr.js';
import { buildContactSheet, SHEET_MAX_CELLS } from './sheet.js';
import { describeSheet, resolveVisionRoute, visionStatus } from './vision.js';
import { VideoError } from './util.js';

export const STORYBOARD_DIR = join(homedir(), '.dsh', 'video-storyboards');
export const STORYBOARD_DEFAULT_FRAMES = 0; // 0 = 按预算自动
export const STORYBOARD_MAX_FRAMES = SHEET_MAX_CELLS;
export const STORYBOARD_MAX_CELLS = SHEET_MAX_CELLS * 2;

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
    legacyImage: join(STORYBOARD_DIR, `${base}.jpg`),
    image: (index = 0) => join(STORYBOARD_DIR, `${base}-${Number(index) + 1}.jpg`),
  };
}

function sanitizeCells(cells) {
  return (Array.isArray(cells) ? cells : [])
    .map((cell) => ({
      index: Number(cell?.index) || 0,
      sheet: Number(cell?.sheet) || 0,
      row: Number(cell?.row) || 0,
      col: Number(cell?.col) || 0,
      seconds: Math.max(0, Math.round(Number(cell?.seconds) * 100) / 100),
      ...(cell?.description ? { description: String(cell.description).slice(0, 200) } : {}),
    }))
    .filter((cell) => Number.isFinite(cell.seconds));
}

/** 读取已生成的分镜（没有/损坏返回 null）。旧版单图数据会自动包成一张 sheets。 */
export async function readStoryboard(docId) {
  if (!docId) return null;
  try {
    const paths = storyboardPaths(docId);
    const raw = await readFile(paths.meta, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.cells) || !data.cells.length) return null;
    const cells = sanitizeCells(data.cells);
    const legacy = !Array.isArray(data.sheets);
    const sheets = legacy
      ? [{
          index: 0,
          file: paths.legacyImage,
          cols: Number(data.cols) || 3,
          rows: Number(data.rows) || 1,
          cellWidth: Number(data.cellWidth) || 512,
          cellHeight: Number(data.cellHeight) || 288,
        }]
      : data.sheets.map((sheet, index) => ({
          index,
          file: paths.image(index),
          cols: Number(sheet?.cols) || 3,
          rows: Number(sheet?.rows) || 1,
          cellWidth: Number(sheet?.cellWidth) || 512,
          cellHeight: Number(sheet?.cellHeight) || 288,
        }));
    return { ...data, sheets, cells, imagePath: sheets[0]?.file ?? paths.legacyImage };
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

function chunk(list, size) {
  const width = Math.max(1, Math.round(Number(size) || 1));
  const out = [];
  for (let i = 0; i < list.length; i += width) out.push(list.slice(i, i + width));
  return out;
}

/**
 * 生成（或重新生成）一个视频的分镜图。
 *
 * @param {object} options
 * @param {object} options.doc 已解析的 VideoDoc（需要 url/duration）
 * @param {object} options.settings 插件设置
 * @param {object} options.aiCtx `{llm, attachments}`，仅在 describe=true 时用到
 * @param {number} [options.frames] 最多多少格（0 = 自动预算，默认自动；上限 24 格/张、2 张）
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
  frames = 0,
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
  const requested = Math.round(Number(frames) || 0);
  const ceiling = requested > 0
    ? Math.max(4, Math.min(STORYBOARD_MAX_CELLS, requested))
    : STORYBOARD_MAX_CELLS;
  const columns = Math.max(2, Math.min(6, Math.round(Number(cols) || 3)));
  let cuts = 0;
  const paths = storyboardPaths(doc.docId);
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
      maxFrames: ceiling,
    });
    cuts = Number(captured.cuts) || 0;
    const parts = chunk(captured.frames, SHEET_MAX_CELLS);
    onPhase?.(
      parts.length > 1
        ? `正在把 ${captured.frames.length} 帧拼成 ${parts.length} 张分镜图…（${captured.budget?.reason ?? ''}）`
        : `正在把 ${captured.frames.length} 帧拼成一张分镜图…（${captured.budget?.reason ?? ''}）`,
    );

    const cells = [];
    const sheets = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      // eslint-disable-next-line no-await-in-loop
      const sheet = await buildContactSheet({
        frames: part,
        workdir,
        ffmpeg: tools.ffmpeg.path,
        cols: columns,
        signal,
        outPath: join(workdir, `sheet-${index + 1}.jpg`),
      });
      const baseIndex = cells.length;
      for (const cell of sheet.layout) {
        const frame = part[cell.index] ?? part[0];
        cells.push({
          index: baseIndex + cell.index,
          sheet: index,
          row: cell.row,
          col: cell.col,
          seconds: Math.round(Number(frame?.seconds ?? cell.seconds ?? 0) * 100) / 100,
        });
      }
      sheets.push({ sheet, file: paths.image(index), part });
    }

    // 可选：视觉模型给每格补一句描述（把已经拼好的图再发一次，不再抽帧）
    if (describe) {
      const vision = await visionStatus(aiCtx, asr, { fresh: true });
      if (vision?.available) {
        const route = await resolveVisionRoute(aiCtx, asr);
        for (let index = 0; index < sheets.length; index += 1) {
          onPhase?.(
            sheets.length > 1
              ? `正在让视觉模型描述第 ${index + 1}/${sheets.length} 张分镜…`
              : '正在让视觉模型给每一格写一句描述…',
          );
          // eslint-disable-next-line no-await-in-loop
          const described = await describeSheet({
            llm: aiCtx.llm,
            route,
            attachments: aiCtx.attachments,
            sheet: sheets[index].sheet,
            signal,
            maxTokens: 2400,
          });
          const bySeconds = new Map((described ?? []).map((item) => [Math.round(Number(item.seconds) * 100) / 100, String(item.description ?? '')]));
          for (const cell of cells) {
            if (cell.sheet !== index) continue;
            const text = bySeconds.get(cell.seconds);
            if (text) cell.description = text.slice(0, 200);
          }
        }
      } else {
        onPhase?.('没有可用的视觉模型，分镜只保留画面和时间点。');
      }
    }

    await mkdir(paths.dir, { recursive: true });
    for (const entry of sheets) {
      // eslint-disable-next-line no-await-in-loop
      await copyFile(entry.sheet.file, entry.file);
    }
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
      sheets: sheets.map((entry) => ({
        cols: entry.sheet.cols,
        rows: entry.sheet.rows,
        cellWidth: entry.sheet.cellWidth,
        cellHeight: entry.sheet.cellHeight,
        cells: entry.part.length,
      })),
      budget: captured.budget ?? null,
      // 兼容旧客户端：第一张图的尺寸也放在顶层
      cols: sheets[0]?.sheet.cols ?? columns,
      rows: sheets[0]?.sheet.rows ?? 1,
      cellWidth: sheets[0]?.sheet.cellWidth ?? 512,
      cellHeight: sheets[0]?.sheet.cellHeight ?? 288,
      described: cells.some((cell) => cell.description),
      cells,
    };
    await writeStoryboard(doc.docId, data);
    return { ...data, imagePath: paths.image(0), cached: false };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

/** 某一张分镜图（供 HTTP 路由直接读）。index 从 0 开始；旧版单图数据回落 `<base>.jpg`。 */
export async function readStoryboardImage(docId, index = 0) {
  const paths = storyboardPaths(docId);
  const position = Number(index) || 0;
  try {
    return await readFile(paths.image(position));
  } catch {
    if (position === 0) {
      try {
        return await readFile(paths.legacyImage);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 删除某个视频的分镜缓存（含多张图）。 */
export async function clearStoryboard(docId) {
  const paths = storyboardPaths(docId);
  const files = [paths.meta, paths.legacyImage];
  for (let index = 0; index < 4; index += 1) files.push(paths.image(index));
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    await unlink(file).catch(() => {});
  }
  return true;
}
