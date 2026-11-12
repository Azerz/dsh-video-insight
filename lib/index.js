/**
 * Host half of dsh-video — 「视频解析」.
 *
 * Three faces:
 *  1. a private JSON/SSE API for the browser panel, mounted on the profile's own
 *     web server under `/dsh-video/api` (same origin as the GUI, so the panel
 *     needs no CORS grant);
 *  2. the platform layer — `bilibili.js` / `youtube.js` turn a link into one
 *     normalized VideoDoc (see CONTRACT.md);
 *  3. a `video` tool, so the agent can watch-and-summarize on the user's behalf.
 *
 * The analysis itself runs on the profile's default model through `ctx.llm`,
 * so the panel needs no extra API key. A B 站 Cookie is optional: it only
 * unlocks subtitles + the official AI summary.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from './define-tool.js';

import { createCache, compactNumber, formatClock, VideoError } from './util.js';
import { normalizeBilibiliInput, resolveBilibili } from './bilibili.js';
import { clearHistory, readHistory, recordHistory, removeHistory } from './history.js';
import { resolveYoutube } from './youtube.js';
import { currentRoute, runAsk, runChapters, runSummary } from './analyze.js';
import { runMindmap } from './mindmap.js';
import { buildPlayerDocument, parsePlayerQuery, PLAYER_PATH } from './player.js';
import {
  analysisView,
  appendChat,
  clearChat as clearAnalysisChat,
  readAnalysis,
  rememberDoc,
  removeAnalysis,
  saveChapters,
  saveMindmap,
  saveSummary,
} from './analysis.js';
import { ASR_DEFAULTS, asrSettings, asrStatus, readLocalTranscript, transcribeVideo } from './asr.js';

export const name = 'dsh-video-insight';

/** Route prefix the panel calls; same origin as the GUI, so no CORS preflight. */
export const API_PREFIX = '/dsh-video/api';

const VERSION = '0.4.8';
const CREDENTIALS_FILE = join(homedir(), '.dsh', 'video-credentials.json');

const DEFAULTS = {
  bilibiliCookie: '',
  transcriptLimitChars: 60000,
  requestTimeoutMs: 20000,
  provider: '',
  model: '',
  asr: { ...ASR_DEFAULTS },
};

const MAX_ANALYZE_BODY = 256 * 1024;

/* -------------------------------- settings -------------------------------- */

async function readSavedCredentials() {
  try {
    const text = await readFile(CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSavedCredentials(next) {
  await mkdir(join(homedir(), '.dsh'), { recursive: true });
  await writeFile(CREDENTIALS_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function sanitizeAsr(raw, base) {
  const out = { ...ASR_DEFAULTS, ...(base && typeof base === 'object' ? base : {}) };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(ASR_DEFAULTS)) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (key === 'enabled' || key === 'keepAudio' || key === 'autoTranscribe' || key === 'ocrFallback') out[key] = Boolean(value);
    else if (key === 'engine') {
      out.engine = ['auto', 'whisper', 'sensevoice'].includes(String(value)) ? String(value) : 'auto';
    } else if (key === 'threads' || key === 'maxSeconds') {
      out[key] = Math.min(Math.max(Number(value) || 0, 0), key === 'threads' ? 32 : 4 * 60 * 60);
    } else if (key === 'ocrIntervalSeconds' || key === 'ocrMaxFrames') {
      out[key] = key === 'ocrIntervalSeconds'
        ? Math.min(Math.max(Math.round(Number(value) || 8), 3), 60)
        : Math.min(Math.max(Math.round(Number(value) || 120), 20), 240);
    } else if (key === 'frameMode') {
      out.frameMode = ['auto', 'ocr', 'vision'].includes(String(value)) ? String(value) : 'auto';
    } else if (key === 'visionMaxFrames') {
      out.visionMaxFrames = Math.min(Math.max(Math.round(Number(value) || 48), 8), 160);
    } else {
      out[key] = String(value ?? '').trim();
    }
  }
  return out;
}

function settingsFrom(config, saved) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  if (typeof saved?.bilibiliCookie === 'string') merged.bilibiliCookie = saved.bilibiliCookie;
  const asr = saved?.asr ? sanitizeAsr(saved.asr, sanitizeAsr(merged.asr)) : sanitizeAsr(merged.asr);
  return {
    bilibiliCookie: String(merged.bilibiliCookie ?? '').trim(),
    transcriptLimitChars: Math.min(Math.max(Number(merged.transcriptLimitChars) || DEFAULTS.transcriptLimitChars, 2000), 200000),
    requestTimeoutMs: Math.min(Math.max(Number(merged.requestTimeoutMs) || DEFAULTS.requestTimeoutMs, 3000), 60000),
    provider: String(merged.provider ?? '').trim(),
    model: String(merged.model ?? '').trim(),
    asr,
  };
}

/* -------------------------------- HTTP glue ------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes = MAX_ANALYZE_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new VideoError('too-large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new VideoError('bad-json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': dsh-video stream\n\n');
}

function sseSend(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseClose(res) {
  if (res.writableEnded || res.destroyed) return;
  res.end();
}

/* ----------------------------- platform dispatch -------------------------- */

const BILIBILI_HINT = /bilibili\.com|b23\.tv|bili2233\.cn|BV[0-9A-Za-z]{10}|\bav\d{1,12}\b/i;
const YOUTUBE_HINT = /youtube\.com|youtu\.be|^[A-Za-z0-9_-]{11}$/;

function detectPlatform(input) {
  const text = String(input ?? '').trim();
  if (BILIBILI_HINT.test(text)) return 'bilibili';
  if (YOUTUBE_HINT.test(text)) return 'youtube';
  return null;
}

/**
 * B 站的接口很在意「并发」——同时打几下就 -352。面板里连点、多标签页、
 * 工具调用叠在一起都会触发，所以这里在插件内排队，一次只放一个出去。
 */
let bilibiliQueue = Promise.resolve();
function serialBilibili(fn) {
  const run = bilibiliQueue.then(fn, fn);
  bilibiliQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 解析器：带 30 分钟 LRU 缓存 + 同一链接的并发去重。 */
export function createResolver(settings) {
  const cache = createCache({ ttlMs: 30 * 60 * 1000, limit: 24 });
  const inFlight = new Map();

  async function resolveKey(url) {
    const platform = detectPlatform(url);
    if (!platform) {
      throw new VideoError('unsupported', '只支持 YouTube 与哔哩哔哩（bilibili.com / b23.tv / BV 号）链接。');
    }
    if (platform === 'bilibili') {
      const target = await serialBilibili(() =>
        normalizeBilibiliInput(url, { timeoutMs: settings.requestTimeoutMs }));
      return { platform, key: `bilibili:${target.bvid ?? `av${target.aid}`}` };
    }
    const match = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/.exec(String(url));
    return { platform, key: `youtube:${match?.[1] ?? String(url).trim()}` };
  }

  async function resolve(url, { force = false } = {}) {
    const { platform, key } = await resolveKey(url);

    if (!force) {
      const hit = cache.get(key);
      if (hit) return hit;
      const running = inFlight.get(key);
      if (running) return running;
    }

    const task = (async () => {
      const doc = platform === 'bilibili'
        ? await serialBilibili(() =>
            resolveBilibili({ cookie: settings.bilibiliCookie, timeoutMs: settings.requestTimeoutMs }, url))
        : await resolveYoutube(
            { timeoutMs: settings.requestTimeoutMs, transcriptLimitChars: settings.transcriptLimitChars },
            url,
          );
      cache.set(doc.docId, doc);
      if (key !== doc.docId) cache.set(key, doc);
      return doc;
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, task);
    return task;
  }

  return { cache, resolve };
}

/* -------------------------------- analysis -------------------------------- */

/**
 * 给 doc 挂上最合适的转写稿：平台字幕 vs 本地转写稿，谁更完整用谁。
 * 有些 B 站视频只有 30 秒 AI 字幕（或简介式字幕），而本地转写是完整解说；
 * 这种情况下优先本地稿，否则 RAG/总结都会漏内容。
 */
async function attachBestTranscript(doc) {
  if (!doc?.docId) return doc;
  let local = null;
  try {
    local = await readLocalTranscript(doc.docId);
  } catch {
    local = null;
  }
  const isLocalSource = (source) => String(source ?? '').startsWith('local-') || source === 'frame-ocr';
  const dropStaleWarnings = () => {
    if (Array.isArray(doc.warnings)) {
      doc.warnings = doc.warnings.filter((item) => !/没有可用字幕|只基于标题/.test(String(item)));
    }
  };
  if (!local) {
    // 缓存里已经挂着本地转写/画面文字稿的文档：把上一次「没有可用字幕」的过时提示清掉。
    if (doc.transcript?.available && isLocalSource(doc.transcript.source)) dropStaleWarnings();
    return doc;
  }
  const platformChars = doc.transcript?.available ? Number(doc.transcript.chars) || 0 : 0;
  const localChars = Number(local.chars) || 0;
  const better = !doc.transcript?.available || localChars > Math.max(platformChars * 1.5, platformChars + 400);
  if (!better) return doc;
  const warnings = Array.isArray(doc.warnings) ? doc.warnings : [];
  if (doc.transcript?.available) {
    doc.warnings = [...warnings, '平台字幕明显短于本地转写稿，已改用更完整的本地转写。'];
  } else {
    // 上一步「没有可用字幕」的提示已经过时，换成「用的是本地转写」
    dropStaleWarnings();
    const ocr = local.source === 'frame-ocr';
    doc.warnings.push(ocr
      ? '这个视频没有平台字幕，已使用本地画面文字识别稿（OCR）。'
      : '这个视频没有平台字幕，已使用本地语音转写稿。');
  }
  doc.transcript = local;
  return doc;
}

async function ensureDoc(resolver, body) {
  const docId = String(body?.docId ?? '').trim();
  if (docId) {
    const hit = resolver.cache.get(docId);
    // 解析缓存里可能还没有挂上本地转写/画面文字稿（比如 host 刚重启），统一补一次。
    if (hit) return attachBestTranscript(hit);
  }
  const url = String(body?.url ?? '').trim();
  if (!url) throw new VideoError('bad-url', '既没有 docId 也没有链接，无法继续');
  return attachBestTranscript(await resolver.resolve(url));
}

/**
 * 解析（或从缓存取）+ 分析。`handlers.onPhase` 让 SSE 面板把
 * 「解析中 / 读字幕 / 模型写作」分开显示，而不是干等。
 */
async function analyzeOnce(aiCtx, settings, resolver, request, handlers = {}) {
  const mode = String(request?.mode ?? 'summary');
  if (mode === 'ask' && !String(request?.question ?? '').trim()) {
    throw new VideoError('bad-param', '追问需要 question 参数');
  }

  let doc = null;
  const docId = String(request?.docId ?? '').trim();
  if (docId) doc = resolver.cache.get(docId);
  if (!doc) {
    handlers.onPhase?.('正在解析视频信息…');
    doc = await ensureDoc(resolver, request);
  }
  if (doc.transcript?.available) {
    handlers.onPhase?.(`已取到字幕（${compactNumber(doc.transcript.chars)} 字），正在送给模型…`);
  } else if (settings.asr?.enabled) {
    handlers.onPhase?.('这个视频没有字幕；可以先「本地转写」出文字稿，模型这次会基于标题、简介与章节分析…');
  } else {
    handlers.onPhase?.('这个视频没有字幕，模型会基于标题、简介与章节分析…');
  }
  if (mode === 'ask') handlers.onPhase?.('正在转写稿里检索相关段落…');
  handlers.onPhase?.('模型正在写…');

  if (mode === 'ask') {
    const result = await runAsk(aiCtx, settings, doc, {
      question: String(request.question),
      history: Array.isArray(request.history) ? request.history : [],
      signal: handlers.signal,
      onDelta: handlers.onDelta,
    });
    return { doc, ...result };
  }

  const result = await runSummary(aiCtx, settings, doc, {
    signal: handlers.signal,
    onDelta: handlers.onDelta,
  });
  return { doc, ...result };
}

/* --------------------------------- tool ---------------------------------- */

function renderDocForTool(doc, maxChars) {
  const limit = Math.min(Math.max(Number(maxChars) || 20000, 1000), 60000);
  const head = [
    `标题：${doc.title}`,
    `作者：${doc.author || '未知'}`,
    `平台：${doc.platform === 'youtube' ? 'YouTube' : '哔哩哔哩'}`,
    doc.duration ? `时长：${formatClock(doc.duration)}` : '',
    doc.stats?.views ? `播放：${compactNumber(doc.stats.views)}` : '',
    doc.url,
  ].filter(Boolean).join('\n');

  const parts = [head];
  if (doc.description) parts.push(`简介：${doc.description.slice(0, 1200)}`);

  if (doc.transcript?.available) {
    const transcript = doc.transcript;
    const lines = [];
    let used = 0;
    for (const segment of transcript.segments) {
      const line = `[${formatClock(segment.start)}] ${segment.text}`;
      if (used + line.length > limit) break;
      lines.push(line);
      used += line.length + 1;
    }
    parts.push(
      `字幕（${transcript.source}，共 ${transcript.chars} 字${lines.length < transcript.segments.length ? `，仅前 ${lines.length} 段` : ''}）：`,
      lines.join('\n'),
    );
  } else {
    parts.push('字幕：无（这个视频没有可用字幕）');
  }
  if (doc.warnings?.length) parts.push(`注意：${doc.warnings.join('；')}`);
  return parts.join('\n\n');
}

/**
 * 工具调用产生的浏览/分析也记进历史与综合分析缓存，面板打开同一视频时可直接复用。
 * 历史/缓存写失败不影响工具返回值（工具结果已经生成）。
 */
async function rememberToolUse(doc, action, { summary } = {}) {
  if (!doc?.docId) return;
  try {
    await rememberDoc(doc);
    if (summary) {
      const payload = typeof summary === 'string' ? { text: summary } : summary;
      if (payload?.text) await saveSummary(doc.docId, payload);
    }
    await recordHistory(doc, action);
  } catch {
    /* 历史缓存是旁路，失败不打断工具调用 */
  }
}

function createTool(aiCtx, config, resolver) {
  return defineTool({
    name: 'video',
    description:
      '解析并总结视频（YouTube / 哔哩哔哩）。action=resolve 只取元信息与字幕（快，不花模型 token）；action=transcribe 在视频没有字幕时用本机语音识别（Whisper / SenseVoice）生成文字稿，连语音都没有时自动改用画面文字识别（OCR）或视觉模型的画面理解（frame-vision，图片会发给模型）（慢）；action=summary 直接给出结构化中文总结（一句话总结/核心观点/内容脉络/关键要点）；action=ask 针对该视频追问（需 question）。链接支持完整 URL、youtu.be 短链、b23.tv 短链、BV 号。',
    parameters: {
      action: { type: 'string', required: true, description: 'resolve | transcribe | summary | ask' },
      url: { type: 'string', required: true, description: 'YouTube 或哔哩哔哩视频链接 / BV 号' },
      question: { type: 'string', description: 'action=ask 时要问的问题' },
      maxChars: { type: 'number', description: 'action=resolve 时字幕最多返回多少字，缺省 20000（上限 60000）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'resolve');
      const url = String(args?.url ?? '').trim();
      if (!url) throw new VideoError('bad-param', `action=${action} 需要 url 参数`);
      const settings = settingsFrom(config, await readSavedCredentials());

      if (action === 'resolve') {
        const doc = await attachBestTranscript(await resolver.resolve(url));
        await rememberToolUse(doc, 'view');
        return renderDocForTool(doc, args?.maxChars);
      }
      if (action === 'transcribe') {
        const doc = await attachBestTranscript(await resolver.resolve(url));
        if (!doc.transcript?.available) {
          doc.transcript = await transcribeVideo({ doc, settings, ai: aiCtx, attachments: aiCtx.attachments });
        }
        await rememberToolUse(doc, 'view');
        return renderDocForTool(doc, args?.maxChars);
      }
      if (action === 'summary' || action === 'ask') {
        const result = await analyzeOnce(aiCtx, settings, resolver, {
          url,
          mode: action === 'ask' ? 'ask' : 'summary',
          question: args?.question,
        });
        if (action === 'summary') {
          await rememberToolUse(result.doc, 'analyze', { summary: { text: result.text, usage: result.usage, suggestions: result.suggestions ?? [] } });
        } else {
          await rememberToolUse(result.doc, 'analyze');
        }
        return action === 'summary'
          ? [
              `《${result.doc.title}》${result.doc.author ? ` · ${result.doc.author}` : ''}${result.doc.duration ? ` · ${formatClock(result.doc.duration)}` : ''}`,
              result.doc.url,
              '',
              result.text,
              ...(result.suggestions?.length
                ? ['', '你可能还想问：', ...result.suggestions.map((question) => `- ${question}`)]
                : []),
            ].join('\n')
          : [
              `《${result.doc.title}》`,
              `问：${args?.question}`,
              '',
              result.text,
              result.citations?.length ? `\n依据：${result.citations.map((item) => `[${formatClock(item.start)}]`).join(' ')}` : '',
            ].filter(Boolean).join('\n');
      }
      throw new VideoError('bad-param', `未知 action：${action}（可用 resolve / summary / ask）`);
    },
  });
}

/* ------------------------------ digest tool ------------------------------ */

const TRANSCRIPT_SOURCE_LABELS = {
  'youtube-caption': '平台字幕',
  'bilibili-subtitle': '平台字幕',
  'bilibili-ai': 'B 站 AI 字幕',
  'local-whisper': '本地 Whisper 转写',
  'local-sensevoice': '本地 SenseVoice 转写',
  'frame-ocr': '画面文字识别（OCR）',
  'frame-vision': '画面理解（视觉模型）',
};

function describeTranscriptForDigest(transcript) {
  if (!transcript?.available) return '没有字幕或转写稿（摘要只依据标题与简介）';
  const label = TRANSCRIPT_SOURCE_LABELS[transcript.source] ?? transcript.source ?? '字幕';
  const lang = transcript.lang ? `${transcript.lang}，` : '';
  return `${label}（${lang}${compactNumber(transcript.chars)} 字）`;
}

/** 把「元信息 + 总结/回答」压成一段适合 IM（QQ）直接转述的中文摘要。 */
export function buildDigestText(doc, body, { question = '', citations = [], maxChars = 1800 } = {}) {
  const limit = Math.min(Math.max(Number(maxChars) || 1800, 400), 4000);
  let text = String(body ?? '').trim();
  const truncated = text.length > limit;
  if (truncated) text = `${text.slice(0, limit - 12).trimEnd()}\n……（已截断）`;

  const platform = doc?.platform === 'youtube' ? 'YouTube' : doc?.platform === 'bilibili' ? '哔哩哔哩' : '';
  const meta = [platform, doc?.author, doc?.duration ? formatClock(doc.duration) : ''].filter(Boolean).join(' · ');
  const lines = [`《${doc?.title || '这个视频'}》`, meta, doc?.url ?? ''].filter(Boolean);
  lines.push(`字幕：${describeTranscriptForDigest(doc?.transcript)}`);
  if (question) lines.push(`问：${question}`);
  lines.push('', text);
  if (citations.length) {
    const marks = citations.slice(0, 8).map((item) => `[${formatClock(item.start)}]`).join(' ');
    lines.push('', `依据：${marks}`);
  }
  const official = Array.isArray(doc?.officialChapters) ? doc.officialChapters.slice(0, 8) : [];
  if (official.length) {
    lines.push('', '章节：', ...official.map((item) => `${formatClock(item.start)} ${item.title}`));
  }
  if (Array.isArray(doc?.warnings) && doc.warnings.length) lines.push('', `注意：${doc.warnings.join('；')}`);
  return lines.join('\n');
}

/**
 * 面向 IM / QQ 会话的「一次调用出结果」工具：解析 → 必要时本地转写（含 OCR 兜底）→ 总结或追问。
 * 与 `video` 工具不同，它不返回整份字幕，只给一段可以直接发给聊天对象的摘要。
 */
function createDigestTool(aiCtx, config, resolver) {
  return defineTool({
    name: 'video_digest',
    description:
      '【视频总结首选工具】快速读懂一个视频（YouTube / 哔哩哔哩）。**用户发来视频链接并要求总结、介绍、提问、了解内容时，必须第一步调用本工具，不要自己用 bash / curl / yt-dlp / ffmpeg / whisper 手工下载和转写**：它内部已经做好了链接解析、平台字幕、本地语音转写（Whisper / SenseVoice）和纯无声视频的 OCR / 画面理解（OCR 不出本机；画面理解会把抽样画面发给模型），并附带 [mm:ss] 时间点。返回一段可直接转述的中文摘要（标题、作者、时长、链接、字幕来源、六段式总结，或对 question 的回答）。需要完整字幕、官方章节或本地转写明细时再用 video 工具。',
    parameters: {
      url: { type: 'string', required: true, description: 'YouTube 或哔哩哔哩视频链接 / BV 号 / 11 位视频 id' },
      question: { type: 'string', description: '可选。想针对视频问的问题；不填则返回整段总结' },
      maxChars: { type: 'number', description: '摘要正文最多多少字，缺省 1800（400-4000）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const url = String(args?.url ?? '').trim();
      if (!url) throw new VideoError('bad-param', 'video_digest 需要 url 参数');
      const question = String(args?.question ?? '').trim();
      const settings = settingsFrom(config, await readSavedCredentials());
      const route = currentRoute(aiCtx, settings);
      if (!route?.provider || !route?.model) {
        throw new VideoError('no-model', '当前没有可用的模型，无法生成摘要。');
      }

      let doc = await attachBestTranscript(await resolver.resolve(url));
      if (!doc.transcript?.available && settings.asr?.enabled) {
        doc.transcript = await transcribeVideo({ doc, settings, ai: aiCtx, attachments: aiCtx.attachments, signal: exec?.signal });
        doc = await attachBestTranscript(doc);
      }

      if (question) {
        const result = await runAsk(aiCtx, settings, doc, { question, history: [], signal: exec?.signal });
        await rememberToolUse(doc, 'analyze');
        return buildDigestText(doc, result.text, {
          question,
          citations: result.citations ?? [],
          maxChars: args?.maxChars,
        });
      }
      const result = await runSummary(aiCtx, settings, doc, { signal: exec?.signal });
      await rememberToolUse(doc, 'analyze', { summary: { text: result.text, usage: result.usage, suggestions: result.suggestions ?? [] } });
      return buildDigestText(doc, result.text, { maxChars: args?.maxChars });
    },
  });
}

/* --------------------------------- handler -------------------------------- */

function createApiHandler(aiCtx, config) {
  let resolver = null;
  const resolverFor = (settings) => {
    if (!resolver) resolver = createResolver(settings);
    return resolver;
  };
  // Cookie 变了要连解析器一起重建，否则缓存里「无字幕」的旧结论会一直命中。
  const resetResolver = () => {
    resolver = null;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    const saved = await readSavedCredentials();
    const settings = settingsFrom(config, saved);
    const activeResolver = resolverFor(settings);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET, POST, OPTIONS' });
        res.end();
        return;
      }

      if (req.method === 'GET' && route === '/status') {
        const asr = await asrStatus(settings, { ai: aiCtx, attachments: aiCtx.attachments });
        json(res, 200, {
          ok: true,
          value: {
            version: VERSION,
            model: currentRoute(aiCtx, settings),
            bilibili: { cookie: Boolean(settings.bilibiliCookie) },
            platforms: { youtube: true, bilibili: true },
            transcriptLimitChars: settings.transcriptLimitChars,
            asr: {
              enabled: asr.enabled,
              ready: asr.ready,
              engine: asr.engine,
              activeEngine: asr.activeEngine,
              engineLabel: asr.engineLabel,
              downloadReady: asr.downloadReady,
            },
          },
        });
        return;
      }

      if (req.method === 'GET' && route === '/asr/status') {
        json(res, 200, { ok: true, value: await asrStatus(settings, { fresh: url.searchParams.get('fresh') === '1', ai: aiCtx, attachments: aiCtx.attachments }) });
        return;
      }

      if (req.method === 'POST' && route === '/asr/config') {
        const body = await readBody(req);
        const next = { ...saved, asr: sanitizeAsr(body?.asr ?? body, sanitizeAsr(saved?.asr, sanitizeAsr(DEFAULTS.asr))) };
        await writeSavedCredentials(next);
        const patched = settingsFrom(config, next);
        json(res, 200, {
          ok: true,
          value: await asrStatus(patched, { fresh: true }),
        });
        return;
      }

      // 播放器外壳页：桌面端主界面跑在自定义协议（dsh-app://app）下，
      // 直接嵌 YouTube iframe 会被拒绝播放；外壳页由 Host 以 http 起源提供，
      // 内层再由它嵌真正的播放器，Referer/origin 才合法。
      if (req.method === 'GET' && route === PLAYER_PATH) {
        const player = parsePlayerQuery(url.searchParams);
        if (!player) {
          const body = '<!doctype html><meta charset="utf-8"><title>播放器</title><p style="font-family:system-ui;color:#888;padding:16px">播放器参数不合法。</p>';
          res.writeHead(400, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        const body = buildPlayerDocument(player);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'x-content-type-options': 'nosniff',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && route === '/resolve') {
        const target = url.searchParams.get('url') ?? '';
        const force = url.searchParams.get('force') === '1';
        try {
          const doc = await attachBestTranscript(await activeResolver.resolve(target, { force }));
          await rememberDoc(doc);
          const analysis = analysisView(await readAnalysis(doc.docId));
          if (analysis) doc.analysis = analysis;
          await recordHistory(doc, 'view');
          json(res, 200, { ok: true, value: doc });
        } catch (error) {
          json(res, 200, { ok: false, code: error?.code ?? 'internal', error: String(error?.message ?? error) });
        }
        return;
      }

      if (req.method === 'GET' && route === '/history') {
        const items = await readHistory();
        const enriched = await Promise.all(
          items.map(async (item) => {
            const cached = await readAnalysis(item.docId);
            return {
              ...item,
              hasSummary: Boolean(cached?.summary),
              hasChapters: Boolean(cached?.chapters),
              hasMindmap: Boolean(cached?.mindmap),
              chatCount: Array.isArray(cached?.chat) ? cached.chat.length : 0,
            };
          }),
        );
        json(res, 200, { ok: true, value: { items: enriched } });
        return;
      }

      if (req.method === 'POST' && route === '/history/clear') {
        json(res, 200, { ok: true, value: { items: await clearHistory() } });
        return;
      }

      if (req.method === 'POST' && route === '/history/remove') {
        const body = await readBody(req);
        json(res, 200, { ok: true, value: { items: await removeHistory(body?.docId) } });
        return;
      }

      // 分析缓存：读取某个视频已生成的总结/章节/导图/对话
      if (req.method === 'GET' && route === '/analysis') {
        const docId = url.searchParams.get('docId') ?? '';
        if (!docId) {
          json(res, 200, { ok: false, code: 'bad-param', error: '需要 docId 参数' });
          return;
        }
        const cached = await readAnalysis(docId);
        // doc 快照一起返回：视频下架/解析失败时，面板仍能按历史里的标题封面展示旧分析
        json(res, 200, { ok: true, value: { docId, doc: cached?.doc ?? null, analysis: analysisView(cached) } });
        return;
      }

      if (req.method === 'POST' && route === '/analysis/clear') {
        const body = await readBody(req);
        const docId = String(body?.docId ?? '').trim();
        if (!docId) {
          json(res, 200, { ok: false, code: 'bad-param', error: '需要 docId 参数' });
          return;
        }
        await removeAnalysis(docId);
        json(res, 200, { ok: true, value: { docId } });
        return;
      }

      if (req.method === 'POST' && route === '/analysis/chat/clear') {
        const body = await readBody(req);
        const docId = String(body?.docId ?? '').trim();
        if (!docId) {
          json(res, 200, { ok: false, code: 'bad-param', error: '需要 docId 参数' });
          return;
        }
        await clearAnalysisChat(docId);
        json(res, 200, { ok: true, value: { docId } });
        return;
      }

      // SSE：总结 / 追问
      if (req.method === 'POST' && route === '/analyze') {
        const body = await readBody(req);
        sseOpen(res);

        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', onClose);

        try {
          const result = await analyzeOnce(aiCtx, settings, activeResolver, body, {
            signal: controller.signal,
            onPhase: (text) => sseSend(res, { type: 'phase', text }),
            onDelta: (text) => sseSend(res, { type: 'delta', text }),
          });
          await recordHistory(result.doc, 'analyze');
          // 持久化分析结果：总结落 summary，追问落对话记录（从历史里点回来还能看到）
          if (String(body?.mode ?? 'summary') === 'ask') {
            const question = String(body?.question ?? '').trim();
            const previous = await readAnalysis(result.doc.docId);
            const last = Array.isArray(previous?.chat) ? previous.chat[previous.chat.length - 1] : null;
            const messages = [];
            if (question && !(last?.role === 'user' && last.text === question)) {
              messages.push({ role: 'user', text: question, at: Date.now() });
            }
            messages.push({ role: 'assistant', text: result.text, citations: result.citations ?? [], at: Date.now() });
            await appendChat(result.doc.docId, messages);
          } else {
            await saveSummary(result.doc.docId, {
              text: result.text,
              usage: result.usage,
              suggestions: result.suggestions ?? [],
            });
          }
          sseSend(res, {
            type: 'done',
            text: result.text,
            usage: result.usage ?? null,
            docId: result.doc.docId,
            citations: result.citations ?? [],
            // 总结末尾由模型给出的三条高价值追问，面板渲染成 chip
            suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
            cached: false,
          });
        } catch (error) {
          sseSend(res, {
            type: 'error',
            code: controller.signal.aborted ? 'aborted' : (error?.code ?? 'internal'),
            message: controller.signal.aborted ? '已取消' : String(error?.message ?? error),
          });
        } finally {
          res.off?.('close', onClose);
          sseClose(res);
        }
        return;
      }

      if (req.method === 'POST' && route === '/chapters') {
        const body = await readBody(req);
        try {
          const doc = await ensureDoc(activeResolver, body);
          const result = await runChapters(aiCtx, settings, doc);
          await saveChapters(doc.docId, { items: result.chapters, source: 'llm' });
          json(res, 200, {
            ok: true,
            value: { chapters: result.chapters, source: 'llm', duration: doc.duration },
          });
        } catch (error) {
          json(res, 200, { ok: false, code: error?.code ?? 'internal', error: String(error?.message ?? error) });
        }
        return;
      }

      // 思维导图：从字幕/本地转写生成 {title, children[]} 树（非流式，带内存缓存）
      if (req.method === 'GET' && route === '/mindmap') {
        const target = {
          docId: url.searchParams.get('docId') ?? '',
          url: url.searchParams.get('url') ?? '',
        };
        const force = url.searchParams.get('force') === '1';
        try {
          const doc = await attachBestTranscript(await ensureDoc(activeResolver, target));
          if (!doc.transcript?.available) {
            json(res, 200, {
              ok: false,
              code: 'no-transcript',
              error: '这个视频还没有字幕或本地转写，先生成文字稿再画思维导图。',
            });
            return;
          }
          const saved = await readAnalysis(doc.docId);
          if (!force && saved?.mindmap) {
            json(res, 200, {
              ok: true,
              value: {
                docId: doc.docId,
                mindmap: saved.mindmap.mindmap,
                source: 'cache',
                generatedAt: saved.mindmap.generatedAt,
                cached: true,
              },
            });
            return;
          }
          const result = await runMindmap(aiCtx, settings, doc, { force });
          await saveMindmap(doc.docId, result.mindmap);
          json(res, 200, {
            ok: true,
            value: {
              docId: doc.docId,
              mindmap: result.mindmap,
              source: 'llm',
              generatedAt: result.generatedAt,
              cached: result.cached,
            },
          });
        } catch (error) {
          json(res, 200, { ok: false, code: error?.code ?? 'internal', error: String(error?.message ?? error) });
        }
        return;
      }

      // SSE：本地语音转写（无字幕兜底）
      if (req.method === 'POST' && route === '/transcribe') {
        const body = await readBody(req);
        sseOpen(res);

        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', onClose);

        try {
          const doc = await ensureDoc(activeResolver, body);
          if (doc.transcript?.available && !body.force) {
            sseSend(res, { type: 'done', docId: doc.docId, transcript: doc.transcript, cached: true });
            return;
          }
          const transcript = await transcribeVideo({
            doc,
            settings,
            ai: aiCtx,
            attachments: aiCtx.attachments,
            force: body.force === true,
            signal: controller.signal,
            onPhase: (text) => sseSend(res, { type: 'phase', text }),
            onProgress: (event) => sseSend(res, {
              type: 'progress',
              percent: event?.percent ?? null,
              stage: event?.stage ?? '',
            }),
          });
          doc.transcript = transcript;
          doc.warnings = Array.isArray(doc.warnings) ? doc.warnings : [];
          sseSend(res, { type: 'done', docId: doc.docId, transcript, cached: Boolean(transcript.cached) });
        } catch (error) {
          sseSend(res, {
            type: 'error',
            code: controller.signal.aborted ? 'aborted' : (error?.code ?? 'internal'),
            message: controller.signal.aborted ? '已取消' : String(error?.message ?? error),
          });
        } finally {
          res.off?.('close', onClose);
          sseClose(res);
        }
        return;
      }

      if (req.method === 'POST' && route === '/credentials') {
        const body = await readBody(req);
        const next = { ...saved };
        if ('bilibiliCookie' in body) {
          const value = String(body.bilibiliCookie ?? '').trim();
          if (value) next.bilibiliCookie = value;
          else delete next.bilibiliCookie;
        }
        await writeSavedCredentials(next);
        resetResolver();
        json(res, 200, { ok: true, value: { bilibili: { cookie: Boolean(next.bilibiliCookie) } } });
        return;
      }

      if (req.method === 'POST' && route === '/credentials/clear') {
        await writeSavedCredentials({});
        resetResolver();
        json(res, 200, { ok: true, value: { bilibili: { cookie: false } } });
        return;
      }

      json(res, 404, { ok: false, code: 'not-found', error: `未知接口 ${route}` });
    } catch (error) {
      if (res.headersSent) {
        sseSend(res, { type: 'error', code: error?.code ?? 'internal', message: String(error?.message ?? error) });
        sseClose(res);
        return;
      }
      json(res, 200, { ok: false, code: error?.code ?? 'internal', error: String(error?.message ?? error) });
    }
  };
}

/* --------------------------------- apply --------------------------------- */

export function apply(ctx, config) {
  // 分析要用的模型服务；缺席时面板仍能解析视频，只是「分析」会给出可读提示。
  const ai = { llm: null, agentDefaultModel: null, attachments: null };
  ctx.inject(['llm', 'agentDefaultModel'], (aiCtx) => {
    ai.llm = aiCtx.llm;
    ai.agentDefaultModel = aiCtx.agentDefaultModel;
    aiCtx.effect(() => () => {
      ai.llm = null;
      ai.agentDefaultModel = null;
    }, 'dsh-video: llm refs');
  });

  // 画面理解要把抽出来的帧当成图片消息发出去，需要附件服务保存帧。
  ctx.inject(['attachments'], (attachCtx) => {
    ai.attachments = attachCtx.attachments;
    attachCtx.effect(() => () => {
      ai.attachments = null;
    }, 'dsh-video: attachment refs');
  });

  // 1. the panel's JSON/SSE API, on the profile's web server
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createApiHandler(ai, config);
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    }), 'dsh-video: panel api');
  });

  // 2. the agent-facing tools（自己一份解析缓存，和面板互不影响）。
  //    两个工具都注册成全局工具（fiber 不是 agent scope），所以所有会话里的
  //    agent —— 包括 qqbot 插件用 ctx.agents.create 建出来的 QQ 会话 —— 都看得见。
  ctx.inject(['tools'], (toolCtx) => {
    // 工具和面板共用同一份凭证：Cookie 是面板里粘贴的，agent 侧也要拿得到；
    // 换了 Cookie 就让解析缓存作废，否则「无字幕」的旧结论会一直命中。
    let toolResolver = null;
    let toolCookie = null;
    const toolResolvers = {
      async resolve(url, options) {
        const saved = await readSavedCredentials();
        const cookie = String(saved.bilibiliCookie ?? '').trim();
        if (!toolResolver || cookie !== toolCookie) {
          toolResolver = createResolver(settingsFrom(config, saved));
          toolCookie = cookie;
        }
        return toolResolver.resolve(url, options);
      },
    };
    toolCtx.effect(
      () => toolCtx.tools.register(createTool(ai, config, toolResolvers)),
      'dsh-video: video tool',
    );
    toolCtx.effect(
      () => toolCtx.tools.register(createDigestTool(ai, config, toolResolvers)),
      'dsh-video: video digest tool',
    );
  });
}

export { VideoError };
