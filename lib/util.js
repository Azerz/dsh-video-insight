/**
 * dsh-video host 半 · 小工具集
 *
 * 只做四件事：带超时的 HTTP 抓取（文本 / JSON）、HTML 实体解码、
 * 秒数格式化、几个安全的小函数。没有任何外部依赖。
 */

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export { MOBILE_UA };

/** 统一错误：code 让面板与工具都能给出可读提示。 */
export class VideoError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
    Object.assign(this, meta);
  }
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

/** 把 `//i0.hdslb.com/x.jpg` 补成 `https://...`；已经是绝对地址就原样返回。 */
export function absoluteUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  if (text.startsWith('//')) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

/**
 * 带超时的 fetch。`timeoutMs` 到了就 abort，并把底层错误包装成 VideoError，
 * 这样面板上看到的是「请求超时」而不是 `The operation was aborted`。
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    redirect = 'follow',
    maxBytes = 8 * 1024 * 1024,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'user-agent': DESKTOP_UA, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') {
      throw new VideoError('timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）：${shortUrl(url)}`);
    }
    throw new VideoError('fetch-failed', `网络请求失败：${error?.message ?? error}（${shortUrl(url)}）`);
  }

  try {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new VideoError('too-large', `响应体过大（${text.length} 字节）：${shortUrl(url)}`);
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text, url: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** GET 一个 JSON 接口；非 JSON 或 HTTP 错误都收敛成 VideoError。 */
export async function requestJson(url, options = {}) {
  const { status, text, url: finalUrl } = await request(url, {
    ...options,
    headers: { accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) },
  });
  if (status < 200 || status >= 300) {
    throw new VideoError('fetch-failed', `接口返回 HTTP ${status}：${shortUrl(finalUrl)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new VideoError('bad-response', `接口返回的不是 JSON：${shortUrl(finalUrl)}`);
  }
}

export function shortUrl(url) {
  const text = String(url ?? '');
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** timedtext / 弹幕常用：`&#39;` / `&amp;` / `&quot;` 这些。 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** 秒 → `mm:ss` / `h:mm:ss`。 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** 中文毫秒时间戳（B 站 subtotal / 官方总结用）→ ISO 字符串。 */
export function isoFromSeconds(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number * 1000).toISOString();
}

/** 把连续字幕片段合成带 `[mm:ss]` 前缀的长文本，供 prompt / 工具结果用。 */
export function renderTimestamped(segments, { budget = 60000 } = {}) {
  const lines = [];
  let used = 0;
  for (const segment of segments) {
    const line = `[${formatClock(segment.start)}] ${segment.text}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < segments.length) {
    lines.push(`（字幕太长，仅取前 ${lines.length} 段，共 ${segments.length} 段）`);
  }
  return lines.join('\n');
}

/**
 * 超长字幕的压缩采样：先保留开头一段建立语境，再按时长均匀抽样，
 * 最后保留结尾 —— 让模型仍然看得到「全片」，而不是只有前 20%。
 */
export function sampleSegments(segments, budget = 40000) {
  const total = segments.reduce((sum, segment) => sum + segment.text.length + 8, 0);
  if (total <= budget) return segments;

  const keepRatio = budget / total;
  const keepCount = Math.max(40, Math.floor(segments.length * keepRatio));
  const head = Math.min(30, Math.floor(keepCount / 4));
  const tail = Math.min(20, Math.floor(keepCount / 6));
  const middleCount = keepCount - head - tail;
  const middle = segments.slice(head, segments.length - tail);
  const picked = [];
  for (let index = 0; index < middleCount; index += 1) {
    const at = Math.floor((index / Math.max(middleCount - 1, 1)) * (middle.length - 1));
    picked.push(middle[at]);
  }
  const unique = new Set([...segments.slice(0, head), ...picked, ...segments.slice(segments.length - tail)]);
  return [...unique].sort((a, b) => a.start - b.start);
}

/** 只留数字，给「1.2万」这类展示兜底（面板自己格式化，这里给工具用）。 */
export function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '0';
  if (number >= 100000000) return `${(number / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(number));
}

/** 从 HTML 里按 `名称":"值` 这样的内联 JSON 字段粗取一个字符串。 */
export function matchInline(html, name) {
  const pattern = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/**
 * 从一段 HTML 里抠出 `ytInitialPlayerResponse = {...}` 这类赋值后面的 JSON 对象。
 * 用大括号配对而不是正则，避免把嵌套对象截断。
 */
export function extractJsonObject(text, startIndex) {
  const start = text[startIndex];
  if (start !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(startIndex, index + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 简单内存缓存：`get(key)` / `set(key, value)` / 过期时间毫秒。 */
export function createCache({ ttlMs = 30 * 60 * 1000, limit = 24 } = {}) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > ttlMs) {
        store.delete(key);
        return null;
      }
      // 命中一次挪到队尾，Map 的插入顺序天然就是 LRU 顺序。
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, { at: Date.now(), value });
      while (store.size > limit) store.delete(store.keys().next().value);
      return value;
    },
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    get size() {
      return store.size;
    },
  };
}
