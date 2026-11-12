/**
 * dsh-video host 半 · 哔哩哔哩
 *
 * 取数分三档，取到什么就如实标什么，不伪造登录态：
 *  1. 视频元信息：`/x/web-interface/view` 免登录可用；
 *  2. 字幕：`/x/player/wbi/v2`（wbi 签名）返回 CC 字幕与 AI 字幕的地址，
 *     字幕 JSON 在 `subtitle_url` 指向的 CDN 上；**需要登录 Cookie**（SESSDATA）；
 *  3. B 站官方 AI 总结：`/x/web-interface/view/conclusion/get`（wbi 签名），同样需要 Cookie。
 *
 * 没 Cookie 时视频照样能解析，只是拿不到字幕/官方总结 —— 面板会据 warnings 引导用户去设置。
 */

import { createHash } from 'node:crypto';

import {
  DESKTOP_UA,
  MOBILE_UA,
  VideoError,
  absoluteUrl,
  createCache,
  isoFromSeconds,
  request,
  requestJson,
} from './util.js';

const API = 'https://api.bilibili.com';
const WEB_REFERER = 'https://www.bilibili.com/';

/** B 站 wbi 的固定混淆表，官方前端里就是这一段。 */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const wbiCache = createCache({ ttlMs: 20 * 60 * 1000, limit: 4 });

/** 风控兜底：没有 buvid3 的请求更容易吃 -352，用它自己发的指纹补上。 */
const fingerprintCache = createCache({ ttlMs: 60 * 60 * 1000, limit: 2 });

const BV_PATTERN = /BV[0-9A-Za-z]{10}/;
const AV_PATTERN = /(?:^|[^0-9a-zA-Z])av(\d{1,12})(?:[^0-9]|$)/i;

/**
 * 链接归一化：支持完整 URL、BV 号、av 号、b23.tv 短链、m.bilibili.com、
 * 以及分享文案里夹着的链接（B 站 App 的分享串）。
 */
export async function normalizeBilibiliInput(input, { timeoutMs = 20000 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new VideoError('bad-url', '没有拿到视频链接');

  const direct = BV_PATTERN.exec(raw);
  if (direct) {
    return { bvid: direct[0], page: readPageParam(raw) };
  }
  const av = AV_PATTERN.exec(raw);
  if (av) {
    return { aid: Number(av[1]), page: readPageParam(raw) };
  }

  const shortCode = /(?:b23\.tv|bili2233\.cn)\/([A-Za-z0-9]+)/.exec(raw);
  if (shortCode) {
    const shortUrl = `https://b23.tv/${shortCode[1]}`;
    let landed;
    try {
      const response = await request(shortUrl, {
        timeoutMs,
        headers: { referer: WEB_REFERER, 'user-agent': MOBILE_UA },
        maxBytes: 256 * 1024,
      });
      landed = response.url;
    } catch (error) {
      throw new VideoError('fetch-failed', `短链展开失败：${error?.message ?? error}`, { cause: error });
    }
    const bv = BV_PATTERN.exec(landed);
    if (bv) return { bvid: bv[0], page: readPageParam(landed, raw) };
    const landedAv = AV_PATTERN.exec(landed);
    if (landedAv) return { aid: Number(landedAv[1]), page: readPageParam(landed, raw) };
    throw new VideoError('bad-url', `短链没有指向视频页：${landed}`);
  }

  throw new VideoError('bad-url', `无法识别的 B 站链接：${raw.slice(0, 80)}`);
}

function readPageParam(...sources) {
  for (const source of sources) {
    const match = /[?&]p=(\d{1,3})/.exec(String(source ?? ''));
    if (match) return Math.max(1, Number(match[1]));
  }
  return 1;
}

/* ------------------------------- 基础请求头 ------------------------------- */

async function fingerprintCookie(timeoutMs) {
  const cached = fingerprintCache.get('buvid');
  if (cached) return cached;
  try {
    const json = await requestJson(`${API}/x/frontend/finger/spi`, {
      timeoutMs: Math.min(timeoutMs, 8000),
      headers: { referer: WEB_REFERER },
    });
    const value = json?.data ?? {};
    const cookie = [value.b_3 ? `buvid3=${value.b_3}` : '', value.b_4 ? `buvid4=${value.b_4}` : '']
      .filter(Boolean)
      .join('; ');
    if (cookie) fingerprintCache.set('buvid', cookie);
    return cookie;
  } catch {
    return '';
  }
}

/** 把用户粘贴的 Cookie 串成请求头：容忍只填 `SESSDATA=xxx`，也容忍整段 document.cookie。 */
export function normalizeCookie(rawCookie) {
  const text = String(rawCookie ?? '').trim();
  if (!text) return '';
  return text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.includes('=') ? part : `${part}=`))
    .join('; ');
}

async function bilibiliHeaders(settings, { mobile = false } = {}) {
  const cookie = normalizeCookie(settings?.cookie);
  const fingerprint = cookie.includes('buvid3=') ? '' : await fingerprintCookie(settings?.timeoutMs);
  return {
    'user-agent': mobile ? MOBILE_UA : DESKTOP_UA,
    referer: WEB_REFERER,
    origin: 'https://www.bilibili.com',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    ...(cookie || fingerprint ? { cookie: [cookie, fingerprint].filter(Boolean).join('; ') } : {}),
  };
}

/* --------------------------------- wbi 签名 -------------------------------- */

/** nav 接口即使未登录（code -101）也会给 `data.wbi_img`，签名只需要它。 */
async function wbiMixinKey(settings) {
  const cached = wbiCache.get('mixin');
  if (cached) return cached;
  const headers = await bilibiliHeaders(settings);
  const nav = await requestJson(`${API}/x/web-interface/nav`, {
    timeoutMs: settings?.timeoutMs ?? 20000,
    headers,
  });
  const image = nav?.data?.wbi_img?.img_url ?? '';
  const sub = nav?.data?.wbi_img?.sub_url ?? '';
  const pick = (url) => url.split('/').pop()?.split('.')[0] ?? '';
  const rawKey = `${pick(image)}${pick(sub)}`;
  if (rawKey.length < 32) {
    throw new VideoError('bad-response', 'B 站 wbi 签名密钥获取失败（nav 接口没有返回 wbi_img）');
  }
  const mixin = MIXIN_TABLE.map((index) => rawKey[index] ?? '').join('').slice(0, 32);
  wbiCache.set('mixin', mixin);
  return mixin;
}

function signWbi(params, mixin) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key] ?? '').replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/* --------------------------------- 元信息 --------------------------------- */

async function fetchVideoView(settings, target) {
  const headers = await bilibiliHeaders(settings);
  const query = target.bvid ? `bvid=${target.bvid}` : `aid=${target.aid}`;
  const json = await requestJson(`${API}/x/web-interface/view?${query}`, {
    timeoutMs: settings?.timeoutMs ?? 20000,
    headers,
  });
  if (json?.code !== 0) {
    const code = json?.code;
    if (code === -404) throw new VideoError('not-found', '视频不存在或已删除');
    if (code === -403) throw new VideoError('not-found', '视频不可见（可能是私有或地区限制）');
    if (code === -352) {
      throw new VideoError('blocked', 'B 站风控拦截（-352），稍后重试，或在设置里填 Cookie');
    }
    throw new VideoError('fetch-failed', `B 站接口返回 ${code}：${json?.message ?? '未知错误'}`);
  }
  return json.data;
}

/* --------------------------------- 字幕 ---------------------------------- */

async function fetchSubtitleMeta(settings, { bvid, aid, cid }) {
  const mixin = await wbiMixinKey(settings);
  const headers = await bilibiliHeaders(settings);
  const params = bvid ? { bvid, cid } : { aid, cid };
  const query = signWbi(params, mixin);
  const json = await requestJson(`${API}/x/player/wbi/v2?${query}`, {
    timeoutMs: settings?.timeoutMs ?? 20000,
    headers,
  });
  if (json?.code !== 0) {
    if (json?.code === -352) throw new VideoError('blocked', 'B 站风控拦截（-352）');
    // 拿不到字幕不致命：外层会降级成「无字幕」并给提示。
    return { subtitles: [], viewPoints: [], error: `player/v2 返回 ${json?.code}` };
  }
  const data = json.data ?? {};
  return {
    subtitles: Array.isArray(data.subtitle?.subtitles) ? data.subtitle.subtitles : [],
    subtitleType: data.subtitle?.subtitle_position ?? null,
    viewPoints: Array.isArray(data.view_points) ? data.view_points : [],
  };
}

function pickSubtitle(subtitles) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
  const usable = subtitles.filter((item) => typeof item?.subtitle_url === 'string' && item.subtitle_url);
  if (usable.length === 0) return null;
  const isAuto = (item) => /自动|auto|AI/i.test(`${item?.lan_doc ?? ''}${item?.lan ?? ''}`) || Number(item?.type) === 1;
  const rank = (item) => {
    const lan = String(item?.lan ?? '').toLowerCase();
    let score = 0;
    if (lan.startsWith('zh')) score += 100;
    else if (lan.startsWith('en')) score += 40;
    if (!isAuto(item)) score += 20;
    return score;
  };
  return [...usable].sort((a, b) => rank(b) - rank(a))[0];
}

async function fetchSubtitleJson(settings, subtitle) {
  const url = absoluteUrl(subtitle.subtitle_url);
  if (!url) throw new VideoError('bad-response', '字幕地址不合法');
  const headers = await bilibiliHeaders(settings);
  const json = await requestJson(url, {
    timeoutMs: settings?.timeoutMs ?? 20000,
    headers: { ...headers, referer: 'https://www.bilibili.com/' },
  });
  const body = Array.isArray(json?.body) ? json.body : [];
  const segments = body
    .map((line) => ({
      start: Number(line?.from) || 0,
      end: Number(line?.to) || 0,
      text: String(line?.content ?? '').trim(),
    }))
    .filter((line) => line.text)
    .sort((a, b) => a.start - b.start);
  return { segments, lang: subtitle.lan ?? 'zh-CN', auto: /自动|auto|AI/i.test(`${subtitle.lan_doc ?? ''}`) };
}

/* ------------------------------- 官方 AI 总结 ------------------------------ */

async function fetchOfficialSummary(settings, { bvid, cid, upMid }) {
  try {
    const mixin = await wbiMixinKey(settings);
    const headers = await bilibiliHeaders(settings);
    const query = signWbi({ bvid, cid, up_mid: upMid }, mixin);
    const json = await requestJson(`${API}/x/web-interface/view/conclusion/get?${query}`, {
      timeoutMs: settings?.timeoutMs ?? 20000,
      headers,
    });
    if (json?.code !== 0) return null;
    const model = json?.data?.model_result;
    if (!model) return null;
    const summary = String(model.summary ?? '').trim();
    if (!summary) return null;
    const outline = Array.isArray(model.outline)
      ? model.outline.map((item) => ({
          title: String(item?.title ?? '').trim(),
          start: Number(item?.timestamp) || 0,
        })).filter((item) => item.title)
      : [];
    return { summary, outline };
  } catch {
    // 官方总结是加分项：接口报错、没权限都不影响主流程。
    return null;
  }
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * @param {{cookie?:string, timeoutMs?:number}} settings
 * @param {string} input 用户粘贴的链接 / BV 号 / av 号 / 短链
 * @returns {Promise<object>} CONTRACT.md 里的 VideoDoc
 */
export async function resolveBilibili(settings, input) {
  const target = await normalizeBilibiliInput(input, { timeoutMs: settings?.timeoutMs ?? 20000 });
  const view = await fetchVideoView(settings, target);
  const bvid = view.bvid ?? target.bvid;
  const aid = view.aid ?? target.aid;
  const pages = Array.isArray(view.pages) ? view.pages : [];
  const pageIndex = Math.min(Math.max(target.page ?? 1, 1), Math.max(pages.length, 1));
  const currentPage = pages[pageIndex - 1] ?? null;
  const cid = currentPage?.cid ?? view.cid;
  const upMid = view.owner?.mid;
  const hasCookie = Boolean(normalizeCookie(settings?.cookie));

  const warnings = [];
  let subtitleMeta = { subtitles: [], viewPoints: [] };
  let officialSummary = null;

  if (hasCookie) {
    try {
      subtitleMeta = await fetchSubtitleMeta(settings, { bvid, aid, cid });
    } catch (error) {
      warnings.push(`字幕接口出错：${error?.message ?? error}`);
    }
    officialSummary = await fetchOfficialSummary(settings, { bvid, cid, upMid });
    if (!officialSummary) {
      warnings.push('这个视频没有 B 站官方 AI 总结（不是每个视频都有）。');
    }
  }

  let transcript = { available: false, source: 'none', lang: '', chars: 0, segments: [] };
  const picked = pickSubtitle(subtitleMeta.subtitles);
  if (picked) {
    try {
      const loaded = await fetchSubtitleJson(settings, picked);
      if (loaded.segments.length > 0) {
        transcript = {
          available: true,
          source: loaded.auto ? 'bilibili-ai-subtitle' : 'bilibili-subtitle',
          lang: picked.lan_doc || picked.lan || loaded.lang,
          chars: loaded.segments.reduce((sum, line) => sum + line.text.length, 0),
          segments: loaded.segments,
        };
      }
    } catch (error) {
      warnings.push(`字幕文件下载失败：${error?.message ?? error}`);
    }
  }

  if (!transcript.available) {
    if (!hasCookie) {
      warnings.push('未登录 B 站：拿不到 AI 字幕和官方 AI 总结。点右上「设置」粘贴一次 Cookie，之后解析就有字幕了。');
    } else if (subtitleMeta.subtitles.length === 0) {
      warnings.push('这个视频没有可用字幕：UP 主没上传 CC，B 站也没有给它生成 AI 字幕。分析会只基于标题和简介。');
    }
  }

  const duration = Number(currentPage?.duration ?? view.duration ?? 0);
  const officialChapters = [];
  if (pages.length > 1) {
    let cursor = 0;
    for (const page of pages) {
      officialChapters.push({ title: `P${page.page}: ${page.part ?? ''}`.trim(), start: cursor });
      cursor += Number(page.duration) || 0;
    }
  }

  return {
    platform: 'bilibili',
    docId: `bilibili:${bvid}`,
    id: String(bvid),
    url: `https://www.bilibili.com/video/${bvid}${pageIndex > 1 ? `?p=${pageIndex}` : ''}`,
    title: String(view.title ?? '').trim(),
    author: String(view.owner?.name ?? '').trim(),
    authorAvatar: absoluteUrl(view.owner?.face),
    cover: absoluteUrl(view.pic),
    duration,
    publishedAt: isoFromSeconds(view.pubdate),
    description: String(view.desc ?? '').trim(),
    stats: {
      views: Number(view.stat?.view) || 0,
      likes: Number(view.stat?.like) || 0,
      comments: Number(view.stat?.reply) || 0,
      favorites: Number(view.stat?.favorite) || 0,
      danmaku: Number(view.stat?.danmaku) || 0,
    },
    pages: pages.map((page, index) => ({
      index: index + 1,
      title: String(page.part ?? '').trim(),
      duration: Number(page.duration) || 0,
    })),
    officialChapters,
    transcript,
    officialSummary,
    warnings,
  };
}
