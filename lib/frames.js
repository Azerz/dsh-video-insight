/**
 * 画面兜底管线：没有语音/没有字幕时，从画面里拿内容。
 *
 *   下载低清视频 → 抽帧 →（本机 OCR 取画面文字）+（视觉模型描述画面）→ 带时间戳的假字幕
 *
 * 两种引擎的分工：
 *   - OCR（macOS Vision）：本机运行，只认文字，适合 PPT 录屏、弹幕、标题卡；
 *   - 画面理解（视觉模型）：把抽样的几张画面交给模型，描述场景/人物/动作，适合
 *     vlog、动画、纯画面视频；图片会离开本机。
 *
 * 默认 frameMode='auto'：先跑本机 OCR，画面文字够多就用 OCR 的结果；太少（例如
 * 纯动画）再加一轮画面理解。也可以显式选 'ocr' 或 'vision'。
 */
import { VideoError } from './util.js';
import { ocrStatus, captureFrames, recognizeFrames } from './ocr.js';
import { VISION_LABEL, describeFrames, visionSettings, visionStatus } from './vision.js';

/** auto 模式下，平均每帧少于这么多字就认为「画面文字不够，需要画面理解」。 */
const SPARSE_TEXT_PER_FRAME = 4;
/** 叠加两种来源时单段文字上限（RAG 与时间轴渲染都用得上）。 */
const MAX_SEGMENT_CHARS = 420;

function mergeTwo(list, sep) {
  return list.filter(Boolean).join(sep);
}

/** 从完整帧列表里均匀抽子集，最多 limit 张。 */
function subsample(frames, limit) {
  if (frames.length <= limit) return frames;
  const step = frames.length / limit;
  const out = [];
  for (let i = 0; i < limit; i += 1) out.push(frames[Math.floor(i * step)]);
  return out;
}

/** 把逐帧文字/描述拼成有序、不重叠的段落。 */
function buildSegments(frames, texts, intervalSeconds) {
  const span = Math.max(1, Math.round(Number(intervalSeconds) || 8));
  const segments = [];
  for (const frame of frames) {
    const parts = texts.get(frame.seconds);
    if (!parts) continue;
    const text = mergeTwo([parts.description, parts.screenText && `画面文字：${parts.screenText}`], ' / ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SEGMENT_CHARS);
    if (!text) continue;
    const last = segments[segments.length - 1];
    if (last && last.text === text) {
      last.end = frame.seconds + span;
      continue;
    }
    segments.push({ start: frame.seconds, end: frame.seconds + span, text });
  }
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].end > segments[i + 1].start) segments[i].end = segments[i + 1].start;
  }
  return segments.filter((item) => item.end > item.start);
}

/**
 * 画面兜底：返回与本地转写同构的 transcript（source 为 frame-ocr 或 frame-vision）。
 *
 * @param {object} options
 * @param {object} options.ai           宿主 ai 引用（llm / agentDefaultModel）
 * @param {object} options.attachments  宿主 attachments 服务（画面理解需要）
 */
export async function frameTranscript({
  doc,
  settings = {},
  workdir,
  tools,
  asr = {},
  ai = null,
  attachments = null,
  onPhase,
  onProgress,
  signal,
} = {}) {
  const visionCfg = visionSettings(settings);
  const ocrAvailable = asr.ocrFallback !== false && (await ocrStatus({ fresh: true, prepare: true })).available;
  let vision = null;
  if (visionCfg.frameMode !== 'ocr') {
    vision = await visionStatus(ai, settings, { fresh: true });
  }
  const visionUsable = Boolean(vision?.available && attachments?.saveImages && ai?.llm?.stream);
  if (!ocrAvailable && !visionUsable) {
    if (visionCfg.frameMode !== 'ocr' && vision && !vision.available && vision.reason) {
      throw new VideoError('vision-unavailable', `画面理解不可用：${vision.reason}`);
    }
    throw new VideoError('ocr-unavailable', '画面文字识别与画面理解都不可用，无法从画面里取内容。');
  }

  const started = Date.now();
  // 只跑画面理解时不必按 OCR 的密度抽帧；两种都跑时按 OCR 的密度抽，视觉模型只看均匀子集。
  const captureLimit = visionUsable && !ocrAvailable ? visionCfg.visionMaxFrames : 0;
  const { frames, intervalSeconds } = await captureFrames({
    doc,
    settings,
    workdir,
    tools,
    asr,
    onPhase,
    onProgress,
    signal,
    maxFrames: captureLimit,
  });

  const texts = new Map();
  const ensure = (seconds) => {
    if (!texts.has(seconds)) texts.set(seconds, { description: '', screenText: '' });
    return texts.get(seconds);
  };

  // 1) 本机 OCR：拿画面上的文字
  let ocrChars = 0;
  if (ocrAvailable) {
    const status = await ocrStatus({ fresh: false });
    onPhase?.(`正在识别 ${frames.length} 帧里的画面文字（本机 Vision）…`);
    try {
      const recognized = await recognizeFrames({ binary: status.binaryPath, frames, signal, onProgress });
      for (const frame of recognized) {
        const screenText = (frame.lines ?? []).join(' ').replace(/\s+/g, ' ').trim();
        if (!screenText) continue;
        ensure(frame.seconds).screenText = screenText.slice(0, 240);
        ocrChars += screenText.length;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // OCR 失败不致命：后面还有画面理解
      onPhase?.(`画面文字识别失败（${error?.message ?? error}），继续尝试画面理解…`);
    }
  }

  // 2) 画面理解：给抽样的几帧写描述
  let described = 0;
  const sparse = frames.length === 0 || ocrChars / Math.max(1, frames.length) < SPARSE_TEXT_PER_FRAME;
  const shouldDescribe = visionUsable && (visionCfg.frameMode === 'vision' || sparse);
  if (shouldDescribe) {
    const sampled = subsample(frames, visionCfg.visionMaxFrames);
    onPhase?.(
      `画面文字${ocrChars ? '不够多' : '没有识别到'}，改为让视觉模型看画面（${sampled.length} 帧，图片会发给当前模型）…`,
    );
    try {
      const describedFrames = await describeFrames({
        llm: ai.llm,
        route: {
          provider: vision.provider,
          model: vision.model,
          sessionId: 'dsh-video-panel',
        },
        attachments,
        frames: sampled,
        signal,
        onProgress,
      });
      for (const frame of describedFrames) {
        const bucket = ensure(frame.seconds);
        bucket.description = frame.description;
        described += 1;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!ocrChars) throw error;
      onPhase?.(`画面理解失败（${error?.message ?? error}），先使用识别到的画面文字。`);
    }
  }

  const segments = buildSegments(frames, texts, intervalSeconds);
  const chars = segments.reduce((sum, item) => sum + item.text.length, 0);
  if (!segments.length || chars < 8) {
    throw new VideoError(
      'asr-empty',
      '这个视频既没有语音，画面里也没有识别到可用的文字或可描述的内容（可能是纯音乐/纯色画面）。',
    );
  }

  const tookMs = Date.now() - started;
  const source = described > 0 ? 'frame-vision' : 'frame-ocr';
  const engine = visionUsable && described > 0 ? 'vision' : 'vision-ocr';
  const engineLabel = described > 0
    ? ocrChars
      ? `${VISION_LABEL} + 画面文字`
      : VISION_LABEL
    : '画面文字（macOS Vision）';
  onPhase?.(
    `画面理解完成：${segments.length} 段 / ${chars} 字${described ? `（${described} 帧由视觉模型描述）` : ''}，用时 ${(tookMs / 1000).toFixed(1)}s`,
  );
  onProgress?.({ percent: 100, stage: 'vision' });

  return {
    available: true,
    source,
    engine,
    engineLabel,
    lang: 'auto',
    chars,
    segments: segments.slice(0, 6000),
    tookMs,
    frames: frames.length,
    describedFrames: described,
  };
}
