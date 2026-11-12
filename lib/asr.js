/**
 * 语音识别层：视频没有字幕时，在本机把声音转成带时间戳的文字稿。
 *
 * 两种引擎（都不上传音频，隐私模式下也安全）：
 *  - Whisper：whisper.cpp 的 `whisper-cli`，模型默认 large-v3-turbo q5_0；
 *  - SenseVoice：sherpa-onnx 的 `sherpa-onnx-offline`，中文/粤语/英日韩都行，速度更快。
 *
 * 引擎选择顺序：配置指定 > 本机可用性（auto 时 Whisper 优先，识别质量更稳）。
 * 结果结构与平台字幕一致：`{available, source, lang, chars, segments:[{start,end,text}]}`，
 * 这样 analyze.js / 面板都不用区分来源。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { VideoError } from './util.js';
import { ocrStatus } from './ocr.js';
import { visionSettings, visionStatus } from './vision.js';
import { frameTranscript } from './frames.js';
import {
  DEFAULT_MODELS,
  detectToolchain,
  downloadAudio,
  convertToWav,
  createWorkdir,
  cleanupWorkdir,
  keepAudioCopy,
  runProcess,
} from './media.js';

export const ASR_DEFAULTS = {
  enabled: true,
  engine: 'auto',
  threads: 0,
  maxSeconds: 0,
  keepAudio: false,
  autoTranscribe: true,
  // 纯无声视频（没有配音也没有字幕）的兜底：抽帧做画面文字识别（OCR）。
  ocrFallback: true,
  ocrIntervalSeconds: 8,
  ocrMaxFrames: 120,
  // 画面理解：OCR 抠不到足够文字时，让支持图片输入的模型描述画面。
  // frameMode: auto（先 OCR，文字太少再用视觉模型）/ ocr（只用本机 OCR）/ vision（直接看画面）。
  frameMode: 'auto',
  visionModel: '',
  visionMaxFrames: 48,
  ffmpegPath: '',
  ffprobePath: '',
  ytdlpPath: '',
  whisperBinaryPath: '',
  whisperModelPath: '',
  sherpaBinaryPath: '',
  sensevoiceModelPath: '',
  sensevoiceTokensPath: '',
};

const MAX_TRANSCRIPT_SEGMENTS = 6000;

/* ------------------------------------------------------------------ 本地转写缓存 */

/** 转写结果持久化：解析缓存过期后不用再花几分钟重跑，同一视频也能直接复用。 */
const TRANSCRIPT_DIR = join(homedir(), '.dsh', 'video-transcripts');

function transcriptFile(docId) {
  const safe = String(docId ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
  return join(TRANSCRIPT_DIR, `${safe}.json`);
}

export async function readLocalTranscript(docId) {
  if (!docId) return null;
  try {
    const data = JSON.parse(await readFile(transcriptFile(docId), 'utf8'));
    if (data && data.available === true && Array.isArray(data.segments) && data.segments.length > 0) {
      return { ...data, cached: true };
    }
  } catch { /* 没有缓存或坏了：当作没转写过 */ }
  return null;
}

export async function writeLocalTranscript(docId, transcript) {
  if (!docId || !transcript?.segments?.length) return;
  try {
    await mkdir(TRANSCRIPT_DIR, { recursive: true });
    await writeFile(transcriptFile(docId), JSON.stringify({ ...transcript, savedAt: new Date().toISOString() }), 'utf8');
  } catch { /* 缓存写失败不影响本次转写 */ }
}

export async function clearLocalTranscript(docId) {
  if (!docId) return;
  try { await rm(transcriptFile(docId), { force: true }); } catch { /* 忽略 */ }
}

export function asrSettings(settings) {
  const raw = settings?.asr && typeof settings.asr === 'object' ? settings.asr : {};
  const engine = ['auto', 'whisper', 'sensevoice'].includes(String(raw.engine)) ? String(raw.engine) : 'auto';
  return {
    ...ASR_DEFAULTS,
    ...raw,
    enabled: raw.enabled !== false,
    engine,
    threads: Math.min(Math.max(Number(raw.threads) || 0, 0), 32),
    maxSeconds: Math.min(Math.max(Number(raw.maxSeconds) || 0, 0), 4 * 60 * 60),
    keepAudio: Boolean(raw.keepAudio),
    autoTranscribe: raw.autoTranscribe !== false,
    ocrFallback: raw.ocrFallback !== false,
    ocrIntervalSeconds: Math.min(Math.max(Math.round(Number(raw.ocrIntervalSeconds) || 8), 3), 60),
    ocrMaxFrames: Math.min(Math.max(Math.round(Number(raw.ocrMaxFrames) || 120), 20), 240),
    ...visionSettings({ asr: raw }),
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

/** 去掉 *music* / [Applause] / (音乐) 这类非语音标注后，真正说出来的字数。 */
function spokenChars(segments) {
  let chars = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const text = String(segment?.text ?? '')
      .replace(/\*[^*]*\*/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[♪♫]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (/^(音乐|掌声|笑声|欢呼声|music|applause|laughter|silence)$/i.test(text)) continue;
    chars += text.length;
  }
  return chars;
}

function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLang(raw) {
  const text = String(raw ?? '').trim();
  const tagged = /<\|([a-z]{2,3})\|>/.exec(text);
  if (tagged) return tagged[1];
  return text.toLowerCase().slice(0, 8);
}

/** 按当前配置选一个真正能跑的引擎。 */
function pickEngine(asr, tools, platform) {
  const whisperReady = tools.engines.whisper.available;
  const sensevoiceReady = tools.engines.sensevoice.available;
  const preferWhisper = () => {
    if (whisperReady) {
      return {
        id: 'whisper',
        label: tools.engines.whisper.label,
        source: 'local-whisper',
        binary: tools.whisper.path,
        modelPath: tools.models.whisper.path,
      };
    }
    if (sensevoiceReady) {
      return {
        id: 'sensevoice',
        label: tools.engines.sensevoice.label,
        source: 'local-sensevoice',
        binary: tools.sherpa.path,
        modelPath: tools.models.sensevoice.modelPath,
        tokensPath: tools.models.sensevoice.tokensPath,
      };
    }
    return null;
  };

  if (!tools.ffmpeg.available) return null;
  if (platform === 'youtube' && !tools.downloadAvailable) return null;
  if (asr.engine === 'whisper') {
    if (!whisperReady) return null;
    return {
      id: 'whisper',
      label: tools.engines.whisper.label,
      source: 'local-whisper',
      binary: tools.whisper.path,
      modelPath: tools.models.whisper.path,
    };
  }
  if (asr.engine === 'sensevoice') {
    if (!sensevoiceReady) return null;
    return {
      id: 'sensevoice',
      label: tools.engines.sensevoice.label,
      source: 'local-sensevoice',
      binary: tools.sherpa.path,
      modelPath: tools.models.sensevoice.modelPath,
      tokensPath: tools.models.sensevoice.tokensPath,
    };
  }
  return preferWhisper();
}

function missingHints(tools, asr, platform) {
  const hints = [];
  if (!tools.ffmpeg.available) hints.push('缺 ffmpeg：`brew install ffmpeg`');
  if (!tools.downloadAvailable) hints.push('缺 yt-dlp：`brew install yt-dlp`');
  if (asr.engine === 'whisper' || (asr.engine === 'auto' && !tools.ready.sensevoice)) {
    if (!tools.whisper.available) hints.push('缺 whisper-cli：`brew install whisper.cpp`');
    if (!tools.models.whisper.available) {
      hints.push(`缺 Whisper 模型：${tools.models.whisper.path}（可从 huggingface.co/ggerganov/whisper.cpp 下 ggml-large-v3-turbo-q5_0.bin）`);
    }
  }
  if (asr.engine === 'sensevoice' || asr.engine === 'auto') {
    if (!tools.sherpa.available) hints.push('缺 sherpa-onnx-offline：解压 k2-fsa/sherpa-onnx 的 osx-arm64 预编译包到 ~/.dsh/video-tools/sherpa-onnx');
    if (!tools.models.sensevoice.available) hints.push('缺 SenseVoice 模型：~/.dsh/video-models/sensevoice/{model.int8.onnx,tokens.txt}');
  }
  return hints;
}

/**
 * 面板用的状态：本机工具链 + 当前引擎是否就绪。`ready` 表示「点一下就能转写」，
 * 只有平台下载能力 + ffmpeg + 至少一个引擎同时具备才为真。
 */
export async function asrStatus(settings, { fresh = false, ai = null, attachments = null } = {}) {
  const asr = asrSettings(settings);
  const tools = await detectToolchain(asr, { fresh });
  const ocr = await ocrStatus({ fresh });
  const vision = await visionStatus(ai, settings, { fresh: fresh || !ai });
  const engine = pickEngine(asr, tools, null);
  const ocrUsable = Boolean(asr.ocrFallback && ocr.available);
  const visionUsable = Boolean(asr.frameMode !== 'ocr' && vision.available && attachments?.saveImages && ai?.llm?.stream);
  const frameUsable = ocrUsable || visionUsable;
  const hints = engine || frameUsable
    ? []
    : missingHints(tools, asr, 'youtube');
  const downloadReady = tools.downloadAvailable;

  return {
    enabled: asr.enabled,
    engine: asr.engine,
    engineLabel: engine?.label ?? (visionUsable ? vision.label : ocrUsable ? ocr.label : null),
    activeEngine: engine?.id ?? (visionUsable ? 'vision' : ocrUsable ? 'ocr' : null),
    ready: Boolean(engine || frameUsable) && downloadReady,
    downloadReady,
    hints,
    privacy: '语音转写与画面文字识别完全在本机运行；画面理解会把抽样的画面图片发给当前模型（会离开本机）；摘要使用当前配置的模型。',
    ocr: { ...ocr, enabled: asr.ocrFallback },
    vision: { ...vision, enabled: asr.frameMode !== 'ocr', ocrFallback: asr.ocrFallback },
    config: {
      threads: asr.threads,
      maxSeconds: asr.maxSeconds,
      keepAudio: asr.keepAudio,
      autoTranscribe: asr.autoTranscribe,
      ocrFallback: asr.ocrFallback,
      ocrIntervalSeconds: asr.ocrIntervalSeconds,
      ocrMaxFrames: asr.ocrMaxFrames,
      frameMode: asr.frameMode,
      visionModel: asr.visionModel,
      visionMaxFrames: asr.visionMaxFrames,
    },
    tools: {
      ffmpeg: tools.ffmpeg,
      ytdlp: tools.ytdlp,
      whisper: tools.whisper,
      sherpa: tools.sherpa,
    },
    models: tools.models,
    engines: tools.engines,
  };
}

/* ---------------------------------- engines -------------------------------- */

function parseWhisperProgress(chunk, onProgress) {
  if (!onProgress) return;
  const match = /progress\s*=\s*(\d+(?:\.\d+)?)%/i.exec(chunk);
  if (match) onProgress({ percent: Math.min(100, Number(match[1])), stage: 'transcribe' });
}

/** whisper.cpp 的 -oj 输出：{result:{language}, transcription:[{offsets:{from,to},text}]}。 */
async function transcribeWhisper({ engine, wav, workdir, asr, signal, onProgress }) {
  const outPrefix = join(workdir, 'whisper');
  const args = ['-m', engine.modelPath, '-f', wav, '-l', 'auto', '-oj', '-of', outPrefix, '-np', '-pp'];
  if (asr.threads > 0) args.push('-t', String(asr.threads));

  await runProcess(engine.binary, args, {
    signal,
    timeoutMs: 90 * 60 * 1000,
    code: 'asr-failed',
    label: 'whisper-cli',
    onStderr: (chunk) => parseWhisperProgress(chunk, onProgress),
  });

  const raw = await readFile(`${outPrefix}.json`, 'utf8').catch(() => '');
  if (!raw.trim()) throw new VideoError('asr-failed', 'whisper-cli 没有输出 JSON');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoError('asr-failed', 'whisper-cli 的 JSON 解析失败');
  }

  const segments = (Array.isArray(parsed.transcription) ? parsed.transcription : [])
    .map((item) => {
      const start = Number(item?.offsets?.from ?? 0) / 1000;
      const end = Number(item?.offsets?.to ?? 0) / 1000;
      return { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : start, text: cleanText(item?.text) };
    })
    .filter((item) => item.text);
  return { segments, lang: normalizeLang(parsed?.result?.language ?? '') };
}

const SENTENCE_END = /[。．.!！?？；;：:…]/;

/**
 * sherpa-onnx 的 SenseVoice 输出一行 JSON：
 * {text, tokens:[...], timestamps:[秒...], lang, emotion, event}
 * 它没有句子级时间戳，所以按标点把 token 分组成段，段的 start 就是第一个 token 的时间。
 */
function senseVoiceSegments(parsed) {
  const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  const timestamps = Array.isArray(parsed?.timestamps) ? parsed.timestamps : [];
  if (!tokens.length) {
    const text = cleanText(parsed?.text);
    return text ? [{ start: 0, end: 0, text }] : [];
  }

  const segments = [];
  let buffer = '';
  let start = Number(timestamps[0]) || 0;
  let last = start;

  const flush = (endHint) => {
    const text = cleanText(buffer);
    if (text) segments.push({ start, end: Math.max(Number(endHint) || last, start + 0.2), text });
    buffer = '';
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] ?? '');
    const stamp = Number(timestamps[index]);
    if (!buffer) start = Number.isFinite(stamp) ? stamp : last;
    buffer += token;
    last = Number.isFinite(stamp) ? stamp : last;
    const next = index + 1 < tokens.length ? String(tokens[index + 1] ?? '') : '';
    const tooLong = buffer.length >= 120 || last - start >= 15;
    if (SENTENCE_END.test(token) || tooLong || !next) flush(last + 0.4);
  }
  return segments;
}

async function transcribeSenseVoice({ engine, wav, workdir, asr, signal }) {
  const args = [
    `--sense-voice-model=${engine.modelPath}`,
    `--tokens=${engine.tokensPath}`,
    '--sense-voice-use-itn=1',
  ];
  if (asr.threads > 0) args.push(`--num-threads=${asr.threads}`);
  args.push(wav);

  const { stdout } = await runProcess(engine.binary, args, {
    signal,
    timeoutMs: 90 * 60 * 1000,
    code: 'asr-failed',
    label: 'sherpa-onnx-offline',
  });

  const jsonLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .pop();
  if (!jsonLine) throw new VideoError('asr-failed', 'SenseVoice 没有输出识别结果');
  let parsed;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    throw new VideoError('asr-failed', 'SenseVoice 结果解析失败');
  }
  return { segments: senseVoiceSegments(parsed), lang: normalizeLang(parsed?.lang) };
}

/* --------------------------------- public ---------------------------------- */

/**
 * 把视频音轨转成带时间戳的文字稿。调用方负责 SSE 进度帧与缓存更新。
 * 返回的 transcript 与平台字幕同构，额外带 `engine` / `tookMs` 供面板展示。
 */
export async function transcribeVideo({ doc, settings, ai = null, attachments = null, onPhase, onProgress, signal, force = false }) {
  const asr = asrSettings(settings);
  if (!asr.enabled) throw new VideoError('asr-disabled', '本地转写已关闭：可以在面板设置里重新打开。');

  if (!force) {
    const cachedTranscript = await readLocalTranscript(doc.docId);
    if (cachedTranscript) return cachedTranscript;
  }

  const tools = await detectToolchain(asr);
  const engine = pickEngine(asr, tools, doc.platform);
  const ocr = asr.ocrFallback ? await ocrStatus() : { available: false };
  const vision = asr.frameMode !== 'ocr' ? await visionStatus(ai, settings) : { available: false };
  const visionUsable = Boolean(vision.available && ai?.llm?.stream && attachments?.saveImages);
  const frameUsable = Boolean(ocr.available) || visionUsable;
  if (!engine && !frameUsable) {
    const hints = missingHints(tools, asr, doc.platform);
    throw new VideoError(
      'asr-unavailable',
      `本机还没有可用的语音识别引擎。${hints.length ? `\n${hints.join('\n')}` : ''}`,
    );
  }

  const workdir = await createWorkdir();
  let keep = false;
  try {
    let transcript = null;
    let audioError = null;

    if (engine) {
      try {
        onPhase?.('正在下载音频…');
        const audio = await downloadAudio({
          url: doc.url,
          platform: doc.platform,
          doc,
          settings,
          workdir,
          signal,
          onProgress: (event) => onProgress?.({ ...event, stage: 'download' }),
        });

        onPhase?.(`音频 ${formatBytes(audio.bytes)}，正在转成 16kHz 单声道…`);
        const wav = await convertToWav({ input: audio.file, workdir, maxSeconds: asr.maxSeconds, signal });

        onPhase?.(
          `正在用 ${engine.label} 识别${asr.maxSeconds > 0 ? `（只转前 ${Math.round(asr.maxSeconds / 60)} 分钟）` : ''}，音频不会离开这台电脑…`,
        );
        onProgress?.({ percent: 0, stage: 'transcribe' });
        const started = Date.now();
        const result = engine.id === 'whisper'
          ? await transcribeWhisper({ engine, wav, workdir, asr, signal, onProgress })
          : await transcribeSenseVoice({ engine, wav, workdir, asr, signal });
        const tookMs = Date.now() - started;

        const segments = result.segments.slice(0, MAX_TRANSCRIPT_SEGMENTS);
        const chars = segments.reduce((sum, item) => sum + item.text.length, 0);
        // whisper 对纯音乐/无对白视频会输出 "*music*" 之类的占位标签，这不算有语音内容，
        // 要让后面的画面文字识别兜底，否则会拿一堆 *music* 去生成总结。
        if (!segments.length || spokenChars(segments) < 8) {
          throw new VideoError('asr-empty', '没有识别出可用的语音（可能是纯音乐 / 无对白视频）');
        }
        // 长视频只截断返回给模型的量；面板仍能拿到完整段落。
        onProgress?.({ percent: 100, stage: 'transcribe' });
        onPhase?.(`识别完成：${segments.length} 段 / ${chars} 字，用时 ${(tookMs / 1000).toFixed(1)}s`);

        if (asr.keepAudio) {
          keep = true;
          await keepAudioCopy(audio.file).catch(() => '');
        }

        transcript = {
          available: true,
          source: engine.source,
          engine: engine.id,
          engineLabel: engine.label,
          lang: result.lang,
          chars,
          segments,
          tookMs,
        };
      } catch (error) {
        // 下载不到音轨、或者整段没有语音（纯音乐/无声视频）时，不直接失败：
        // 退到「画面文字识别」，让这类视频也有可用的文字稿。
        if (signal?.aborted || error?.code === 'aborted') throw error;
        audioError = error;
      }
    }

    if (!transcript && (asr.ocrFallback || asr.frameMode !== 'ocr')) {
      if (audioError) {
        const reason = audioError.code === 'asr-empty' ? '没有识别出语音' : '拿不到音频';
        const target = asr.frameMode === 'ocr'
          ? '抽取画面文字（视频不会离开这台电脑）'
          : '识别画面内容';
        onPhase?.(`${reason}，改为${target}…`);
      }
      transcript = await frameTranscript({
        doc,
        settings,
        workdir,
        tools,
        asr,
        ai,
        attachments,
        onPhase,
        onProgress,
        signal,
      });
    }

    if (!transcript) {
      if (audioError) throw audioError;
      const hints = missingHints(tools, asr, doc.platform);
      throw new VideoError(
        'asr-unavailable',
        `本机还没有可用的语音识别引擎。${hints.length ? `\n${hints.join('\n')}` : ''}`,
      );
    }

    await writeLocalTranscript(doc.docId, transcript);
    return transcript;
  } finally {
    if (!keep) await cleanupWorkdir(workdir);
  }
}

export { DEFAULT_MODELS };
