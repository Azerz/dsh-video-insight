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
  /** 喂给模型的方式：sheet = 把多帧拼成一张分镜图（默认，省图省时）；frames = 还是逐帧发。 */
  visionPack: 'sheet',
  /** 分镜拼图的列数（行数按帧数自动算）。 */
  sheetCols: 3,
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

import { langInstruction, normalizeLang } from './lang.js';

const DESCRIBE_PROMPT_ZH = [
  '下面是一个视频按时间顺序抽取的若干张画面。',
  '请逐张用中文描述画面内容：① 场景/环境；② 人物或物体，以及正在发生的事；③ 画面上若有重要文字（标题、字幕、图表、界面），抄写关键文字。',
  '不要猜测画面外的情节，看不清就写「看不清」。',
  '只输出 JSON 数组，不要任何解释或代码块，格式：',
  '[{"seconds":<对应秒数>,"description":"<不超过80字的描述>"}]',
].join('\n');

const DESCRIBE_PROMPT_EN = [
  'Below are frames extracted from a video in chronological order.',
  'Describe each frame in English: (1) scene/environment; (2) people or objects and what is happening; (3) any important on-screen text (titles, subtitles, charts, UI) — transcribe the key words.',
  'Do not guess beyond the frame; write "unclear" when you cannot tell.',
  'Output only a JSON array, no explanation or code blocks:',
  '[{"seconds":<second of this frame>,"description":"<max 60 words>"}]',
].join('\n');

/** 按语言取逐帧描述提示。 */
function describePrompt(lang) {
  const id = normalizeLang(lang);
  if (id === 'zh') return DESCRIBE_PROMPT_ZH;
  return id === 'en' ? DESCRIBE_PROMPT_EN : `${DESCRIBE_PROMPT_EN}\n\n${langInstruction(id)}`;
}

/** 分镜拼图的提示词：图片是一张网格，每格对应一个时间点（对应表在调用处拼进去）。 */
const SHEET_PROMPT_ZH = [
  '下面是一张视频画面的分镜拼图：整张图被切成等大的格子，按从左到右、从上到下的顺序排列，每一格对应视频里的一个时间点（见下面的对应表）。',
  '请逐格用中文描述画面内容：① 场景/环境；② 人物或物体，以及正在发生的事；③ 画面上若有重要文字（标题、字幕、图表、界面），抄写关键文字。',
  '不要猜测画面外的情节，看不清就写「看不清」；纯黑场/转场就写「黑场或转场」。',
  '只输出 JSON 数组，不要任何解释或代码块，格式：',
  '[{"seconds":<该格对应秒数>,"description":"<不超过80字的描述>"}]',
].join('\n');

const SHEET_PROMPT_EN = [
  'Below is a contact sheet of video frames: the image is a grid of equal cells, ordered left-to-right, top-to-bottom; each cell is one moment of the video (table below maps cells to seconds).',
  'Describe each cell in English: (1) scene/environment; (2) people or objects and what is happening; (3) any important on-screen text — transcribe the key words.',
  'Do not guess outside the frame; write "unclear" if unreadable, "black or transition" for blank frames.',
  'Output only a JSON array, no explanation or code blocks:',
  '[{"seconds":<second of this cell>,"description":"<max 60 words>"}]',
].join('\n');

/** 按语言取拼图描述提示。 */
function sheetPrompt(lang) {
  const id = normalizeLang(lang);
  if (id === 'zh') return SHEET_PROMPT_ZH;
  return id === 'en' ? SHEET_PROMPT_EN : `${SHEET_PROMPT_EN}\n\n${langInstruction(id)}`;
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 把 settings.asr 里的画面理解相关字段规范化。 */
export function visionSettings(settings) {
  const raw = settings?.asr ?? {};
  const mode = raw.frameMode === 'ocr' || raw.frameMode === 'vision' ? raw.frameMode : VISION_DEFAULTS.frameMode;
  const pack = raw.visionPack === 'frames' ? 'frames' : VISION_DEFAULTS.visionPack;
  return {
    frameMode: mode,
    visionModel: String(raw.visionModel ?? '').trim(),
    visionMaxFrames: clampInt(raw.visionMaxFrames, 8, 160, VISION_DEFAULTS.visionMaxFrames),
    visionPack: pack,
    sheetCols: clampInt(raw.sheetCols, 2, 6, VISION_DEFAULTS.sheetCols),
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
  const key = `${vision.frameMode}|${vision.visionModel}|${vision.visionMaxFrames}|${vision.visionPack}|${vision.sheetCols}|${agentRoute(ai)?.provider ?? ''}/${agentRoute(ai)?.model ?? ''}`;
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
      visionPack: vision.visionPack,
      sheetCols: vision.sheetCols,
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

/**
 * 宽松解析：输出被 maxTokens 截断时，JSON 数组可能不完整。
 * 这里逐个抠出完整的 `{...}` 对象（正确跳过字符串里的括号），能抢救多少算多少。
 */
function parseJsonArrayLoose(text) {
  const raw = String(text ?? '');
  const strict = parseJsonArray(raw);
  if (Array.isArray(strict) && strict.length) return strict;
  const items = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const value = JSON.parse(raw.slice(start, i + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) items.push(value);
        } catch { /* 忽略这一个不完整的对象 */ }
        start = -1;
      }
    }
  }
  return items.length ? items : null;
}

/** 画面描述的 token 预算：按张数给足，避免 JSON 被截断。 */
function descriptionBudget(count, requested) {
  const need = 500 + Math.max(1, count) * 170;
  const base = Number(requested) > 0 ? Number(requested) : 0;
  return Math.max(base, Math.min(8000, need));
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
  lang = 'zh',
  llm,
  route,
  attachments,
  frames,
  signal,
  onProgress,
  batchSize = VISION_BATCH_SIZE,
  maxTokens = 1400,
  onUsage,
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

    const listed = slice.map((f) => (normalizeLang(lang) === 'zh' ? `${f.seconds} 秒` : `second ${f.seconds}`)).join(normalizeLang(lang) === 'zh' ? '、' : ', ');
    const label = normalizeLang(lang) === 'zh' ? '这些画面分别对应：' : 'These frames correspond to: ';
    const content = [{ type: 'text', text: `${describePrompt(lang)}\n\n${label}${listed}。` }];
    for (const ref of refs) content.push({ type: 'image', attachment: ref });

    let text = '';
    let failure = null;
    // eslint-disable-next-line no-await-in-loop
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content }],
      maxTokens: descriptionBudget(slice.length, maxTokens),
      signal,
      sessionId: route.sessionId || 'dsh-video-panel',
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
      if (chunk?.type === 'usage') onUsage?.(chunk.usage ?? null);
      if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        failure = chunk.reason.failure ?? { message: 'unknown' };
      }
    }
    if (failure) {
      if (failure.message?.includes('cancel')) throw new VideoError('aborted', '已取消。');
      throw new VideoError('vision-failed', `画面理解失败：${failure.message ?? '模型返回错误'}`);
    }

    const parsed = parseJsonArrayLoose(text);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new VideoError('vision-failed', `模型没有按格式返回画面描述：${String(text).trim().slice(0, 80)}`);
    }
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

/**
 * 拼图版画面理解：一次只看**一张**分镜拼图，提示里给出「第几格 = 第几秒」对应表。
 *
 * 与 describeFrames 的差别只在打包方式：帧数一样多，但模型只收一张图，
 * 所以请求次数、时延和图片 token 都按格数摊薄。
 */
export async function describeSheet({
  lang = 'zh',
  llm,
  route,
  attachments,
  sheet,
  signal,
  maxTokens = 2400,
  onUsage,
} = {}) {
  if (!sheet?.file) throw new VideoError('sheet-empty', '没有拼好的分镜图。');
  if (!llm?.stream) throw new VideoError('vision-unavailable', '当前没有可用的模型服务，无法做画面理解。');
  if (!route?.provider || !route?.model) throw new VideoError('vision-no-model', '没有可用的视觉模型。');
  if (!attachments?.saveImages) throw new VideoError('vision-unavailable', '附件服务不可用，无法把画面交给模型。');

  const buffer = await readFile(sheet.file);
  const [ref] = await attachments.saveImages([
    { data: new Uint8Array(buffer), mediaType: 'image/jpeg', name: basename(sheet.file) },
  ]);

  const cells = Array.isArray(sheet.layout) ? sheet.layout : [];
  const zh = normalizeLang(lang) === 'zh';
  const table = cells
    .map((cell, index) => (zh
      ? `第${index + 1}格（${cell.col + 1}列 ${cell.row + 1}行）= ${cell.seconds} 秒`
      : `cell ${index + 1} (column ${cell.col + 1}, row ${cell.row + 1}) = second ${cell.seconds}`))
    .join('\n');
  const content = [
    { type: 'text', text: `${sheetPrompt(lang)}\n\n${zh ? '对应表' : 'Cell map'}：\n${table}` },
    { type: 'image', attachment: ref },
  ];

  let text = '';
  let failure = null;
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content }],
    maxTokens: descriptionBudget(cells.length, maxTokens),
    signal,
    sessionId: route.sessionId || 'dsh-video-panel',
  })) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? '';
    if (chunk?.type === 'usage') onUsage?.(chunk.usage ?? null);
    if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
      failure = chunk.reason.failure ?? { message: 'unknown' };
    }
  }
  if (failure) {
    if (failure.message?.includes('cancel')) throw new VideoError('aborted', '已取消。');
    throw new VideoError('vision-failed', `画面理解失败：${failure.message ?? '模型返回错误'}`);
  }

  const parsed = parseJsonArrayLoose(text);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new VideoError('vision-failed', `模型没有按格式返回分镜描述：${String(text).trim().slice(0, 80)}`);
  }
  const results = [];
  cells.forEach((cell, index) => {
    const item = Array.isArray(parsed)
      ? parsed.find((entry) => Number(entry?.seconds) === Number(cell.seconds)) ?? parsed[index]
      : null;
    const description = cleanDescription(item?.description);
    if (!description) return;
    results.push({ seconds: Number(cell.seconds) || 0, description });
  });
  return results;
}

export { agentRoute, resolveVisionRoute, splitRoute };
