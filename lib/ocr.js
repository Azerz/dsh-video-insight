/**
 * 画面文字识别（OCR）兜底。
 *
 * 场景：既没有配音、也没有任何字幕的视频（纯音乐、无声演示、只有画面的 vlog、
 * PPT 录屏…）。此时 ASR 拿不到任何语音，只能看画面。做法：
 *   1. yt-dlp 下载一份 480p 以内的视频；
 *   2. ffmpeg 按固定间隔抽帧；
 *   3. 调用 macOS 系统自带的 Vision 框架做离线文字识别（swiftc 编译的小工具，
 *      首次使用时自动编译，之后复用）；
 *   4. 把每帧识别出的文字去噪、去重后拼成带时间戳的「假字幕」，后面的总结、章节、
 *      思维导图、RAG 追问都能直接用。
 *
 * 全程在本机完成：视频帧和识别结果都不会离开这台电脑。
 */

import { join } from 'node:path';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { VideoError } from './util.js';
import {
  TOOLS_DIR,
  downloadVideo,
  runProcess,
} from './media.js';

export const OCR_DIR = join(TOOLS_DIR, 'ocr');
const OCR_BIN = join(OCR_DIR, 'vision-ocr');
const OCR_SRC = join(OCR_DIR, 'vision_ocr.swift');
export const OCR_LABEL = '画面文字（macOS Vision）';

const SWIFT_SOURCE = String.raw`import Foundation
import Vision
import AppKit

// 用法：vision-ocr <image>... —— 逐张识别，输出一个 JSON 数组到 stdout。
// 每张图：{ file, width, height, lines: [{ text, conf, x, y, w, h }] }
let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty {
  FileHandle.standardError.write(Data("usage: vision-ocr <image>...\n".utf8))
  exit(2)
}
var out: [[String: Any]] = []
for path in args {
  var entry: [String: Any] = ["file": path, "lines": []]
  if let img = NSImage(contentsOfFile: path),
     let tiff = img.tiffRepresentation,
     let rep = NSBitmapImageRep(data: tiff),
     let cg = rep.cgImage {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.minimumTextHeight = 0.008
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    var lines: [[String: Any]] = []
    do {
      try handler.perform([request])
      for obs in (request.results ?? []) {
        guard let cand = obs.topCandidates(1).first else { continue }
        lines.append([
          "text": cand.string,
          "conf": Double(cand.confidence),
          "x": Double(obs.boundingBox.origin.x),
          "y": Double(obs.boundingBox.origin.y),
          "w": Double(obs.boundingBox.width),
          "h": Double(obs.boundingBox.height),
        ])
      }
    } catch {
      entry["error"] = String(describing: error)
    }
    entry["width"] = cg.width
    entry["height"] = cg.height
    entry["lines"] = lines
  } else {
    entry["error"] = "image-unreadable"
  }
  out.append(entry)
}
if let data = try? JSONSerialization.data(withJSONObject: out, options: []) {
  FileHandle.standardOutput.write(data)
}
`;

/* --------------------------------- status --------------------------------- */

const statusCache = { at: 0, value: null };

async function isExecutable(path) {
  if (!path) return false;
  try {
    await access(path, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichSwiftc() {
  const candidates = [
    '/usr/bin/swiftc',
    '/opt/homebrew/bin/swiftc',
    '/usr/local/bin/swiftc',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc',
  ];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await isExecutable(candidate)) return candidate;
  }
  return '';
}

async function buildHelper(swiftc) {
  await mkdir(OCR_DIR, { recursive: true });
  await writeFile(OCR_SRC, SWIFT_SOURCE, 'utf8');
  await runProcess(swiftc, ['-O', OCR_SRC, '-o', OCR_BIN], {
    timeoutMs: 5 * 60 * 1000,
    code: 'ocr-build-failed',
    label: 'swiftc（编译文字识别小工具）',
  });
}

/**
 * 画面文字识别是否可用（缓存 30s）。prepare=true 时若还没编译会顺手编译好。
 * 注意：macOS 上首次编译大约 10-20 秒，所以状态接口默认只探测不编译。
 */
export async function ocrStatus({ fresh = false, prepare = false } = {}) {
  const now = Date.now();
  if (!fresh && !prepare && statusCache.value && now - statusCache.at < 30_000) return statusCache.value;

  let available = false;
  let reason = '';
  let note = '';
  if (process.platform !== 'darwin') {
    reason = '画面文字识别目前只支持 macOS（用的是系统 Vision 框架）。';
  } else if (await isExecutable(OCR_BIN)) {
    available = true;
  } else {
    const swiftc = await whichSwiftc();
    if (!swiftc) {
      reason = '没有找到 swiftc（Xcode Command Line Tools），无法启用画面文字识别。';
    } else if (prepare) {
      try {
        await buildHelper(swiftc);
        available = await isExecutable(OCR_BIN);
        if (!available) reason = '文字识别小工具编译后仍不可执行。';
      } catch (error) {
        reason = `编译文字识别小工具失败：${String(error?.message ?? error).slice(0, 300)}`;
      }
    } else {
      available = true;
      note = '首次使用时会自动编译一次系统文字识别小工具（约 10-20 秒）。';
    }
  }

  const value = {
    available,
    label: OCR_LABEL,
    binaryPath: OCR_BIN,
    platform: process.platform,
    reason,
    note,
  };
  statusCache.at = now;
  statusCache.value = value;
  return value;
}

export function invalidateOcrStatus() {
  statusCache.at = 0;
  statusCache.value = null;
}

/* -------------------------------- pipeline -------------------------------- */

/** ffmpeg 按固定间隔抽帧，最多 maxFrames 张。返回 [{ file, seconds }]。 */
export async function extractFrames({ ffmpeg, video, workdir, intervalSeconds = 8, maxFrames = 120, signal } = {}) {
  if (!ffmpeg) throw new VideoError('ocr-no-ffmpeg', '没有可用的 ffmpeg，无法抽帧。');
  const pattern = join(workdir, 'frame-%04d.jpg');
  const fps = Math.max(1, Math.round(Number(intervalSeconds) || 8));
  const vf = `fps=1/${fps},scale='min(1280,iw)':-2`;
  await runProcess(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-vf', vf,
    '-frames:v', String(Math.max(1, Math.min(600, Math.round(Number(maxFrames) || 120)))),
    '-q:v', '3',
    pattern,
  ], {
    signal,
    timeoutMs: 30 * 60 * 1000,
    code: 'ocr-frames-failed',
    label: 'ffmpeg 抽帧',
  });
  const names = (await readdir(workdir))
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort();
  return names.map((name, index) => ({
    file: join(workdir, name),
    seconds: Math.round(index * fps),
  }));
}

const NOISE = /^(播放|暂停|自动|倍速|高清|标清|超清|蓝光|流畅|弹幕|关闭|开启|全屏|网页全屏|发送|评论|投币|收藏|分享|关注|已关注|点赞|点踩|举报|设置|更多|登录|注册|bilibili|哔哩哔哩|YouTube|订阅|稍后观看|播放列表|字幕|观看|次观看|观看次数|频道|搜索|超清|连播|小窗|画中画|下载|客户端|打开|APP|返回|刷新)$/i;

/** 把一帧里的识别结果过滤成可用文字行。 */
function usefulLines(lines) {
  const out = [];
  const seen = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    if (/^[\d\s:.,%℃°+\-/\\|()[\]{}<>《》"'!?！？。，、…·]+$/.test(text)) continue;
    if (NOISE.test(text)) continue;
    if (Number(line?.conf) < 0.2) continue;
    if (/^[◎▶▮▼▲•·|@#*=_~^]+$/.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

/** 分块调用识别小工具（避免一次塞太多文件），并回报进度。 */
export async function recognizeFrames({ binary, frames, signal, onProgress } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (!list.length) return [];
  if (!binary) throw new VideoError('ocr-unavailable', '画面文字识别小工具不可用。');
  const recognized = new Map();
  const chunkSize = 24;
  for (let offset = 0; offset < list.length; offset += chunkSize) {
    // eslint-disable-next-line no-await-in-loop
    const slice = list.slice(offset, offset + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { stdout } = await runProcess(binary, slice.map((frame) => frame.file), {
      signal,
      timeoutMs: 10 * 60 * 1000,
      code: 'ocr-failed',
      label: '画面文字识别',
    });
    let parsed = [];
    try {
      parsed = JSON.parse(String(stdout || '[]'));
    } catch {
      parsed = [];
    }
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (!item || !item.file) continue;
      recognized.set(item.file, usefulLines(item.lines));
    }
    onProgress?.({ percent: Math.round((Math.min(list.length, offset + slice.length) / list.length) * 100), stage: 'ocr' });
  }
  return list.map((frame) => ({ ...frame, lines: recognized.get(frame.file) ?? [] }));
}

/** 把逐帧文字拼成带时间戳的段落：连续相同文字合并，空帧跳过。 */
export function framesToSegments(frames, intervalSeconds = 8) {
  const span = Math.max(1, Math.round(Number(intervalSeconds) || 8));
  const segments = [];
  for (const frame of Array.isArray(frames) ? frames : []) {
    const text = (frame.lines ?? []).join(' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!text) continue;
    const last = segments[segments.length - 1];
    if (last && last.text === text) {
      last.end = frame.seconds + span;
      continue;
    }
    segments.push({ start: frame.seconds, end: frame.seconds + span, text });
  }
  // 字幕段落不能有重叠（下游 renderTimestamped / RAG 都假设有序不重叠）。
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].end > segments[i + 1].start) segments[i].end = segments[i + 1].start;
  }
  return segments.filter((item) => item.end > item.start);
}

/**
 * 下载一份低清视频并按固定间隔抽帧（OCR 与画面理解共用，避免重复下载）。
 * 返回 `{ video, frames, intervalSeconds }`。
 */
export async function captureFrames({
  doc,
  settings = {},
  workdir,
  tools,
  asr = {},
  onPhase,
  onProgress,
  signal,
  maxFrames: frameLimit = 0,
  intervalSeconds: intervalOverride = 0,
} = {}) {
  if (!tools?.ytdlp?.available) {
    throw new VideoError('ocr-needs-ytdlp', '画面识别需要用 yt-dlp 下载视频：请先 `brew install yt-dlp`。');
  }
  if (!tools?.ffmpeg?.available) {
    throw new VideoError('ocr-no-ffmpeg', '画面识别需要用 ffmpeg 抽帧：请先 `brew install ffmpeg`。');
  }

  const intervalSeconds = intervalOverride > 0
    ? Math.round(intervalOverride)
    : Math.max(3, Math.min(60, Math.round(Number(asr.ocrIntervalSeconds) || 8)));
  const hardLimit = Math.max(20, Math.min(240, Math.round(Number(asr.ocrMaxFrames) || 120)));
  const maxFrames = frameLimit > 0
    ? Math.max(4, Math.min(hardLimit, Math.round(frameLimit)))
    : hardLimit;

  onPhase?.('正在下载一份低清视频用来抽帧…');
  const video = await downloadVideo({
    url: doc.url,
    platform: doc.platform,
    tools,
    workdir,
    cookie: settings.bilibiliCookie,
    onProgress: (event) => onProgress?.({ ...event, stage: 'download' }),
    signal,
  });

  onPhase?.(`正在每 ${intervalSeconds} 秒抽一帧（最多 ${maxFrames} 帧）…`);
  const frames = await extractFrames({
    ffmpeg: tools.ffmpeg.path,
    video: video.file,
    workdir,
    intervalSeconds,
    maxFrames,
    signal,
  });
  if (!frames.length) throw new VideoError('ocr-empty', '没有抽到任何画面帧（视频可能无法解码）。');
  return { video, frames, intervalSeconds };
}

/**
 * 无配音/无字幕时的兜底：下载低清视频 → 抽帧 → 本机 OCR → 假字幕。
 * 返回的 transcript 结构与本地转写一致（source='frame-ocr'）。
 */
export async function ocrVideo({ doc, settings = {}, workdir, tools, asr = {}, onPhase, onProgress, signal, maxFrames: frameLimit = 0 } = {}) {
  const status = await ocrStatus({ fresh: true, prepare: true });
  if (!status.available) {
    throw new VideoError('ocr-unavailable', `画面文字识别不可用：${status.reason || '未知原因'}`);
  }
  const started = Date.now();

  onPhase?.('没有语音内容，改为抽取画面文字（视频不会离开这台电脑）…');
  const { frames, intervalSeconds } = await captureFrames({
    doc,
    settings,
    workdir,
    tools,
    asr,
    onPhase,
    onProgress,
    signal,
    maxFrames: frameLimit,
  });

  onPhase?.(`正在识别 ${frames.length} 帧里的画面文字（本机 Vision）…`);
  const recognized = await recognizeFrames({ binary: status.binaryPath, frames, signal, onProgress });
  const segments = framesToSegments(recognized, intervalSeconds);
  const chars = segments.reduce((sum, item) => sum + item.text.length, 0);
  if (!segments.length || chars < 8) {
    throw new VideoError('asr-empty', '这个视频既没有语音，画面里也没有识别到可用的文字（可能是纯音乐/纯画面视频）。');
  }

  const tookMs = Date.now() - started;
  onPhase?.(`画面文字识别完成：${segments.length} 段 / ${chars} 字，用时 ${(tookMs / 1000).toFixed(1)}s`);
  onProgress?.({ percent: 100, stage: 'ocr' });
  return {
    available: true,
    source: 'frame-ocr',
    engine: 'vision-ocr',
    engineLabel: OCR_LABEL,
    lang: 'auto',
    chars,
    segments: segments.slice(0, 6000),
    tookMs,
    frames: frames.length,
  };
}
