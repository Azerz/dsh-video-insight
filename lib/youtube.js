/**
 * dsh-video host 半 · YouTube
 *
 * 取数路径（都是浏览器之外、无需 API key 的公开端点）：
 *  1. 抓 watch 页，从 `ytInitialPlayerResponse` 拿元信息 + 内嵌的 INNERTUBE_API_KEY；
 *  2. WEB 版的 timedtext 字幕地址现在已经返回空 body，所以字幕改走
 *     `youtubei/v1/player` 的 ANDROID client —— 它返回的 captionTracks 里的
 *     baseUrl 仍然能下载（XML format=3 或 json3，两种都解析）；
 *  3. 章节：从 watch 页的 `ytInitialData` 里找 macroMarkers（作者手工章节）。
 */

import {
  DESKTOP_UA,
  VideoError,
  absoluteUrl,
  createCache,
  decodeEntities,
  extractJsonObject,
  request,
} from './util.js';

const WATCH_URL = 'https://www.youtube.com/watch';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const playerCache = createCache({ ttlMs: 10 * 60 * 1000, limit: 16 });

/** 从各种形态的输入里取 11 位视频 id。 */
export function normalizeYoutubeInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new VideoError('bad-url', '没有拿到视频链接');
  if (YT_ID.test(raw)) return { videoId: raw };

  const patterns = [
    /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*?&)?v=([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|youtube-nocookie\.com)\/shorts\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|youtube-nocookie\.com)\/live\/([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match) return { videoId: match[1] };
  }
  throw new VideoError('bad-url', `无法识别的 YouTube 链接：${raw.slice(0, 80)}`);
}

function browserHeaders() {
  return {
    'user-agent': DESKTOP_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // 欧盟同意页会挡住 watch 页的正文，直接声明已同意。
    cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+917; SOCS=CAI',
  };
}

/** 从页面脚本里抠 `ytInitialPlayerResponse = {...}` / `"ytInitialPlayerResponse":{...}`。 */
function readPlayerResponse(html) {
  const markers = ['"ytInitialPlayerResponse":', 'ytInitialPlayerResponse =', 'ytInitialPlayerResponse='];
  for (const marker of markers) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const brace = html.indexOf('{', at + marker.length);
    if (brace < 0) continue;
    const parsed = extractJsonObject(html, brace);
    if (parsed) return parsed;
  }
  return null;
}

function readInitialData(html) {
  const markers = ['var ytInitialData = ', 'var ytInitialData=', '"ytInitialData":'];
  for (const marker of markers) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const brace = html.indexOf('{', at + marker.length);
    if (brace < 0) continue;
    const parsed = extractJsonObject(html, brace);
    if (parsed) return parsed;
  }
  return null;
}

/** INNERTUBE_API_KEY 之类的内联常量：`"INNERTUBE_API_KEY":"AIza..."`。 */
function inlineString(html, name) {
  const pattern = new RegExp(`"${name}":"([^"]+)"`);
  return pattern.exec(html)?.[1] ?? null;
}

/* ------------------------------ ANDROID 播放器 ----------------------------- */

async function androidPlayer({ videoId, apiKey, visitorData, timeoutMs }) {
  if (!apiKey) return null;
  const body = {
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 30,
        hl: 'zh-CN',
        gl: 'US',
        utcOffsetMinutes: 480,
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const headers = {
    'content-type': 'application/json',
    'user-agent': ANDROID_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'x-youtube-client-name': '3',
    'x-youtube-client-version': '20.10.38',
    ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
  };
  const { status, text } = await request(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
    },
  );
  if (status < 200 || status >= 300) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* --------------------------------- 字幕 ----------------------------------- */

function captionTracksOf(player) {
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

function pickTrack(tracks) {
  const usable = tracks.filter((track) => typeof track?.baseUrl === 'string' && track.baseUrl);
  if (usable.length === 0) return null;
  const isAsr = (track) => String(track?.kind ?? '') === 'asr' || /自动|auto-generated/i.test(String(track?.name?.simpleText ?? ''));
  const rank = (track) => {
    const code = String(track?.languageCode ?? '').toLowerCase();
    let score = 0;
    if (code.startsWith('zh')) score += 100;
    else if (code.startsWith('en')) score += 40;
    if (!isAsr(track)) score += 20;
    return score;
  };
  return [...usable].sort((a, b) => rank(b) - rank(a))[0];
}

/** timedtext 的两种返回都要吃：XML format=3 的 <p t=… d=…> 和 json3 的 events[].segs。 */
export function parseCaptions(body) {
  const text = String(body ?? '').trim();
  if (!text) return [];

  if (text.startsWith('{') || text.startsWith('[')) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const events = Array.isArray(json?.events) ? json.events : [];
    const segments = [];
    for (const event of events) {
      const chunks = Array.isArray(event?.segs) ? event.segs : [];
      const line = chunks.map((chunk) => chunk?.utf8 ?? '').join('');
      const clean = cleanCaption(line);
      if (!clean) continue;
      const start = (Number(event.tStartMs) || 0) / 1000;
      const end = start + (Number(event.dDurationMs) || 0) / 1000;
      segments.push({ start, end, text: clean });
    }
    return dropOverlaps(segments);
  }

  const segments = [];
  const pattern = /<(?:p|text)\b([^>]*)>([\s\S]*?)<\/(?:p|text)>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const attrs = match[1];
    const rawStart = /(?:^|\s)t="([\d.]+)"/.exec(attrs)?.[1];
    const rawDur = /(?:^|\s)d="([\d.]+)"/.exec(attrs)?.[1];
    const altStart = /(?:^|\s)start="([\d.]+)"/.exec(attrs)?.[1];
    const altDur = /(?:^|\s)dur="([\d.]+)"/.exec(attrs)?.[1];
    // <p> 用毫秒，<text> 用秒，这里统一成秒。
    const start = rawStart != null ? Number(rawStart) / 1000 : Number(altStart) || 0;
    const duration = rawDur != null ? Number(rawDur) / 1000 : Number(altDur) || 0;
    const line = cleanCaption(decodeEntities(match[2].replace(/<[^>]+>/g, '')));
    if (!line) continue;
    segments.push({ start, end: start + duration, text: line });
  }
  return dropOverlaps(segments);
}

function cleanCaption(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\u200b\ufeff]+/g, '')
    .trim();
}

/** YouTube 的字幕滚动条窗口会重复上一句；时间轴重叠的只留更长的那条。 */
function dropOverlaps(segments) {
  const sorted = segments.filter((segment) => segment.text).sort((a, b) => a.start - b.start);
  const result = [];
  for (const segment of sorted) {
    const last = result[result.length - 1];
    if (last && segment.start < last.end - 0.05) {
      if (segment.text.length > last.text.length) result[result.length - 1] = segment;
      continue;
    }
    result.push(segment);
  }
  return result;
}

async function downloadCaptions(track, timeoutMs) {
  const { status, text } = await request(track.baseUrl, {
    timeoutMs,
    maxBytes: 8 * 1024 * 1024,
    headers: {
      'user-agent': DESKTOP_UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: 'https://www.youtube.com/',
    },
  });
  if (status < 200 || status >= 300) {
    throw new VideoError('fetch-failed', `字幕下载失败 HTTP ${status}`);
  }
  return parseCaptions(text);
}

/* -------------------------------- 手工章节 -------------------------------- */

function walkNodes(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walkNodes(item, visit, depth + 1);
    return;
  }
  for (const value of Object.values(node)) walkNodes(value, visit, depth + 1);
}

function textOf(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.simpleText === 'string') return value.simpleText.trim();
  if (Array.isArray(value.runs)) return value.runs.map((run) => run?.text ?? '').join('').trim();
  return '';
}

function parseClock(value) {
  const parts = String(value ?? '').split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function readChapters(initialData) {
  const chapters = [];
  walkNodes(initialData, (node) => {
    const renderer = node?.macroMarkersListItemRenderer;
    if (!renderer) return;
    const title = textOf(renderer.title) || textOf(renderer.headline);
    const start = parseClock(textOf(renderer.timeDescription));
    if (!title || start == null) return;
    chapters.push({ title, start });
  });
  if (chapters.length === 0) return [];
  const seen = new Set();
  return chapters
    .sort((a, b) => a.start - b.start)
    .filter((chapter) => {
      const key = `${chapter.start}:${chapter.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * @param {{timeoutMs?:number, transcriptLimitChars?:number}} settings
 * @param {string} input
 * @returns {Promise<object>} CONTRACT.md 里的 VideoDoc
 */
export async function resolveYoutube(settings, input) {
  const { videoId } = normalizeYoutubeInput(input);
  const timeoutMs = settings?.timeoutMs ?? 20000;
  const cached = playerCache.get(videoId);

  let page = cached;
  if (!page) {
    const watchUrl = `${WATCH_URL}?v=${videoId}&hl=zh-CN&has_verified=1&bpctr=9999999999`;
    let html;
    try {
      const response = await request(watchUrl, {
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        headers: browserHeaders(),
      });
      if (response.status === 404) throw new VideoError('not-found', 'YouTube 视频不存在或已删除');
      html = response.text;
    } catch (error) {
      if (error instanceof VideoError && error.code === 'not-found') throw error;
      throw new VideoError(
        'fetch-failed',
        `打不开 YouTube 页面（可能需要代理）：${error?.message ?? error}`,
        { cause: error },
      );
    }

    const player = readPlayerResponse(html);
    if (!player) {
      throw new VideoError('fetch-failed', '没能在 YouTube 页面里找到播放器数据（页面结构变了或被拦截）');
    }
    page = {
      player,
      initialData: readInitialData(html),
      apiKey: inlineString(html, 'INNERTUBE_API_KEY'),
      clientVersion: inlineString(html, 'INNERTUBE_CLIENT_VERSION'),
      visitorData: player?.responseContext?.visitorData ?? inlineString(html, 'VISITOR_DATA'),
      html,
    };
    playerCache.set(videoId, page);
  }

  // WEB 版 captionTracks 的 baseUrl 现在下载回来是空 body，字幕必须走 ANDROID client；
  // 元信息反而优先用 WEB（字段更全、带 microformat 与章节），ANDROID 只做兜底。
  if (page.android === undefined) {
    try {
      page.android = await androidPlayer({
        videoId,
        apiKey: page.apiKey,
        visitorData: page.visitorData,
        timeoutMs,
      });
    } catch {
      page.android = null;
    }
  }
  const android = page.android;
  const androidOk = android?.playabilityStatus?.status === 'OK';

  const webStatus = page.player?.playabilityStatus?.status;
  if (!androidOk && webStatus && webStatus !== 'OK') {
    const reason = String(page.player?.playabilityStatus?.reason ?? '');
    if (webStatus === 'LOGIN_REQUIRED') {
      throw new VideoError('not-found', `YouTube 限制观看：${reason || '需要登录或年龄验证'}`);
    }
    if (webStatus === 'ERROR' || webStatus === 'UNPLAYABLE') {
      throw new VideoError('not-found', `YouTube 无法播放：${reason || '视频已删除或地区限制'}`);
    }
  }

  let tracks = androidOk ? captionTracksOf(android) : [];
  if (tracks.length === 0) tracks = captionTracksOf(page.player);

  const details = page.player?.videoDetails ?? (androidOk ? android.videoDetails : null) ?? {};
  const micro =
    page.player?.microformat?.playerMicroformatRenderer ??
    android?.microformat?.playerMicroformatRenderer ??
    {};
  const title = String(details.title ?? '').trim();
  if (!title) {
    throw new VideoError('not-found', '这个 YouTube 视频拿不到标题，可能已删除或受限');
  }

  const warnings = [];
  let transcript = { available: false, source: 'none', lang: '', chars: 0, segments: [] };
  const track = pickTrack(tracks);
  if (track) {
    try {
      const segments = await downloadCaptions(track, timeoutMs);
      if (segments.length > 0) {
        const asr = String(track.kind ?? '') === 'asr' || /自动|auto-generated/i.test(String(track.name?.simpleText ?? ''));
        const limit = Math.max(2000, Number(settings?.transcriptLimitChars) || 60000);
        let kept = segments;
        let chars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
        if (chars > limit) {
          let used = 0;
          kept = [];
          for (const segment of segments) {
            if (used + segment.text.length > limit) break;
            kept.push(segment);
            used += segment.text.length;
          }
          chars = used;
          warnings.push(`字幕共 ${segments.length} 段，超出长度上限，只取前 ${kept.length} 段。`);
        }
        transcript = {
          available: true,
          source: asr ? 'youtube-asr' : 'youtube-caption',
          lang: track.languageCode ?? '',
          chars,
          segments: kept,
        };
      }
    } catch (error) {
      warnings.push(`字幕下载失败：${error?.message ?? error}`);
    }
  }

  if (!transcript.available) {
    warnings.push('这个 YouTube 视频没有可用字幕：作者没上传 CC，也没开自动字幕。分析会只基于标题和简介。');
  }

  const thumbs = micro?.thumbnail?.thumbnails;
  const cover =
    (Array.isArray(thumbs) && thumbs.length > 0 ? absoluteUrl(thumbs[thumbs.length - 1]?.url) : null) ??
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const chapters = page.initialData ? readChapters(page.initialData) : [];

  return {
    platform: 'youtube',
    docId: `youtube:${videoId}`,
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    author: String(details.author ?? micro?.ownerChannelName ?? '').trim(),
    authorAvatar: null,
    cover,
    duration: Number(details.lengthSeconds) || 0,
    publishedAt: micro?.publishDate ? new Date(micro.publishDate).toISOString() : null,
    description: String(details.shortDescription ?? '').trim(),
    stats: { views: Number(details.viewCount) || 0 },
    pages: [],
    officialChapters: chapters,
    transcript,
    officialSummary: null,
    warnings,
  };
}
