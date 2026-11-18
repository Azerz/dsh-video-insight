/**
 * 抽帧预算：一帧多少秒、总共几帧、需要几张拼图。
 *
 * 参考 dsh-video-storyboard 的做法：按时长切窗口（5 分钟一段），窗口内按「每 20 秒一格」定格数，
 * 格数吸附到 4/6/9/12/16；窗口数有上限，超出就把窗口拉长而不是砍掉尾巴。
 * 这里把同样的思路压成一个纯函数，供三条画面管线共用：
 *   - 画面理解（frameTranscript / 视觉模型描述）
 *   - 分镜页签（storyboard 拼图）
 *   - 章节大纲配图（outline visuals，条数由大纲决定、不再二次抽帧）
 *
 * 与固定帧数相比的关键差别：
 *   1. 帧数随时长增长（1 帧 / 20 秒），长视频不再永远只有 24 帧；
 *   2. 剪辑密度参与计算：碎剪（≤8 秒一个镜头）提到 1 帧 / 12 秒，口播长镜头降到 1 帧 / 30 秒；
 *   3. 拼图一张最多 24 格，超出的部分自动分成多张，而不是直接丢弃。
 */

/** 一张拼图最多几格（与 lib/sheet.js 的 SHEET_MAX_CELLS 保持一致）。 */
export const CELLS_PER_SHEET = 24;

export const BUDGET_DEFAULTS = Object.freeze({
  secondsPerFrame: 20,
  denseSecondsPerFrame: 12,
  sparseSecondsPerFrame: 30,
  minFrames: 6,
  maxFrames: 96,
  denseShotSeconds: 8,
  sparseShotSeconds: 45,
});

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * @param {{duration?: number, cuts?: number, ceiling?: number, mode?: 'vision'|'storyboard'}} [options]
 * @returns {{frames:number, secondsPerFrame:number, sheets:number, cellsPerSheet:number, density:string, duration:number, ceiling:number, reason:string}}
 */
export function planFrameBudget({ duration = 0, cuts = 0, ceiling = 0, mode = 'vision' } = {}) {
  const dur = Math.max(0, Number(duration) || 0);
  const shots = Math.max(0, Number(cuts) || 0);
  const cap = Math.round(clamp(Number(ceiling) || BUDGET_DEFAULTS.maxFrames, BUDGET_DEFAULTS.minFrames, 240));
  const cellsPerSheet = CELLS_PER_SHEET;

  let secondsPerFrame = BUDGET_DEFAULTS.secondsPerFrame;
  let density = 'normal';
  if (dur > 0 && shots > 0) {
    const shotPerSecond = shots / dur;
    if (shotPerSecond < 1 / BUDGET_DEFAULTS.sparseShotSeconds) {
      secondsPerFrame = BUDGET_DEFAULTS.sparseSecondsPerFrame;
      density = 'sparse';
    } else if (shotPerSecond > 1 / BUDGET_DEFAULTS.denseShotSeconds) {
      secondsPerFrame = BUDGET_DEFAULTS.denseSecondsPerFrame;
      density = 'dense';
    }
  }

  const byDuration = dur > 0 ? Math.ceil(dur / secondsPerFrame) : 0;
  // 镜头本身也是信息载体：镜头比时长预算还多时，至少接近「一镜一帧」的一半。
  const byShots = shots > 0 ? Math.ceil(shots * 0.5) : 0;
  const wanted = Math.max(byDuration, byShots, BUDGET_DEFAULTS.minFrames);
  const frames = clamp(wanted, BUDGET_DEFAULTS.minFrames, cap);
  const sheets = Math.max(1, Math.ceil(frames / cellsPerSheet));

  const reason = [
    `${Math.round(dur)}s`,
    shots > 0 ? `${shots} 个镜头` : '未扫切点',
    `每 ${secondsPerFrame}s 一帧`,
    density === 'dense' ? '剪辑密集' : density === 'sparse' ? '长镜头/口播' : '常规节奏',
    `${frames} 帧 / ${sheets} 张图`,
  ].join(' · ');

  return {
    frames,
    secondsPerFrame,
    sheets,
    cellsPerSheet,
    density,
    duration: Math.round(dur),
    ceiling: cap,
    reason,
  };
}

export default planFrameBudget;
