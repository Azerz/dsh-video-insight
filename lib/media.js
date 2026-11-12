/**
 * 音频素材层：把「某个视频的声音」变成一段 16kHz 单声道 wav。
 *
 * 依赖的都是本机已有 / 用户自己装的命令行工具，插件不打包二进制：
 *  - `yt-dlp`：从 YouTube / 哔哩哔哩把 bestaudio 下下来（YouTube 的媒体 URL
 *    有 768KB 级别的分段签名预算，自己实现分片下载既慢又容易 403，交给 yt-dlp
 *    最稳）；
 *  - `ffmpeg`：转成 whisper / sherpa-onnx 都吃的 16kHz 单声道 PCM；
 *  - `whisper-cli`（brew install whisper.cpp）与 `sherpa-onnx-offline`
 *    （k2-fsa 的 macOS 预编译包）是两种识别引擎，见 asr.js。
 *
 * 所有函数都是「找得到就用、找不到就抛 VideoError」，由上层给出可读提示。
 */

import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { DESKTOP_UA, VideoError } from './util.js';

export const TOOLS_DIR = join(homedir(), '.dsh', 'video-tools');
export const MODELS_DIR = join(homedir(), '.dsh', 'video-models');

/** 默认安装位置；用户可以在插件配置里覆盖。 */
export const DEFAULT_BINARIES = {
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'],
  ffprobe: ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'],
  ytdlp: [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    join(homedir(), '.local', 'bin', 'yt-dlp'),
    join(TOOLS_DIR, 'yt-dlp'),
  ],
  whisper: [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    join(TOOLS_DIR, 'whisper-cli'),
  ],
  sherpa: [
    join(TOOLS_DIR, 'sherpa-onnx', 'bin', 'sherpa-onnx-offline'),
    '/opt/homebrew/bin/sherpa-onnx-offline',
    '/usr/local/bin/sherpa-onnx-offline',
  ],
};

export const DEFAULT_MODELS = {
  whisper: join(MODELS_DIR, 'ggml-large-v3-turbo-q5_0.bin'),
  sensevoiceModel: join(MODELS_DIR, 'sensevoice', 'model.int8.onnx'),
  sensevoiceTokens: join(MODELS_DIR, 'sensevoice', 'tokens.txt'),
};

const toolchainCache = { at: 0, value: null };

async function isExecutable(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path) {
  if (!path) return false;
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function pathCandidates(name, explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  list.push(...(DEFAULT_BINARIES[name] ?? []));
  const searchPath = process.env.PATH ?? '';
  for (const dir of searchPath.split(delimiter)) {
    if (dir) list.push(join(dir, name === 'ytdlp' ? 'yt-dlp' : name));
  }
  return [...new Set(list)];
}

/** 找一个可执行文件；显式路径优先，其次默认位置，最后扫 PATH。 */
export async function findBinary(kind, explicit = '') {
  const candidates = kind === 'sherpa'
    ? [explicit, ...(DEFAULT_BINARIES.sherpa ?? [])].filter(Boolean)
    : pathCandidates(kind, explicit);
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return '';
}

/**
 * 探测本机工具链（带 30s 缓存，/status 会被频繁调用）。
 * `asrAvailable` 表达「能凑出一套识别引擎」：Whisper 或 SenseVoice 任一就绪即可。
 */
export async function detectToolchain(asr = {}, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && toolchainCache.value && now - toolchainCache.at < 30_000) return toolchainCache.value;

  const [ffmpeg, ffprobe, ytdlp, whisper, sherpa] = await Promise.all([
    findBinary('ffmpeg', asr.ffmpegPath),
    findBinary('ffprobe', asr.ffprobePath),
    findBinary('ytdlp', asr.ytdlpPath),
    findBinary('whisper', asr.whisperBinaryPath),
    findBinary('sherpa', asr.sherpaBinaryPath),
  ]);

  const whisperModel = String(asr.whisperModelPath || DEFAULT_MODELS.whisper);
  const sensevoiceModel = String(asr.sensevoiceModelPath || DEFAULT_MODELS.sensevoiceModel);
  const sensevoiceTokens = String(asr.sensevoiceTokensPath || DEFAULT_MODELS.sensevoiceTokens);

  const [whisperModelOk, sensevoiceModelOk, sensevoiceTokensOk] = await Promise.all([
    isFile(whisperModel),
    isFile(sensevoiceModel),
    isFile(sensevoiceTokens),
  ]);

  const whisperReady = Boolean(whisper && whisperModelOk);
  const sensevoiceReady = Boolean(sherpa && sensevoiceModelOk && sensevoiceTokensOk);

  const value = {
    platform: process.platform,
    ffmpeg: { available: Boolean(ffmpeg), path: ffmpeg },
    ffprobe: { available: Boolean(ffprobe), path: ffprobe },
    ytdlp: { available: Boolean(ytdlp), path: ytdlp },
    whisper: { available: Boolean(whisper), path: whisper },
    sherpa: { available: Boolean(sherpa), path: sherpa },
    models: {
      whisper: { path: whisperModel, available: whisperModelOk },
      sensevoice: {
        modelPath: sensevoiceModel,
        tokensPath: sensevoiceTokens,
        available: sensevoiceModelOk && sensevoiceTokensOk,
      },
    },
    engines: {
      whisper: { available: whisperReady, label: 'Whisper（whisper.cpp）' },
      sensevoice: { available: sensevoiceReady, label: 'SenseVoice（sherpa-onnx）' },
    },
    ready: { whisper: whisperReady, sensevoice: sensevoiceReady },
    asrAvailable: whisperReady || sensevoiceReady,
    downloadAvailable: Boolean(ytdlp),
    convertAvailable: Boolean(ffmpeg),
  };

  toolchainCache.at = now;
  toolchainCache.value = value;
  return value;
}

export function invalidateToolchain() {
  toolchainCache.at = 0;
  toolchainCache.value = null;
}

/* ------------------------------- process glue ------------------------------ */

/**
 * 跑一个子进程并把输出收集起来。`signal` 中止时整棵进程树一起收掉。
 * 失败抛 VideoError，message 里带 stderr 尾巴，面板能直接显示。
 */
export function runProcess(command, args, {
  signal,
  timeoutMs = 30 * 60 * 1000,
  onStdout,
  onStderr,
  code = 'tool-failed',
  label = command,
  env,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new VideoError(code, `${label} 不可用`));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(env ?? {}) },
      });
    } catch (error) {
      reject(new VideoError(code, `无法启动 ${label}：${error?.message ?? error}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1000, timeoutMs));

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
      onStdout?.(chunk, stdout);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
      onStderr?.(chunk, stderr);
    });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    child.on('error', (error) => {
      finish(new VideoError(code, `运行 ${label} 失败：${error?.message ?? error}`));
    });

    child.on('close', (exitCode, exitSignal) => {
      if (timedOut) {
        finish(new VideoError(`${code}-timeout`, `${label} 超时（${Math.round(timeoutMs / 1000)}s）`));
        return;
      }
      if (signal?.aborted) {
        finish(new VideoError('aborted', '已取消'));
        return;
      }
      if (exitCode === 0) {
        finish(null);
        return;
      }
      const tail = stderr.trim().split('\n').slice(-6).join('\n').slice(-1200);
      finish(new VideoError(code, `${label} 退出码 ${exitCode}${exitSignal ? `（${exitSignal}）` : ''}${tail ? `：${tail}` : ''}`));
    });
  });
}

/* ------------------------------ audio pipeline ----------------------------- */

function normalizeCookieHeader(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.includes('=') ? item : `${item}=`))
    .join('; ');
}

function ytdlpProgress(chunk, onProgress) {
  if (!onProgress) return;
  const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(chunk);
  if (match) onProgress({ percent: Math.min(100, Number(match[1])) });
}

async function pickDownloaded(workdir, prefix = 'audio.') {
  const names = await readdir(workdir);
  const name = names.find((item) => item.startsWith(prefix));
  return name ? join(workdir, name) : '';
}

/**
 * 用 yt-dlp 拉 bestaudio。yt-dlp 自己处理签名、分片与限速，比手写可靠。
 * B 站有 Cookie 时一并带上，部分稿件不带 Cookie 会只给 360P 音频或直接要登录。
 */
export async function downloadWithYtdlp({ url, platform, tools, workdir, cookie, onProgress, signal }) {
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--newline', '-f', 'bestaudio/best', '-o', join(workdir, 'audio.%(ext)s'), url];
  if (platform === 'bilibili') {
    const normalized = normalizeCookieHeader(cookie);
    args.push('--add-header', 'Referer: https://www.bilibili.com/');
    args.push('--add-header', `User-Agent: ${DESKTOP_UA}`);
    if (normalized) args.push('--add-header', `Cookie: ${normalized}`);
  }
  await runProcess(tools.ytdlp.path, args, {
    signal,
    timeoutMs: 20 * 60 * 1000,
    code: 'asr-download-failed',
    label: 'yt-dlp',
    onStderr: (chunk) => ytdlpProgress(chunk, onProgress),
    onStdout: (chunk) => ytdlpProgress(chunk, onProgress),
  });
  const file = await pickDownloaded(workdir);
  if (!file) throw new VideoError('asr-download-failed', 'yt-dlp 没有产出音频文件');
  const info = await stat(file);
  return { file, bytes: info.size };
}

/**
 * 用 yt-dlp 下载一份低清视频（给「无语音、无字幕 → 抽帧 OCR」用）。
 * 只取 480p 以内的画面流，不合并音轨，够 ffmpeg 抽帧即可。
 */
export async function downloadVideo({ url, platform, tools, workdir, cookie, onProgress, signal, maxHeight = 480 }) {
  if (!tools?.ytdlp?.available) {
    throw new VideoError('ocr-needs-ytdlp', '画面文字识别需要 yt-dlp 下载视频：请先 `brew install yt-dlp`。');
  }
  const height = Math.max(120, Math.min(1080, Math.round(Number(maxHeight) || 480)));
  const format = `bv*[height<=${height}]/b[height<=${height}]/b`;
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--newline', '-f', format, '-o', join(workdir, 'video.%(ext)s'), url];

  if (platform === 'bilibili') {
    const normalized = normalizeCookieHeader(cookie);
    args.push('--add-header', 'Referer: https://www.bilibili.com/');
    args.push('--add-header', `User-Agent: ${DESKTOP_UA}`);
    if (normalized) args.push('--add-header', `Cookie: ${normalized}`);
  }
  await runProcess(tools.ytdlp.path, args, {
    signal,
    timeoutMs: 20 * 60 * 1000,
    code: 'ocr-download-failed',
    label: 'yt-dlp（抽帧用视频）',
    onStderr: (chunk) => ytdlpProgress(chunk, onProgress),
    onStdout: (chunk) => ytdlpProgress(chunk, onProgress),
  });
  const names = await readdir(workdir);
  const name = names.find((item) => item.startsWith('video.'));
  if (!name) throw new VideoError('ocr-download-failed', 'yt-dlp 没有产出视频文件（可能无法下载画面）');
  const file = join(workdir, name);
  const info = await stat(file);
  if (!info.size) throw new VideoError('ocr-download-failed', '下载到的视频文件为空');
  return { file, bytes: info.size };
}

/** 哔哩哔哩免登录兜底：playurl 直接给 DASH 音频 URL，单次 GET 即可（没有 YouTube 那种分段预算）。 */
async function downloadBilibiliDirect({ doc, settings, workdir, signal }) {
  const bvid = String(doc?.id ?? doc?.bvid ?? '');
  const cid = String(doc?.pages?.[0]?.cid ?? doc?.cid ?? '');
  if (!bvid || !cid) throw new VideoError('asr-download-failed', '缺少 bvid / cid，无法直接取 B 站音频');
  const { request } = await import('./util.js');
  const cookie = normalizeCookieHeader(settings?.bilibiliCookie);
  const headers = {
    'user-agent': DESKTOP_UA,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    ...(cookie ? { cookie } : {}),
  };
  const api = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16&fourk=1`;
  const payload = await request(api, { headers, timeoutMs: 15000 }).then((res) => JSON.parse(res.text));
  if (payload?.code !== 0) throw new VideoError('asr-download-failed', `B 站 playurl 返回 ${payload?.code}：${payload?.message ?? '未知错误'}`);
  const audios = Array.isArray(payload?.data?.dash?.audio) ? payload.data.dash.audio : [];
  const best = audios.sort((a, b) => (Number(b?.bandwidth) || 0) - (Number(a?.bandwidth) || 0))[0];
  const audioUrl = best?.baseUrl ?? best?.base_url;
  if (!audioUrl) throw new VideoError('asr-download-failed', 'B 站没有返回音频流');
  const target = join(workdir, 'audio.m4s');
  const response = await fetch(audioUrl, { headers, signal });
  if (!response.ok || !response.body) throw new VideoError('asr-download-failed', `下载 B 站音频失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const info = await stat(target);
  if (!info.size) throw new VideoError('asr-download-failed', 'B 站音频为空');
  return { file: target, bytes: info.size };
}

export async function downloadAudio({ url, platform, doc, settings, workdir, onProgress, signal }) {
  const asr = settings?.asr ?? {};
  const tools = await detectToolchain(asr);
  if (tools.ytdlp.available) {
    return downloadWithYtdlp({
      url,
      platform,
      tools,
      workdir,
      cookie: settings?.bilibiliCookie,
      onProgress,
      signal,
    });
  }
  if (platform === 'bilibili') return downloadBilibiliDirect({ doc, settings, workdir, signal });
  throw new VideoError(
    'asr-needs-ytdlp',
    '要本地转写 YouTube 音频需要 yt-dlp：`brew install yt-dlp`（哔哩哔哩可以直接取音频，但装了 yt-dlp 更稳）。',
  );
}

/** 16kHz 单声道 wav —— whisper.cpp / sherpa-onnx 都吃这个格式。 */
export async function convertToWav({ input, workdir, maxSeconds = 0, signal }) {
  const asr = {};
  const tools = await detectToolchain(asr);
  if (!tools.ffmpeg.available) throw new VideoError('asr-needs-ffmpeg', '要转音频需要 ffmpeg：`brew install ffmpeg`');
  const output = join(workdir, 'audio.16k.wav');
  const args = ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
  if (Number(maxSeconds) > 0) args.push('-t', String(Math.round(Number(maxSeconds))));
  args.push(output);
  await runProcess(tools.ffmpeg.path, args, {
    signal,
    timeoutMs: 10 * 60 * 1000,
    code: 'asr-convert-failed',
    label: 'ffmpeg',
  });
  const info = await stat(output).catch(() => null);
  if (!info?.size) throw new VideoError('asr-convert-failed', 'ffmpeg 没有产出 wav（音频可能为空）');
  return output;
}

export async function createWorkdir() {
  return mkdtemp(join(tmpdir(), 'dsh-video-asr-'));
}

export async function cleanupWorkdir(workdir) {
  if (!workdir) return;
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

/** 调试用：把音频另存到 ~/.dsh/video-models/last-audio.*（仅 keepAudio 时）。 */
export async function keepAudioCopy(input) {
  const target = join(MODELS_DIR, `last-audio${input.slice(input.lastIndexOf('.'))}`);
  const { copyFile, mkdir } = await import('node:fs/promises');
  await mkdir(MODELS_DIR, { recursive: true });
  await copyFile(input, target).catch(() => {});
  return target;
}

/** 没有 yt-dlp 时也不要报得太难看 —— 用 fetch 直接落盘（B 站兜底之外的通用小工具）。 */
export async function downloadUrlToFile(url, target, { headers = {}, signal } = {}) {
  const response = await fetch(url, { headers, signal });
  if (!response.ok || !response.body) throw new VideoError('asr-download-failed', `下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  await writeFile(`${target}.ok`, '');
  return target;
}
