/**
 * dsh-video host 半 · 本地模型下载
 *
 * 插件本身不打包模型（几百 MB，放 npm 里不合适），所以：
 * - 第一次用到本地转写时，如果模型不在，面板可以调用这里「一键下载」；
 * - 下载位置取配置里的 `whisperModelPath` / `sensevoiceModelPath` /
 *   `sensevoiceTokensPath`，没配就用 `~/.dsh/video-models` 下的默认位置。
 *
 * 下载完先写 `.part` 再 rename（Windows 上 rename 偶发被占用，带退避重试）。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VideoError } from './util.js';
import { DEFAULT_MODELS, invalidateToolchain } from './media.js';

/** 每个模型由哪些文件组成（url / 期望字节数 / 落到哪个配置键）。 */
export const MODEL_CATALOG = {
  whisper: {
    id: 'whisper',
    label: 'Whisper large-v3-turbo（q5_0，约 574 MB）',
    files: [
      {
        key: 'whisperModelPath',
        fallback: DEFAULT_MODELS.whisper,
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
        bytes: 574041195,
      },
    ],
  },
  sensevoice: {
    id: 'sensevoice',
    label: 'SenseVoice small（int8，约 240 MB）',
    files: [
      {
        key: 'sensevoiceModelPath',
        fallback: DEFAULT_MODELS.sensevoiceModel,
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
        bytes: 239233841,
      },
      {
        key: 'sensevoiceTokensPath',
        fallback: DEFAULT_MODELS.sensevoiceTokens,
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
        bytes: 315894,
      },
    ],
  },
};

export const MODEL_IDS = Object.keys(MODEL_CATALOG);

async function fileBytes(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

/** 解析某个模型各文件的实际目标路径（配置优先，其次默认目录）。 */
export function modelFiles(asr, id) {
  const entry = MODEL_CATALOG[id];
  if (!entry) return null;
  return entry.files.map((file) => ({
    ...file,
    path: String(asr?.[file.key] || file.fallback),
  }));
}

/** 模型清单 + 每个文件是否存在/大小，给面板画状态。 */
export async function modelsStatus(asr) {
  const out = {};
  for (const id of MODEL_IDS) {
    const files = modelFiles(asr, id);
    const checked = await Promise.all(
      files.map(async (file) => ({ ...file, exists: (await fileBytes(file.path)) >= 0, actualBytes: await fileBytes(file.path) })),
    );
    out[id] = {
      id,
      label: MODEL_CATALOG[id].label,
      available: checked.every((file) => file.exists && file.actualBytes > 0),
      files: checked.map((file) => ({
        key: file.key,
        path: file.path,
        expectedBytes: file.bytes,
        actualBytes: Math.max(0, file.actualBytes),
        exists: file.exists && file.actualBytes > 0,
      })),
    };
  }
  return out;
}

async function downloadFile({ url, path, expectedBytes, onProgress, signal }) {
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  await rm(part, { force: true });

  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal });
  } catch (error) {
    throw new VideoError('model-download-failed', `模型下载失败（${url}）：${error?.message ?? error}`);
  }
  if (!response.ok || !response.body) {
    throw new VideoError('model-download-failed', `模型下载失败：HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || expectedBytes || 0;
  let received = 0;
  const stream = createWriteStream(part, { mode: 0o600 });
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
    await pipeline(source, stream);
  } catch (error) {
    await rm(part, { force: true }).catch(() => {});
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    throw new VideoError('model-download-failed', `模型下载中断：${error?.message ?? error}`);
  }

  // Windows 上 rename 偶尔被占用：退避重试，最后再删旧文件重试一次。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(part, path);
      return { path, bytes: received };
    } catch (error) {
      if (attempt === 4) {
        await rm(path, { force: true }).catch(() => {});
        try {
          await rename(part, path);
          return { path, bytes: received };
        } catch {
          await rm(part, { force: true }).catch(() => {});
          throw new VideoError('model-download-failed', `模型文件保存失败：${error?.message ?? error}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new VideoError('model-download-failed', '模型文件保存失败。');
}

/**
 * 下载一个模型（whisper / sensevoice）。已存在的文件默认跳过，`force` 时重下。
 * @param {{ asr: object, id: string, force?: boolean, onProgress?: (event) => void, signal?: AbortSignal }} options
 */
export async function downloadModel({ asr, id, force = false, onProgress, signal }) {
  const files = modelFiles(asr, id);
  if (!files) throw new VideoError('bad-model', `未知模型：${id}`);

  const status = await modelsStatus(asr);
  const targets = files.filter((file) => force || !status[id].files.find((item) => item.key === file.key)?.exists);
  if (targets.length === 0) return { id, downloaded: [], skipped: files.map((file) => file.path) };

  const totalBytes = targets.reduce((sum, file) => sum + (file.bytes || 0), 0) || 1;
  let doneBytes = 0;
  const downloaded = [];
  for (const file of targets) {
    if (signal?.aborted) throw new VideoError('aborted', '已取消。');
    onProgress?.({ stage: 'download', model: id, file: file.path, percent: Math.round((doneBytes / totalBytes) * 100), received: doneBytes, total: totalBytes });
    const result = await downloadFile({
      url: file.url,
      path: file.path,
      expectedBytes: file.bytes,
      signal,
      onProgress: (event) => {
        const base = doneBytes;
        const percent = totalBytes
          ? Math.min(100, Math.round(((base + (event.total ? (event.received / event.total) * (file.bytes || event.total) : 0)) / totalBytes) * 100))
          : null;
        onProgress?.({ stage: 'download', model: id, file: file.path, percent, received: event.received, total: event.total });
      },
    });
    doneBytes += result.bytes;
    downloaded.push(result);
  }
  invalidateToolchain();
  return { id, downloaded, skipped: [] };
}
