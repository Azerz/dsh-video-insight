/**
 * cuts.js — 按镜头切点抽帧（替换「每 N 秒一张」的均匀抽样）。
 *
 * 均匀抽样的两个毛病：翻页/转场刚好落在两个采样点之间就看不到；静态画面又多采了一堆
 * 几乎一样的帧。这里先从视频里找出镜头切点，再「一个镜头取一张」，剩下的按需补采样。
 *
 * 切点检测思路（参考 PySceneDetect ContentDetector 与 storyboard 的 scan.js，
 * 自己写的最小实现）：ffmpeg 把画面缩到 64×36、按固定 fps 输出 rawvideo，
 * 逐帧算 RGB 三通道绝对差均值当分数；暗场按画面亮度放大分数（夜戏里同样的剪辑
 * 分数会小很多）。真转场是一帧的尖峰，运动/镜头摇移则是连续几帧都偏高，
 * 所以再用「尖峰 / 邻域中位数」的比值把运动滤掉。不用 `ffmpeg scdet`：
 * 它只算亮度 MAFD，同亮度换色会失明。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { runProcess } from './media.js';
import { VideoError } from './util.js';

export const SCAN_WIDTH = 64;
export const SCAN_HEIGHT = 36;
export const SCAN_FRAME_BYTES = SCAN_WIDTH * SCAN_HEIGHT * 3;
/** 扫描帧率：4fps 足够定位切点（误差 ≤250ms），再高只是浪费解码。 */
export const SCAN_FPS = 4;
/** 默认切点阈值（0–255 分数）。 */
export const DEFAULT_CUT_THRESHOLD = 27;
/** 一刀的绝对下限：低于它的一律当压缩噪声。 */
export const MIN_CUT_SCORE = 15;
/** 尖峰强度：必须比邻域中位数高这么多倍，否则算运动。 */
export const SPIKE_RATIO = 2.2;
/** 两个切点至少隔这么久，避免快剪素材产生碎刀。 */
export const MIN_CUT_GAP = 0.5;
/** 统计尖峰的邻域（秒）。 */
const SPIKE_WINDOW_SECONDS = 1;
/** 暗场增益：按亮度把分数放大回去，正常亮度≈1。 */
const REF_LUMA = 160;
const LUMA_FLOOR = 40;
const GAIN_MAX = 3;
/** 最多保留多少个切点（一小时的快剪也够用）。 */
const MAX_CUTS = 400;

function lumaOf(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i];
    const g = frame[i + 1];
    const b = frame[i + 2];
    sum += r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  return sum / (frame.length / 3);
}

function diffScore(prev, cur) {
  let sum = 0;
  for (let i = 0; i < prev.length; i += 1) sum += Math.abs(prev[i] - cur[i]);
  return sum / prev.length;
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}

/** 把逐帧分数（含时间）变成切点：只认「一帧的尖峰」，连续高分的运动不算。 */
function pickCuts(scores, { fps, duration, threshold }) {
  const cuts = [];
  const cutScores = [];
  const windowFrames = Math.max(2, Math.round(SPIKE_WINDOW_SECONDS * fps));
  const floor = Math.max(MIN_CUT_SCORE, threshold);
  let lastCut = 0;
  for (let index = 2; index < scores.length - 1; index += 1) {
    const score = scores[index];
    if (score < floor) continue;
    if (score < scores[index - 1] || score < scores[index + 1]) continue;
    const seconds = index / fps;
    if (seconds - lastCut < MIN_CUT_GAP) continue;
    if (seconds <= 0.2) continue;
    if (duration > 0 && seconds >= duration - 0.2) continue;
    const neighbourhood = [];
    const from = Math.max(0, index - windowFrames);
    const to = Math.min(scores.length, index + windowFrames + 1);
    for (let j = from; j < to; j += 1) {
      if (Math.abs(j - index) > 1) neighbourhood.push(scores[j]);
    }
    const base = Math.max(medianOf(neighbourhood), 3);
    if (score / base < SPIKE_RATIO) continue;
    cuts.push(Math.round(seconds * 100) / 100);
    cutScores.push(Math.round(score * 10) / 10);
    lastCut = seconds;
    if (cuts.length >= MAX_CUTS) break;
  }
  return { cuts, cutScores };
}

/**
 * 扫描整段视频，返回镜头切点（秒，升序，不含 0）。
 *
 * @param {object} options
 * @param {string} options.video 本地视频路径
 * @param {string} [options.ffmpeg] ffmpeg 路径
 * @param {number} [options.duration] 时长（秒），用于进度与上限
 * @param {number} [options.fps] 扫描帧率
 * @param {number} [options.threshold] 切点阈值
 * @param {AbortSignal} [options.signal]
 * @param {(info: {percent: number}) => void} [options.onProgress]
 * @returns {Promise<{cuts: number[], cutScores: number[], scanned: number, fps: number}>}
 */
export function scanCuts({
  video,
  ffmpeg = 'ffmpeg',
  duration = 0,
  fps = SCAN_FPS,
  threshold = DEFAULT_CUT_THRESHOLD,
  signal,
  onProgress,
} = {}) {
  if (!video) return Promise.reject(new VideoError('cut-scan-failed', '没有可扫描的视频文件。'));
  const scanFps = Math.max(1, Math.min(12, Math.round(Number(fps) || SCAN_FPS)));

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', video,
      '-vf', `fps=${scanFps},scale=${SCAN_WIDTH}:${SCAN_HEIGHT}:flags=area,format=rgb24`,
      '-f', 'rawvideo',
      '-',
    ];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = Buffer.alloc(0);
    let previous = null;
    let previousLuma = 0;
    let frameIndex = 0;
    let stderr = '';
    let settled = false;
    const scores = new Float64Array(Math.max(1, duration > 0 ? Math.ceil(duration * scanFps) + 8 : 8));
    let length = 0;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= SCAN_FRAME_BYTES) {
        const frame = buffer.subarray(0, SCAN_FRAME_BYTES);
        buffer = buffer.subarray(SCAN_FRAME_BYTES);
        const luma = lumaOf(frame);
        if (previous) {
          const raw = diffScore(previous, frame);
          const gain = Math.min(
            GAIN_MAX,
            Math.max(1, REF_LUMA / Math.max(Math.max(previousLuma, luma), LUMA_FLOOR)),
          );
          if (length < scores.length) {
            scores[length] = raw * gain;
            length += 1;
          }
          if (onProgress && length % scanFps === 0) {
            const expected = duration > 0 ? Math.ceil(duration * scanFps) : 0;
            if (expected > 0) onProgress({ percent: Math.min(99, Math.round((frameIndex / expected) * 100)) });
          }
        }
        previous = Buffer.from(frame);
        previousLuma = luma;
        frameIndex += 1;
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    const abort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new VideoError('aborted', '已取消。'));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    child.on('error', (error) => {
      finish(new VideoError('cut-scan-failed', `镜头切分失败：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener?.('abort', abort);
      if (settled) return;
      if (!length && code !== 0) {
        finish(new VideoError('cut-scan-failed', `镜头切分失败（ffmpeg 退出码 ${code}）：${stderr.split('\n').slice(-3).join(' ')}`));
        return;
      }
      const slice = scores.subarray(0, length);
      const { cuts, cutScores } = pickCuts(slice, { fps: scanFps, duration, threshold });
      finish(null, { cuts, cutScores, scanned: length + 1, fps: scanFps });
    });
  });
}

/** 均匀取 limit 个点（取每个等分格的中心）。 */
function uniformTimes(total, limit) {
  const out = [];
  if (!(total > 0) || limit <= 0) return out;
  const step = total / limit;
  for (let i = 0; i < limit; i += 1) out.push(Math.round((i * step + step / 2) * 100) / 100);
  return out;
}

function dedupe(picks, minGap) {
  const out = [];
  for (const pick of picks) {
    const last = out[out.length - 1];
    if (last && pick.seconds - last.seconds < minGap) continue;
    out.push(pick);
  }
  return out;
}

/**
 * 由切点排出取帧时间点：镜头比配额多 → 按时间轴均匀挑镜头；镜头太少（静态 PPT/口播）
 * → 均匀铺满时间轴。
 *
 * @param {object} options
 * @param {number} options.duration 视频时长（秒）
 * @param {number[]} [options.cuts] 切点（秒）
 * @param {number} [options.maxFrames] 最多取多少帧
 * @param {number} [options.minGap] 两帧最小间隔（秒），默认 1
 * @returns {Array<{seconds: number, fromCut: boolean}>}
 */
export function planFrameTimes({ duration = 0, cuts = [], maxFrames = 24, minGap = 1 } = {}) {
  const limit = Math.max(1, Math.round(Number(maxFrames) || 24));
  const total = Number(duration) > 0 ? Number(duration) : 0;
  const marks = [0];
  for (const cut of Array.isArray(cuts) ? cuts : []) {
    const value = Number(cut);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (total > 0 && value >= total - 0.2) continue;
    if (value - marks[marks.length - 1] < 0.15) continue;
    marks.push(value);
  }
  if (total > 0) marks.push(total);

  const shots = [];
  for (let i = 0; i < marks.length - 1; i += 1) {
    const start = marks[i];
    const end = marks[i + 1];
    if (end - start >= 0.15) shots.push({ start, end });
  }

  if (shots.length < 6) {
    // 几乎没有剪辑（静态素材/口播/纯音乐）：均匀铺满整个时间轴
    return uniformTimes(total, limit).map((seconds) => ({ seconds, fromCut: false }));
  }

  const midpoints = shots.map((shot) => {
    const span = shot.end - shot.start;
    const seconds = shot.start + Math.min(span / 2, Math.max(0.2, span - 0.15));
    return { seconds: Math.round(seconds * 100) / 100, fromCut: true };
  });

  if (midpoints.length <= limit) {
    // 镜头不算多：一个镜头一张，再按需均匀补几张（补的帧与已选帧至少隔 minGap*2）
    const picks = [...midpoints];
    if (picks.length < limit && total > 0) {
      const spacing = minGap * 2;
      for (const seconds of uniformTimes(total, limit)) {
        if (picks.length >= limit) break;
        if (picks.some((pick) => Math.abs(pick.seconds - seconds) < spacing)) continue;
        picks.push({ seconds, fromCut: false });
      }
      picks.sort((a, b) => a.seconds - b.seconds);
    }
    return dedupe(picks, minGap).slice(0, limit);
  }

  // 镜头比配额多：把时间轴等分成 limit 段，每段挑一个覆盖最长的镜头、取镜头中点
  // （中点落出本段时夹回段内），既保证时间覆盖，又保证每张都落在某个镜头里。
  const picks = [];
  for (let i = 0; i < limit; i += 1) {
    const bucketStart = (i * total) / limit;
    const bucketEnd = ((i + 1) * total) / limit;
    let best = null;
    let bestOverlap = 0;
    for (const shot of shots) {
      const overlap = Math.min(shot.end, bucketEnd) - Math.max(shot.start, bucketStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = shot;
      }
    }
    const inside = best
      ? Math.min(
          Math.max(best.start + (best.end - best.start) / 2, Math.max(best.start + 0.2, bucketStart + 0.1)),
          Math.min(best.end - 0.1, bucketEnd - 0.1),
        )
      : (bucketStart + bucketEnd) / 2;
    picks.push({ seconds: Math.round(inside * 100) / 100, fromCut: Boolean(best) });
  }
  return dedupe(picks, minGap);
}

/**
 * 在指定时间点各取一帧（`-ss` 快速定位，一张图一个进程）。
 */
export async function extractFramesAt({
  ffmpeg = 'ffmpeg',
  video,
  workdir,
  times = [],
  maxWidth = 1280,
  signal,
  onProgress,
} = {}) {
  const frames = [];
  const list = Array.isArray(times) ? times : [];
  for (let index = 0; index < list.length; index += 1) {
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    const seconds = Number(list[index]);
    const file = join(workdir, `shot-${String(index + 1).padStart(4, '0')}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await runProcess(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(Math.max(0, seconds)),
        '-i', video,
        '-frames:v', '1',
        '-vf', `scale='min(${Math.round(maxWidth)},iw)':-2`,
        '-q:v', '3',
        file,
      ],
      {
        signal,
        code: 'ocr-frames-failed',
        label: 'ffmpeg（按镜头抽帧）',
        timeoutMs: 60000,
      },
    );
    frames.push({ file, seconds: Math.round(seconds * 100) / 100 });
    onProgress?.({ percent: Math.round(((index + 1) / list.length) * 100), stage: 'frames' });
  }
  return frames;
}
