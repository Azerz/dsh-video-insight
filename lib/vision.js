/**
 * 画面理解（视觉模型）。
 *
 * 和「画面文字识别（OCR）」互补：OCR 只把画面上的文字抠出来，本模块把抽出来的帧
 * 交给支持图片输入的模型，让它描述画面里发生了什么（场景、人物/物体、动作，
 * 以及画面上的文字），这样没有配音、画面文字又很少的视频也能有可用的文字稿。
 *
 * 注意：图片会作为消息内容发给当前配置的模型；OCR 仍然是纯本机的。面板里会把
 * 这条隐私差异写清楚。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { VideoError } from './util.js';

/** 画面理解的默认配置（具体值可在面板设置里改，保存在 asr 配置块里）。 */
export const VISION_DEFAULTS = {
  /** auto = 先 OCR，画面文字太少时再用视觉模型描述；ocr = 只用本机 OCR；vision = 直接用视觉模型描述。 */
  frameMode: 'auto',
  /** 留空则用当前会话的默认模型；也可以写成 `provider/model` 单独指定视觉模型。 */
  visionModel: '',
  /** 一次画面理解最多取多少帧（每帧就是一张图片，帧越多越慢、越贵）。 */
  visionMaxFrames: 48,
};

/** 面板/状态里展示的引擎名。 */
export const VISION_LABEL = '画面理解（视觉模型）';

/** 视觉模型一次看几张图（批量太少请求次数多，太多容易超出上下文）。 */
const VISION_BATCH_SIZE = 4;
/** 单张图片的描述最多这么多字。 */
const MAX_DESCRIPTION_CHARS = 160;
/** 整个画面理解 pass 的描述总字数上限，避免把字幕撑得比视频还长。 */
const MAX_TOTAL_DESCRIPTION_CHARS = 12_000;
/** 状态缓存：模型目录查询会走适配器，别每帧都查一次。 */
const STATUS_TTL_MS = 30_000;

let statusCache = { at: 0, key: '', value: null };

const DESCRIBE_PROMPT = [
  '下面是一个视频按时间顺序抽取的若干张画面。',
  '请逐张用中文描述画面内容：① 场景/环境；② 人物或物体，以及正在发生的事；③ 画面上若有重要文字（标题、字幕、图表、界面），抄写关键文字。',
  '不要猜测画面外的情节，看不清就写「看不清」。',
  '只输出 JSON 数组，不要任何解释或代码块，格式：',
  '[{"seconds":<对应秒数>,"description":"<不超过80字的描述>"}]',
].join('\n');

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 把 settings.asr 里的画面理解相关字段规范化。 */
export function visionSettings(settings) {
  const raw = settings?.asr ?? {};
  const mode = raw.frameMode === 'ocr' || raw.frameMode === 'vision' ? raw.frameMode : VISION_DEFAULTS.frameMode;
  return {
    frameMode: mode,
    visionModel: String(raw.visionModel ?? '').trim(),
    visionMaxFrames: clampInt(raw.visionMaxFrames, 8, 160, VISION_DEFAULTS.visionMaxFrames),
  };
}

/** `provider/model` 或 `provider:model` → { provider, model }。 */
function splitRoute(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^([^/:]+)[/:](.+)$/.exec(text);
  if (!match) return null;
  const provider = match[1].trim();
  const model = match[2].trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function agentRoute(ai) {
  const selection = ai?.agentDefaultModel?.currentSelection?.();
  const provider = String(selection?.provider ?? '').trim();
  const model = String(selection?.model ?? '').trim();
  return provider && model ? { provider, model } : null;
}

function supportsImage(info) {
  const modalities = info?.inputModalities;
  return Array.isArray(modalities) && modalities.includes('image');
}

/**
 * 解析「画面理解」要用的模型路由，并确认它声明了图片输入能力。
 * 返回 `{ available, provider, model, label, supportsImage, reason, candidates }`。
 */
async function resolveVisionRoute(ai, vision) {
  if (!ai?.llm?.stream) {
    return { available: false, reason: '当前 profile 没有挂载 LLM 服务，无法做画面理解。' };
  }
  const llm = ai.llm;
  const explicit = splitRoute(vision.visionModel);
  const route = explicit ?? agentRoute(ai);
  if (!route) {
    return { available: false, reason: '还没有可用的模型：请先在设置里选一个模型，或指定一个支持图片输入的模型。' };
  }

  let info = null;
  try {
    info = await llm.resolveModelInfo?.(route.provider, route.model);
  } catch {
    info = null;
  }
  const label = `${route.provider}/${route.model}`;
  if (supportsImage(info)) {
    return { available: true, ...route, label, supportsImage: true };
  }

  // 当前模型不吃图片：看看同一个 provider 的模型目录里有没有能看图的，给设置页提示。
  const candidates = [];
  try {
    const models = await llm.listModels?.(route.provider);
    for (const item of Array.isArray(models) ? models : []) {
      if (supportsImage(item)) candidates.push(`${route.provider}/${item.id}`);
    }
  } catch {
    /* 目录查询失败不影响下面的兜底提示 */
  }

  return {
    available: false,
    ...route,
    label,
    supportsImage: false,
    reason: candidates.length
      ? `当前模型 ${label} 没有声明图片输入能力；可以在设置里填一个支持图片的模型（例如 ${candidates[0]}）。`
      : `当前模型 ${label} 没有声明图片输入能力；请在设置里指定一个支持图片输入的视觉模型。`,
    candidates,
  };
}

/** 面板用的画面理解状态（30 秒缓存）。 */
export async function visionStatus(ai, settings, { fresh = false } = {}) {
  const vision = visionSettings(settings);
  const key = `${vision.frameMode}|${vision.visionModel}|${vision.visionMaxFrames}|${agentRoute(ai)?.provider ?? ''}/${agentRoute(ai)?.model ?? ''}`;
  const now = Date.now();
  if (!fresh && statusCache.value && now - statusCache.at < STATUS_TTL_MS && statusCache.key === key) {
    return statusCache.value;
  }
  const route = await resolveVisionRoute(ai, vision);
  const value = {
    label: VISION_LABEL,
    mode: vision.frameMode,
    enabled: vision.frameMode !== 'ocr',
    available: route.available,
    provider: route.provider ?? '',
    model: route.model ?? '',
    routeLabel: route.label ?? '',
    supportsImage: Boolean(route.supportsImage),
    reason: route.reason ?? '',
    candidates: route.candidates ?? [],
    config: {
      frameMode: vision.frameMode,
      visionModel: vision.visionModel,
      visionMaxFrames: vision.visionMaxFrames,
    },
    privacy: '画面理解会把抽出来的画面图片交给当前模型（会离开本机）；OCR 仍然完全在本机运行。',
  };
  statusCache = { at: now, key, value };
  return value;
}

/** 状态变化（改设置/换模型）后清缓存。 */
export function invalidateVisionStatus() {
  statusCache = { at: 0, key: '', value: null };
}

function parseJsonArray(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanDescription(value) {
  return String(value ?? '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * 把若干帧交给视觉模型描述。返回 `[{ file, seconds, description }]`。
 * 每批最多 4 张图，任何一批失败都只记录该批为空，不中断整个 pass。
 */
export async function describeFrames({
  llm,
  route,
  attachments,
  frames,
  signal,
  onProgress,
  batchSize = VISION_BATCH_SIZE,
  maxTokens = 1400,
} = {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (!list.length) return [];
  if (!llm?.stream) throw new VideoError('vision-unavailable', '当前没有可用的模型服务，无法做画面理解。');
  if (!route?.provider || !route?.model) throw new VideoError('vision-no-model', '没有可用的视觉模型。');
  if (!attachments?.saveImages) {
    throw new VideoError('vision-unavailable', '附件服务不可用，无法把画面交给模型。');
  }

  const size = Math.max(1, Math.min(6, Math.round(Number(batchSize) || VISION_BATCH_SIZE)));
  const results = [];
  let totalChars = 0;

  for (let offset = 0; offset < list.length; offset += size) {
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    const slice = list.slice(offset, offset + size);
    // eslint-disable-next-line no-await-in-loop
    const buffers = await Promise.all(slice.map((frame) => readFile(frame.file)));
    // eslint-disable-next-line no-await-in-loop
    const refs = await attachments.saveImages(
      buffers.map((data, index) => ({
        data: new Uint8Array(data),
        mediaType: 'image/jpeg',
        name: basename(slice[index].file),
      })),
    );

    const content = [{ type: 'text', text: `${DESCRIBE_PROMPT}\n\n这些画面分别对应：${slice.map((f) => `${f.seconds} 秒`).join('、')}。` }];
    for (const ref of refs) content.push({ type: 'image', attachment: ref });

    let text = '';
    let failure = null;
    // eslint-disable-next-line no-await-in-loop
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content }],
      maxTokens,
      signal,
      sessionId: route.sessionId || 'dsh-video-panel',
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
      if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        failure = chunk.reason.failure ?? { message: 'unknown' };
      }
    }
    if (failure) {
      if (failure.message?.includes('cancel')) throw new VideoError('aborted', '已取消。');
      throw new VideoError('vision-failed', `画面理解失败：${failure.message ?? '模型返回错误'}`);
    }

    const parsed = parseJsonArray(text);
    slice.forEach((frame, index) => {
      const item = Array.isArray(parsed) ? parsed.find((entry) => Number(entry?.seconds) === Number(frame.seconds)) ?? parsed[index] : null;
      const description = cleanDescription(item?.description);
      if (!description || totalChars + description.length > MAX_TOTAL_DESCRIPTION_CHARS) return;
      totalChars += description.length;
      results.push({ ...frame, description });
    });

    onProgress?.({
      percent: Math.round((Math.min(list.length, offset + slice.length) / list.length) * 100),
      stage: 'vision',
    });
  }

  return results;
}

export { agentRoute, splitRoute };
