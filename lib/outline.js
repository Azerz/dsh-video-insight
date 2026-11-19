/**
 * 大纲（outline）：章节 / 关键画面共用的「切分 + 截图描述」来源。
 *
 * 优先参考思维导图的一级节点（它们带模型定位到的时间点 t），
 * 没有导图时退回章节，再退回均匀铺满。
 * 画面描述用拼图方式一次交给视觉模型，按视频缓存，章节页签与关键画面页签共用。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readAnalysis } from './analysis.js';
import { ensureVideoAsset } from './assets.js';
import { extractFramesAt } from './cuts.js';
import { asrSettings } from './asr.js';
import { cleanupWorkdir, createWorkdir, detectToolchain } from './media.js';
import { buildContactSheet } from './sheet.js';
import { VideoError } from './util.js';
import { describeSheet, visionStatus } from './vision.js';
import { normalizeLang } from './lang.js';

export const OUTLINES_DIR = join(homedir(), '.dsh', 'video-outlines');
export const OUTLINE_MAX_ITEMS = 16;
const OUTLINE_MIN_MINDMAP = 3;
const TITLE_MAX = 80;
const DETAIL_MAX = 4;

function safeId(docId) {
  return String(docId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 160);
}

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function secondsOf(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(Math.max(0, seconds) * 10) / 10 : null;
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || item.seconds === null) continue;
    const key = `${item.seconds}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** 导图一级节点 → 大纲条目。 */
function mindmapItems(tree, duration) {
  if (!tree || typeof tree !== 'object') return [];
  const nodes = Array.isArray(tree.children) ? tree.children : [];
  const items = nodes.map((node) => {
    const seconds = secondsOf(node?.t);
    const title = clip(node?.title, TITLE_MAX);
    if (seconds === null || !title) return null;
    const detail = (Array.isArray(node.children) ? node.children : [])
      .map((child) => clip(child?.title, 60))
      .filter(Boolean)
      .slice(0, DETAIL_MAX);
    return {
      seconds: duration > 0 ? Math.min(seconds, duration) : seconds,
      title,
      detail,
    };
  }).filter(Boolean);
  return dedupe(items).sort((a, b) => a.seconds - b.seconds);
}

/** 章节 → 大纲条目（分析缓存的章节优先，其次平台官方章节）。 */
function chapterItems(chapters, duration) {
  return dedupe(
    (Array.isArray(chapters) ? chapters : [])
      .map((chapter) => {
        const seconds = secondsOf(chapter?.start ?? chapter?.seconds);
        const title = clip(chapter?.title, TITLE_MAX);
        if (seconds === null || !title) return null;
        return {
          seconds: duration > 0 ? Math.min(seconds, duration) : seconds,
          title,
          detail: clip(chapter?.gist, 120) ? [clip(chapter.gist, 120)] : [],
        };
      })
      .filter(Boolean),
  ).sort((a, b) => a.seconds - b.seconds);
}

function uniformItems(duration, count = 8) {
  if (!(duration > 0)) return [];
  const total = Math.max(2, Math.min(count, OUTLINE_MAX_ITEMS));
  const items = [];
  for (let index = 0; index < total; index += 1) {
    items.push({
      seconds: Math.round((duration * (index + 0.5)) / total * 10) / 10,
      title: `片段 ${index + 1}`,
      detail: [],
    });
  }
  return items;
}

/**
 * 组装大纲：思维导图 → 章节 → 均匀。
 * 返回 { source, items:[{seconds,title,detail}] }（不含截图描述）。
 */
export async function buildOutline({ doc, docId } = {}) {
  const duration = Math.max(0, Number(doc?.duration) || 0);
  const resolvedId = docId ?? doc?.docId ?? '';
  const analysis = resolvedId ? await readAnalysis(resolvedId) : null;

  const mmTree = analysis?.mindmap?.mindmap ?? analysis?.mindmap ?? null;
  const fromMindmap = mindmapItems(mmTree, duration);
  if (fromMindmap.length >= OUTLINE_MIN_MINDMAP) {
    return { source: 'mindmap', items: fromMindmap.slice(0, OUTLINE_MAX_ITEMS) };
  }

  const chapters = Array.isArray(analysis?.chapters?.items) && analysis.chapters.items.length
    ? analysis.chapters.items
    : Array.isArray(doc?.officialChapters) ? doc.officialChapters : [];
  const fromChapters = chapterItems(chapters, duration);
  if (fromChapters.length >= 2) {
    return { source: 'chapters', items: fromChapters.slice(0, OUTLINE_MAX_ITEMS) };
  }

  return { source: 'uniform', items: uniformItems(duration) };
}

function signatureOf(outline, lang = 'zh') {
  return [`lang:${normalizeLang(lang)}`, ...(outline?.items ?? []).map((item) => `${item.seconds}:${item.title}`)]
    .join('|')
    .slice(0, 2000);
}

export function outlineFile(docId) {
  return join(OUTLINES_DIR, `${safeId(docId)}.json`);
}

export async function readOutlineVisuals(docId, signature) {
  if (!docId) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(outlineFile(docId), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null;
  if (signature && parsed.signature !== signature) return null;
  return parsed;
}

async function writeOutlineVisuals(docId, payload) {
  await mkdir(OUTLINES_DIR, { recursive: true });
  const file = outlineFile(docId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

export async function clearOutlineVisuals(docId) {
  try {
    await unlink(outlineFile(docId));
  } catch {
    // 没有就算了
  }
}

/** 把缓存的描述合并进大纲条目。 */
export async function outlineWithVisuals({ doc, docId, lang = 'zh' } = {}) {
  const outline = await buildOutline({ doc, docId });
  const signature = signatureOf(outline, lang);
  const cached = await readOutlineVisuals(doc?.docId ?? docId, signature);
  const descriptions = new Map(
    (cached?.items ?? []).map((item) => [`${item.seconds}|${item.title}`, item.description ?? '']),
  );
  return {
    ...outline,
    signature,
    visuals: cached
      ? {
          generatedAt: cached.generatedAt ?? null,
          provider: cached.route?.provider ?? '',
          model: cached.route?.model ?? '',
          described: Number(cached.described) || 0,
        }
      : null,
    items: outline.items.map((item) => ({
      ...item,
      description: descriptions.get(`${item.seconds}|${item.title}`) ?? '',
    })),
  };
}

/**
 * 生成章节/关键画面的截图描述：抽帧 → 拼成一张图 → 视觉模型逐格描述。
 * 结果按 (docId, 大纲签名) 缓存，章节页签和关键画面页签共用。
 */
export async function generateOutlineVisuals({
  doc,
  docId,
  settings = {},
  aiCtx = null,
  lang = 'zh',
  signal,
  onPhase,
  onProgress,
  force = false,
} = {}) {
  const language = normalizeLang(lang);
  if (!doc?.url) throw new VideoError('bad-url', '缺少视频链接。');
  const resolvedId = docId ?? doc.docId;
  const outline = await buildOutline({ doc, docId: resolvedId });
  if (!outline.items.length) throw new VideoError('no-outline', '这个视频还没有可切分的内容，先解析一次。');
  const signature = signatureOf(outline, language);

  if (!force) {
    const cached = await readOutlineVisuals(resolvedId, signature);
    if (cached) {
      return {
        ...outline,
        signature,
        items: outline.items.map((item, index) => ({
          ...item,
          description: cached.items?.[index]?.description ?? '',
        })),
        cached: true,
        generatedAt: cached.generatedAt ?? null,
        route: cached.route ?? null,
        usage: cached.usage ?? null,
      };
    }
  }

  const asr = asrSettings(settings);
  const vision = await visionStatus(aiCtx, asr, { fresh: true });
  if (!vision?.available) {
    throw new VideoError('vision-unavailable', vision?.reason || '没有可用的视觉模型，无法描述画面。');
  }
  const tools = await detectToolchain(asr, { fresh: false });
  rejectTool(tools, 'ffmpeg', 'ocr-no-ffmpeg', '缺少 ffmpeg。', 'brew install ffmpeg');

  const workdir = await createWorkdir();
  const started = Date.now();
  let usage = null;
  try {
    onPhase?.('准备低清视频…');
    const video = await ensureVideoAsset({
      doc,
      settings,
      tools,
      onPhase,
      onProgress,
      signal,
    });

    const times = outline.items.map((item) => item.seconds);
    onPhase?.(`按 ${times.length} 个章节起点抽帧…`);
    const frames = await extractFramesAt({
      ffmpeg: tools.ffmpeg.path,
      video: video.file,
      workdir,
      times,
      maxWidth: 960,
      signal,
      onProgress,
    });

    onPhase?.('把画面拼成一张图…');
    const cols = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(frames.length))));
    const sheet = await buildContactSheet({
      frames,
      workdir,
      ffmpeg: tools.ffmpeg.path,
      cols,
      signal,
    });

    onPhase?.('让视觉模型描述这些画面…');
    const route = vision.provider && vision.model
      ? { provider: vision.provider, model: vision.model }
      : undefined;
    const described = await describeSheet({
      lang: language,
      llm: aiCtx?.llm,
      route,
      attachments: aiCtx?.attachments,
      sheet,
      signal,
      maxTokens: 2600,
      onUsage: (value) => {
        usage = value ?? usage;
      },
    });
    const bySeconds = new Map(described.map((item) => [Math.round(item.seconds), item.description]));
    const items = outline.items.map((item, index) => {
      const description = bySeconds.get(Math.round(item.seconds))
        ?? described[index]?.description
        ?? '';
      return { ...item, description };
    });

    await writeOutlineVisuals(resolvedId, {
      docId: resolvedId,
      source: outline.source,
      signature,
      generatedAt: new Date().toISOString(),
      route: { provider: vision.provider, model: vision.model },
      usage,
      tookMs: Date.now() - started,
      described: items.filter((item) => item.description).length,
      items,
    });

    return {
      ...outline,
      signature,
      items,
      cached: false,
      generatedAt: new Date().toISOString(),
      route: { provider: vision.provider, model: vision.model },
      usage,
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

function rejectTool(tools, key, code, message, hint) {
  const value = tools?.[key];
  if (value && value.available !== false) return;
  throw new VideoError(code, hint ? `${message}（${hint}）` : message);
}
