/**
 * sheet.js — 分镜拼图（contact sheet）。
 *
 * 画面理解现在是把抽到的帧一张一张发给模型；一帧一个 image block，十几帧就是十几张图。
 * 这里把多帧按网格拼成**一张**图，并在提示里给出「第几格 = 第几秒」的对应表，
 * 让模型看一张图就能描述整段画面 —— 图数量、时延和 token 一起降下来。
 *
 * 拼版本身交给 ffmpeg（`tile` 滤镜），不依赖任何图像库，也不画字：
 * 时间标签通过**提示词里的对应表**告诉模型，面板上再由前端把格子角标画出来。
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { runProcess } from './media.js';
import { VideoError } from './util.js';

export const SHEET_COLS = 3;
export const SHEET_ROWS = 4;
export const SHEET_CELL_WIDTH = 512;
export const SHEET_CELL_HEIGHT = 288;
/** 一张拼图最多容纳的格子数（6x4） */
export const SHEET_MAX_CELLS = 24;

/**
 * 根据帧数算出网格。列数可配置，行数向上取整；
 * 格子数上限 24，超出部分不拼（调用方应先抽样）。
 */
export function sheetGrid(count, cols = SHEET_COLS) {
  const total = Math.max(1, Math.min(SHEET_MAX_CELLS, Math.round(Number(count) || 1)));
  const columns = Math.max(1, Math.min(6, Math.round(Number(cols) || SHEET_COLS)));
  return { count: total, cols: columns, rows: Math.ceil(total / columns) };
}

/**
 * 把若干帧拼成一张分镜图。
 *
 * @param {object} options
 * @param {Array<{file: string, seconds: number}>} options.frames 已抽好的帧（秒数升序更自然）
 * @param {string} options.workdir 临时工作目录
 * @param {string} [options.ffmpeg] ffmpeg 路径
 * @param {number} [options.cols] 列数
 * @param {number} [options.cellWidth] 单格宽（像素）
 * @param {number} [options.cellHeight] 单格高（像素）
 * @param {string} [options.outPath] 输出文件路径
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{file: string, cols: number, rows: number, cellWidth: number, cellHeight: number, layout: Array<{index: number, row: number, col: number, seconds: number, duplicate?: boolean}>}>}
 */
export async function buildContactSheet({
  frames,
  workdir,
  ffmpeg = 'ffmpeg',
  cols = SHEET_COLS,
  cellWidth = SHEET_CELL_WIDTH,
  cellHeight = SHEET_CELL_HEIGHT,
  outPath,
  signal,
} = {}) {
  const list = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && typeof frame.file === 'string' && frame.file)
    .sort((a, b) => Number(a.seconds) - Number(b.seconds));

  if (!list.length) throw new VideoError('sheet-empty', '没有可拼版的画面。');
  if (!workdir) throw new VideoError('sheet-failed', '缺少临时目录，无法拼版。');

  const grid = sheetGrid(list.length, cols);
  const cells = list.slice(0, grid.count);
  const slots = grid.cols * grid.rows;

  const tilesDir = join(workdir, 'sheet-cells');
  await mkdir(tilesDir, { recursive: true });

  const layout = [];
  const sequence = [];
  for (let index = 0; index < slots; index += 1) {
    const cell = cells[Math.min(index, cells.length - 1)];
    const duplicate = index >= cells.length;
    const target = join(tilesDir, `cell-${String(index + 1).padStart(4, '0')}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await copyFile(cell.file, target);
    sequence.push(target);
    if (!duplicate) {
      layout.push({
        index,
        row: Math.floor(index / grid.cols),
        col: index % grid.cols,
        seconds: Number(cell.seconds) || 0,
      });
    }
  }

  const file = outPath || join(workdir, 'sheet.jpg');
  const filter = [
    `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease`,
    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `tile=${grid.cols}x${grid.rows}`,
  ].join(',');

  await runProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-framerate', '1',
      '-i', join(tilesDir, 'cell-%04d.jpg'),
      '-vf', filter,
      '-frames:v', '1',
      '-q:v', '4',
      file,
    ],
    {
      signal,
      code: 'sheet-failed',
      label: 'ffmpeg（分镜拼图）',
      timeoutMs: 120000,
    },
  );

  return {
    file,
    cols: grid.cols,
    rows: grid.rows,
    cellWidth,
    cellHeight,
    layout,
  };
}

/** 把格子布局压成给模型看的「对应表」文字，例如「第1格 0 秒、第2格 8 秒…」。 */
export function sheetCellTable(layout) {
  return (Array.isArray(layout) ? layout : [])
    .map((cell, index) => `第${index + 1}格 ${cell.seconds} 秒`)
    .join('、');
}
