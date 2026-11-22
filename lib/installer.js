/**
 * dsh-video host 半 · 本机组件「一键安装」
 *
 * 只下载「便携版」二进制到 `~/.dsh/video-tools/` 下，不碰系统包管理器：
 * - ffmpeg / ffprobe：ffmpeg-static 的预编译包（macOS arm64/x64、Windows x64）
 * - yt-dlp：官方单文件二进制
 * - whisper-cli：whisper.cpp 的 Windows 预编译包（macOS/Linux 用 Homebrew 更省事，这里只给提示）
 * - sherpa-onnx：官方 static-no-tts 预编译包
 *
 * 下载完自动把路径写进 asr 配置（ffmpegPath / ffprobePath / ytdlpPath /
 * whisperBinaryPath / sherpaBinaryPath），面板不用再手填。
 */

import { createGunzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { VideoError } from './util.js';
import { invalidateToolchain, runProcess, TOOLS_DIR } from './media.js';

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

export const INSTALL_DIR = join(TOOLS_DIR, 'bin');
const SHERPA_DIR = join(TOOLS_DIR, 'sherpa-onnx');
const WHISPER_DIR = join(TOOLS_DIR, 'whisper');

/** 已知可用的兜底版本（GitHub API 不可达时用）。 */
const FALLBACK = {
  ffmpegStatic: 'b6.1.1',
  whisper: 'b5454',
  sherpa: 'v2.0.2',
};

function platformTag() {
  if (WIN) return `win32-${ARCH}`;
  if (process.platform === 'darwin') return `darwin-${ARCH}`;
  return `linux-${ARCH}`;
}

/** Windows 上 whisper.cpp 预编译包的可选后端（模型文件与后端无关，换的是二进制）。 */
const WHISPER_VARIANTS = {
  'win32-x64': [
    { id: 'cpu', label: 'CPU（AVX2 / AVX512）', asset: 'whisper-bin-x64.zip', bytes: 8_000_000, note: '所有机器都能用，速度最慢' },
    { id: 'cuda-12.4', label: 'NVIDIA CUDA 12.4', asset: 'whisper-bin-win-cuda-12.4.0-x64.zip', bytes: 250_000_000, note: '需要 NVIDIA 显卡与 CUDA 12.4 运行库' },
    { id: 'cuda-11.8', label: 'NVIDIA CUDA 11.8', asset: 'whisper-bin-win-cuda-11.8.0-x64.zip', bytes: 250_000_000, note: '老驱动/老 CUDA 环境选这个' },
  ],
  'win32-arm64': [
    { id: 'cpu', label: 'CPU', asset: 'whisper-bin-win-cpu-arm64.zip', bytes: 8_000_000, note: '所有机器都能用' },
    { id: 'cuda-13.5', label: 'NVIDIA CUDA 13.5', asset: 'whisper-bin-win-cuda-13.5-arm64.zip', bytes: 250_000_000, note: '需要 NVIDIA 显卡与 CUDA 13.5 运行库' },
    { id: 'opencl', label: 'OpenCL（Adreno 核显）', asset: 'whisper-bin-win-opencl-adreno-arm64.zip', bytes: 20_000_000, note: '高通 Adreno 核显加速' },
  ],
};

export function whisperVariants(platform = process.platform, arch = process.arch) {
  const tag = platform === 'win32' ? `win32-${arch === 'arm64' ? 'arm64' : 'x64'}` : `${platform}-${arch}`;
  return WHISPER_VARIANTS[tag] ?? [];
}

/** 读显卡名称（仅 Windows 有自动检测；其它平台返回空数组）。 */
export async function detectGpus() {
  if (!WIN) return [];
  try {
    const { stdout } = await runProcess(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
      { timeoutMs: 8000, label: '检测显卡' },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4);
  } catch {
    return [];
  }
}

/** 根据显卡名称推荐后端：NVIDIA → CUDA（x64 默认 12.4），其余 → CPU。 */
export function suggestWhisperBackend(gpus = [], arch = process.arch) {
  const hasNvidia = gpus.some((name) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name));
  if (!hasNvidia) return 'cpu';
  return arch === 'arm64' ? 'cuda-13.5' : 'cuda-12.4';
}

function whisperVariant(backend) {
  const variants = whisperVariants();
  if (variants.length === 0) return null;
  const wanted = String(backend || 'auto');
  if (wanted === 'auto') return null;
  return variants.find((item) => item.id === wanted) ?? null;
}

function sherpaAssetPattern() {
  if (WIN) return new RegExp(`sherpa-onnx-v[\\d.]+-win-${ARCH}-static-MT-Release-no-tts\\.tar\\.bz2$`);
  if (process.platform === 'darwin') return new RegExp(`sherpa-onnx-v[\\d.]+-osx-${ARCH}-static-no-tts\\.tar\\.bz2$`);
  return new RegExp(`sherpa-onnx-v[\\d.]+-linux-${ARCH}-static-no-tts\\.tar\\.bz2$`);
}

async function ghLatestAsset(repo, matcher, fallbackUrl) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-video-insight' },
    });
    if (response.ok) {
      const releases = await response.json();
      for (const release of Array.isArray(releases) ? releases : []) {
        for (const asset of release.assets ?? []) {
          if (matcher(asset.name)) {
            return { url: asset.browser_download_url, name: asset.name, size: asset.size, tag: release.tag_name };
          }
        }
      }
    }
  } catch {
    // 忽略：下面用兜底地址
  }
  return fallbackUrl ? { url: fallbackUrl, name: '', size: 0 } : null;
}

async function downloadToFile({ url, dest, onProgress, signal }) {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal });
  } catch (error) {
    throw new VideoError('install-download-failed', `下载失败：${error?.message ?? error}`);
  }
  if (!response.ok || !response.body) throw new VideoError('install-download-failed', `下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const reader = response.body.getReader();
  const source = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        received += value.length;
        onProgress?.({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
        this.push(Buffer.from(value));
      } catch (error) {
        this.destroy(error);
      }
    },
  });
  try {
    await pipeline(source, createWriteStream(part, { mode: 0o600 }));
  } catch (error) {
    await rm(part, { force: true }).catch(() => {});
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    throw new VideoError('install-download-failed', `下载中断：${error?.message ?? error}`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(part, dest);
      return received;
    } catch (error) {
      if (attempt === 4) {
        await rm(dest, { force: true }).catch(() => {});
        try {
          await rename(part, dest);
          return received;
        } catch {
          await rm(part, { force: true }).catch(() => {});
          throw new VideoError('install-download-failed', `保存失败：${error?.message ?? error}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new VideoError('install-download-failed', '保存失败。');
}

async function gunzip({ src, dest, onProgress, signal }) {
  await mkdir(dirname(dest), { recursive: true });
  const total = (await stat(src)).size;
  let received = 0;
  const source = createWriteStream(dest, { mode: 0o755 });
  const reader = (await import('node:fs')).createReadStream(src);
  reader.on('data', (chunk) => {
    received += chunk.length;
    onProgress?.({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
  });
  await pipeline(reader, createGunzip(), source);
  await chmod(dest, 0o755).catch(() => {});
  if (signal?.aborted) throw new VideoError('aborted', '已取消。');
}

async function extractArchive({ archive, dest, signal }) {
  await mkdir(dest, { recursive: true });
  try {
    await runProcess('tar', ['-xf', archive, '-C', dest], {
      timeoutMs: 10 * 60_000,
      label: `解压 ${archive.split(/[\\/]/).pop()}`,
      code: 'install-extract-failed',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    throw error;
  }
}

async function findExecutable(dir, names, depth = 3) {
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const item = queue.shift();
    if (item.depth > depth) continue;
    for (const name of names) {
      const candidate = join(item.dir, name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          await chmod(candidate, 0o755).catch(() => {});
          return candidate;
        }
      } catch {
        // 继续找
      }
    }
    let entries = [];
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }
  return '';
}

function ffmpegStaticUrl(kind) {
  const tag = FALLBACK.ffmpegStatic;
  const plat = WIN ? `win32-${ARCH}` : `darwin-${ARCH}`;
  return `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/${kind}-${plat}.gz`;
}

/** 每个组件在当前平台上的安装方式（供面板展示 + 执行）。 */
export function componentPlan(asr = {}, { gpus = [], suggested = '' } = {}) {
  const variants = whisperVariants();
  const backend = String(asr.whisperBackend || 'auto');
  const activeBackend = backend === 'auto' ? suggested || 'auto' : backend;
  const activeVariant = variants.find((item) => item.id === activeBackend) ?? null;
  const items = [
    { id: 'ffmpeg', label: 'ffmpeg', method: 'download', bytes: WIN ? 29_000_000 : 19_000_000, path: asr.ffmpegPath || '' },
    { id: 'ffprobe', label: 'ffprobe', method: 'download', bytes: WIN ? 29_000_000 : 19_000_000, path: asr.ffprobePath || '' },
    { id: 'ytdlp', label: 'yt-dlp', method: 'download', bytes: 37_000_000, path: asr.ytdlpPath || '' },
    {
      id: 'whisper',
      label: 'whisper-cli',
      method: WIN ? 'download' : 'brew',
      bytes: WIN ? activeVariant?.bytes ?? 8_000_000 : 0,
      path: asr.whisperBinaryPath || '',
      backend,
      activeBackend,
      variants,
      gpus,
      suggested,
    },
    { id: 'sherpa', label: 'sherpa-onnx', method: 'download', bytes: WIN ? 240_000_000 : 246_000_000, path: asr.sherpaBinaryPath || '' },
  ];
  return items.map((item) => ({
    ...item,
    platform: platformTag(),
    hint: item.method === 'brew'
      ? 'macOS/Linux 上推荐 `brew install whisper.cpp`（或改用 SenseVoice 引擎）'
      : '',
  }));
}

/**
 * 安装一个组件。返回 `{ id, path }`，调用方负责把 path 写进 asr 配置。
 */
export async function installComponent({ id, asr = {}, backend = 'auto', onProgress, signal }) {
  if (!['ffmpeg', 'ffprobe', 'ytdlp', 'whisper', 'sherpa'].includes(id)) {
    throw new VideoError('bad-component', `未知组件：${id}`);
  }
  if (id === 'whisper' && !WIN) {
    throw new VideoError('install-needs-brew', 'macOS/Linux 请用 Homebrew 安装：brew install whisper.cpp');
  }

  const progress = (event) => onProgress?.({ component: id, ...event });

  if (id === 'ffmpeg' || id === 'ffprobe') {
    const dest = join(INSTALL_DIR, `${id}${EXE}`);
    const gz = `${dest}.gz`;
    await downloadToFile({ url: ffmpegStaticUrl(id), dest: gz, signal, onProgress: (event) => progress({ stage: 'download', ...event }) });
    await gunzip({ src: gz, dest, signal, onProgress: (event) => progress({ stage: 'extract', ...event }) });
    await rm(gz, { force: true });
    return { id, path: dest };
  }

  if (id === 'ytdlp') {
    const dest = join(INSTALL_DIR, `yt-dlp${EXE}`);
    const url = WIN
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : process.platform === 'darwin'
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    await downloadToFile({ url, dest, signal, onProgress: (event) => progress({ stage: 'download', ...event }) });
    await chmod(dest, 0o755).catch(() => {});
    return { id, path: dest };
  }

  if (id === 'whisper') {
    const variants = whisperVariants();
    if (variants.length === 0) throw new VideoError('install-unavailable', '当前平台没有 whisper.cpp 预编译包');
    const gpus = await detectGpus();
    const wanted = String(backend || 'auto');
    const resolved = wanted === 'auto' ? suggestWhisperBackend(gpus) : wanted;
    const variant = whisperVariant(resolved) ?? variants[0];
    progress({ stage: 'resolve', backend: variant.id, label: variant.label });
    const asset = await ghLatestAsset(
      'ggml-org/whisper.cpp',
      (name) => name === variant.asset,
      `https://github.com/ggml-org/whisper.cpp/releases/download/${FALLBACK.whisper}/${variant.asset}`,
    );
    const zip = join(INSTALL_DIR, 'whisper-bin.zip');
    await downloadToFile({ url: asset.url, dest: zip, signal, onProgress: (event) => progress({ stage: 'download', ...event }) });
    await rm(WHISPER_DIR, { recursive: true, force: true }).catch(() => {});
    await extractArchive({ archive: zip, dest: WHISPER_DIR, signal });
    await rm(zip, { force: true });
    const found = await findExecutable(WHISPER_DIR, ['whisper-cli.exe', 'whisper-cli', 'main.exe']);
    if (!found) throw new VideoError('install-extract-failed', '压缩包里没找到 whisper-cli');
    return { id, path: found, backend: variant.id };
  }

  // sherpa-onnx
  const asset = await ghLatestAsset(
    'k2-fsa/sherpa-onnx',
    (name) => sherpaAssetPattern().test(name),
    `https://github.com/k2-fsa/sherpa-onnx/releases/download/${FALLBACK.sherpa}/${process.platform === 'darwin' ? `sherpa-onnx-${FALLBACK.sherpa}-osx-${ARCH}-static-no-tts` : `sherpa-onnx-${FALLBACK.sherpa}-win-${ARCH}-static-MT-Release-no-tts`}.tar.bz2`,
  );
  if (!asset) throw new VideoError('install-unavailable', '当前平台没有找到 sherpa-onnx 预编译包');
  const archive = join(INSTALL_DIR, 'sherpa-onnx.tar.bz2');
  await downloadToFile({ url: asset.url, dest: archive, signal, onProgress: (event) => progress({ stage: 'download', ...event }) });
  await rm(SHERPA_DIR, { recursive: true, force: true }).catch(() => {});
  await extractArchive({ archive, dest: SHERPA_DIR, signal });
  await rm(archive, { force: true });
  const found = await findExecutable(SHERPA_DIR, [`sherpa-onnx-offline${EXE}`, 'sherpa-onnx-offline']);
  if (!found) throw new VideoError('install-extract-failed', '压缩包里没找到 sherpa-onnx-offline');
  return { id, path: found };
}

/** 组件装完把路径写回 asr 配置（只写该组件对应的键）。 */
export function configPatchFor(id, path, backend = '') {
  if (id === 'ffmpeg') return { ffmpegPath: path };
  if (id === 'ffprobe') return { ffprobePath: path };
  if (id === 'ytdlp') return { ytdlpPath: path };
  if (id === 'whisper') return backend ? { whisperBinaryPath: path, whisperBackend: backend } : { whisperBinaryPath: path };
  if (id === 'sherpa') return { sherpaBinaryPath: path };
  return {};
}

export function refreshToolchainCache() {
  invalidateToolchain();
}

export const HOME_TOOLS = TOOLS_DIR || join(homedir(), '.dsh', 'video-tools');
