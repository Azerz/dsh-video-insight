/**
 * dsh-video-insight 浏览器半 · 「视频解析」面板
 *
 * 两个插槽：
 *  - sidebar.panellist：播放 + 星芒图标（order 30），点击由侧边栏 layout.selectPanel('video')；
 *  - main（key 'video'）：面板页，自己管理全部状态。
 * 数据全部来自同插件 host 半的同源接口 `/dsh-video/api/*`（JSON + /analyze 的 SSE），
 * 浏览器半不直连平台、不持有凭证。
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-insight',
  factory: (require) => {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const PANEL_ID = 'video';
    const PLAYER_KEY = 'dsh-video.player.collapsed';
    const HISTORY_LIMIT = 20;
    const SEGMENT_LIMIT = 400;

    /** 同源 API 基址：应用路由是 document-relative，所以从 baseURI 解析。 */
    const API_BASE = (() => {
      try { return new URL('dsh-video/api/', document.baseURI).toString(); }
      catch { return '/dsh-video/api/'; }
    })();

    const EMPTY_SUMMARY = { text: '', suggestions: [], loading: false, phase: '', error: '', done: false, cached: false, cachedAt: '' };
    const EMPTY_CHAPTERS = { loading: false, error: '', note: '', items: null, source: '', cachedAt: '' };
    const EMPTY_TRANSCRIBE = { loading: false, phase: '', percent: null, error: '' };
    const ASR_ENGINES = [['auto', '自动选择'], ['whisper', 'Whisper'], ['sensevoice', 'SenseVoice']];
    const ASR_TOOLS = [['ffmpeg', 'ffmpeg'], ['ytdlp', 'yt-dlp'], ['whisper', 'whisper-cli'], ['sherpa', 'sherpa-onnx']];
    const FRAME_MODES = [['auto', '自动'], ['ocr', '仅画面文字'], ['vision', '画面理解']];
    const FRAME_MODE_DESC = {
      auto: '自动（推荐）：先在本机识别画面文字，文字太少时再让视觉模型看画面。',
      ocr: '仅画面文字（OCR）：完全在本机运行，抽帧与识别都不会联网。',
      vision: '画面理解（视觉模型）：会抽取画面图片发给当前模型（图片会离开本机）。',
    };
    const STAGE_LABEL = { vision: '画面理解中', ocr: '画面文字识别中' };
    const VISION_MODEL_PLACEHOLDER = 'opencode-go/deepseek-v4.1-flash';

    /* ------------------------------------------------------------------ 常量 */

    const PLATFORM_META = {
      youtube: { label: 'YouTube', short: 'YouTube', color: '#FF0033' },
      bilibili: { label: '哔哩哔哩', short: 'B 站', color: '#FB7299' },
    };
    const SOURCE_LABEL = {
      'bilibili-ai-subtitle': 'B 站 AI 字幕', 'bilibili-subtitle': 'B 站字幕',
      'youtube-caption': 'YouTube 官方字幕', 'youtube-asr': 'YouTube 自动字幕', none: '无字幕',
      'local-whisper': '本地 Whisper', 'local-sensevoice': '本地 SenseVoice',
      'frame-ocr': '画面文字（OCR）',
      'frame-vision': '画面理解',
    };
    const LANG_LABEL = {
      zh: '中文', 'zh-cn': '中文', 'zh-hans': '中文', 'zh-tw': '繁體中文', 'zh-hant': '繁體中文',
      en: 'English', 'en-us': 'English', 'en-gb': 'English', ja: '日本語', ko: '한국어',
    };
    const TABS = [['summary', '总结'], ['chapters', '章节'], ['transcript', '原文'], ['mindmap', '思维导图']];
    const ASK_EXAMPLES = ['这个视频最核心的论点是什么？', '作者的观点有哪些可疑之处？', '用 5 句话讲给完全不懂的人听'];

    function platformMeta(platform) {
      return PLATFORM_META[platform] ?? {
        label: platform ? String(platform) : '未知平台',
        short: platform ? String(platform) : '?',
        color: 'var(--dsw-alias-label-secondary)',
      };
    }
    function guessPlatform(rawUrl) {
      const value = String(rawUrl ?? '');
      if (/bilibili\.com|b23\.tv|bili2233|BV[0-9A-Za-z]{10}/i.test(value)) return 'bilibili';
      if (/youtube\.com|youtu\.be/i.test(value)) return 'youtube';
      return '';
    }

    /* -------------------------------------------------------------- HTTP/SSE */

    function makeError(message, code) {
      const error = new Error(String(message ?? '未知错误'));
      error.code = code || '';
      return error;
    }

    /** 统一解析 `{ ok: true, value }` / `{ ok: false, code, error }`。 */
    function request(path, { params, method = 'GET', body, signal } = {}) {
      const url = new URL(path, API_BASE);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || String(value).length === 0) continue;
        url.searchParams.set(key, String(value));
      }
      const init = { method, headers: { accept: 'application/json' }, signal };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return fetch(url.toString(), init).then(async (response) => {
        let payload = null;
        try { payload = await response.json(); }
        catch { throw makeError(`插件主机返回了非 JSON 内容（HTTP ${response?.status ?? '???'}）`, 'internal'); }
        if (!payload || payload.ok !== true) {
          throw makeError(payload?.error || `请求失败（HTTP ${response?.status ?? '???'}）`, payload?.code || 'internal');
        }
        return payload.value;
      }, (error) => {
        if (error && error.name === 'AbortError') return Promise.reject(error);
        return Promise.reject(makeError(`插件主机不可达：${error?.message ?? error}`, 'internal'));
      });
    }
    const call = (path, params, options) => request(path, { ...options, params });
    const post = (path, body, options) => request(path, { ...options, method: 'POST', body: body ?? {} });

    /**
     * 读 /analyze 的 SSE：fetch + body.getReader() + TextDecoder，按 `\n\n` 切帧，
     * 每帧去 `data: ` 前缀后 JSON.parse。onEvent 返回 'stop' 表示拿到终态帧、提前收流。
     */
    async function streamSSE(path, body, { signal, onEvent } = {}) {
      const url = new URL(path, API_BASE).toString();
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body ?? {}),
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw makeError(`插件主机不可达：${error?.message ?? error}`, 'internal');
      }
      if (!response || response.ok !== true) {
        let message = `HTTP ${response?.status ?? '???'}`;
        try {
          const text = String(await response.text());
          try {
            const parsed = JSON.parse(text);
            message = String(parsed?.error ?? parsed?.message ?? message);
          } catch { if (text) message = text.slice(0, 200); }
        } catch { /* 读不到 body 就用状态码 */ }
        throw makeError(message, 'internal');
      }
      const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
      if (!reader) throw makeError('当前环境不支持流式读取（response.body 不可用）', 'internal');
      const decoder = new TextDecoder();
      let buffer = '';
      let stopped = false;
      const handleFrame = (frame) => {
        if (!frame) return;
        const data = [];
        for (const line of frame.split('\n')) if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (!data.length) return;
        let event = null;
        try { event = JSON.parse(data.join('\n')); } catch { return; } // 半个 JSON / 心跳：忽略
        if (event && typeof onEvent === 'function' && onEvent(event) === 'stop') stopped = true;
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
          for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
            handleFrame(buffer.slice(0, index));
            buffer = buffer.slice(index + 2);
            if (stopped) break;
          }
          if (stopped) break;
        }
        if (!stopped) {
          buffer += decoder.decode();
          if (buffer.trim()) handleFrame(buffer.trim());
        }
      } finally {
        if (stopped) { try { await reader.cancel(); } catch { /* ignore */ } }
        try { reader.releaseLock?.(); } catch { /* ignore */ }
      }
    }

    /* --------------------------------------------------------- 文本 / 格式化 */

    const pad2 = (value) => String(value).padStart(2, '0');

    /** 秒 → m:ss / h:mm:ss。 */
    function fmtTime(value) {
      const total = Math.max(0, Math.floor(Number(value) || 0));
      const hours = Math.floor(total / 3600);
      const tail = `${Math.floor(total / 60) % 60}:${pad2(total % 60)}`;
      return hours > 0 ? `${hours}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}` : tail;
    }
    /** `[03:12]` / `[1:03:12]` 里的时钟 → 秒数；解析失败返回 null。 */
    function clockToSeconds(label) {
      const text = String(label ?? '').trim().replace(/^\[/, '').replace(/\]$/, '');
      const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
      if (!match) return null;
      const first = Number(match[1]);
      const second = Number(match[2]);
      const third = match[3] === undefined ? null : Number(match[3]);
      return third === null ? first * 60 + second : first * 3600 + second * 60 + third;
    }
    /** 过万显示 x.x万、过亿显示 x.x亿。 */
    function fmtCount(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return '';
      const trim = (v) => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
      if (number >= 1e8) return `${trim(number / 1e8)}亿`;
      if (number >= 1e4) return `${trim(number / 1e4)}万`;
      return String(Math.round(number));
    }
    function fmtDate(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }
    function fmtWhen(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      if (date.toDateString() === now.toDateString()) return `今天 ${clock}`;
      if (date.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return `昨天 ${clock}`;
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
    }
    function langLabel(lang) {
      const key = String(lang ?? '').trim();
      return key ? LANG_LABEL[key] || LANG_LABEL[key.toLowerCase()] || key : '';
    }
    const shortUrl = (rawUrl) => String(rawUrl ?? '').replace(/^https?:\/\//, '').slice(0, 46);
    const hasTranscript = (doc) => Boolean(doc && doc.transcript && doc.transcript.available);
    function transcriptSegments(doc) {
      const list = doc && doc.transcript && Array.isArray(doc.transcript.segments) ? doc.transcript.segments : [];
      return list.filter((segment) => segment && typeof segment.text === 'string' && segment.text.trim());
    }

    /* --------------------------------------------------- 播放器地址 / 相对时间 */

    /** 平台视频 id：YouTube 是 11 位 id，B 站是 BV 号；doc.id 缺失时从 docId / url 兜底。 */
    function videoId(doc) {
      if (!doc) return '';
      const raw = String(doc.id || (String(doc.docId || '').split(':').slice(1).join(':') || '')).trim();
      if (raw) return raw;
      try {
        const parsed = new URL(String(doc.url || ''), 'https://example.com/');
        if (doc.platform === 'youtube') return String(parsed.searchParams.get('v') || '').trim();
      } catch { /* 非 URL：放弃 */ }
      return '';
    }

    /** 多 P：从 doc.url 的 p 参数取当前分 P，缺省 1。 */
    function playerPage(doc) {
      try {
        const page = Number(new URL(String((doc && doc.url) || ''), 'https://example.com/').searchParams.get('p') || 1);
        return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
      } catch { return 1; }
    }

    /** 规范化 Host 起源：只接受 http(s)，去掉尾部斜杠。 */
    function normalizeHostBase(value) {
      const raw = String(value || '').trim().replace(/\/+$/, '');
      return /^https?:\/\//i.test(raw) ? raw : '';
    }

    /** 传输层注入的 Host HTTP 起源（桌面客户端跑在 dsh-app:// 下时靠它找到 http 外壳）。 */
    function playerTransportBase() {
      const scopes = [];
      try { if (typeof globalThis !== 'undefined' && globalThis) scopes.push(globalThis); } catch { /* ignore */ }
      try { if (typeof window !== 'undefined' && window && window !== globalThis) scopes.push(window); } catch { /* ignore */ }
      for (const scope of scopes) {
        try {
          const transport = scope.__DSH_TRANSPORT__;
          const candidate = transport && (transport.streamBaseUrl || transport.streamBaseURL);
          const base = normalizeHostBase(candidate);
          if (base) return base;
        } catch { /* 继续找下一个 scope */ }
      }
      return '';
    }

    /** 面板自身就是 http(s) 起源时可用的同源基址。 */
    function playerOriginBase() {
      try {
        const origin = window.location && window.location.origin;
        return normalizeHostBase(origin);
      } catch { return ''; }
    }

    /** 播放器外壳基址：优先传输层，其次面板起源（同源时用相对路径）。 */
    function playerHostBase() {
      return playerTransportBase() || playerOriginBase();
    }

    /**
     * iframe 地址：不再直接嵌平台播放器（dsh-app:// 下 YouTube 会拒播），
     * 改为 Host 的 /player 外壳（http 起源），由外壳再嵌内层播放器。
     * 拿不到任何 http 基址时返回 null，由播放器区显示占位提示。
     */
    function playerSrc(doc, startAt) {
      const id = videoId(doc);
      if (!id || !doc) return null;
      const platform = doc.platform === 'youtube' ? 'youtube' : 'bilibili';
      const start = Math.max(0, Math.floor(Number(startAt) || 0));
      const path = `/dsh-video/api/player?platform=${platform}&id=${encodeURIComponent(id)}&page=${playerPage(doc)}&start=${start}`;
      const transport = playerTransportBase();
      if (transport) return `${transport}${path}`;
      // 面板本身是 http(s)：走同源相对路径，Host 会把 /dsh-video/api/* 代理到插件。
      if (playerOriginBase()) return path;
      return null;
    }

    function readPlayerCollapsed() {
      try { return window.localStorage.getItem(PLAYER_KEY) === '1'; }
      catch { return false; }
    }
    function writePlayerCollapsed(collapsed) {
      try { window.localStorage.setItem(PLAYER_KEY, collapsed ? '1' : '0'); }
      catch { /* 隐私模式 / 配额满：只影响记住折叠状态 */ }
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日。 */
    function fmtRelative(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      const diff = Date.now() - date.getTime();
      if (diff < 60e3) return '刚刚';
      if (diff < 3600e3) return `${Math.max(1, Math.floor(diff / 60e3))} 分钟前`;
      if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
      const yesterday = new Date(Date.now() - 864e5);
      if (date.toDateString() === yesterday.toDateString()) return '昨天';
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    /** RAG 引用：容错清洗 host 返回的 citations（可能缺字段，也可能是旧数据）。 */
    function sanitizeCitations(input) {
      if (!Array.isArray(input)) return [];
      return input.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const start = Number(item.start);
        if (!Number.isFinite(start) || start < 0) return null;
        const end = Number(item.end);
        const score = Number(item.score);
        return {
          start,
          end: Number.isFinite(end) && end >= start ? end : start,
          preview: typeof item.preview === 'string' ? item.preview : '',
          score: Number.isFinite(score) ? score : undefined,
        };
      }).filter(Boolean);
    }

    /** 引用 chip 的文字：mm:ss–mm:ss（分钟补零；超过 1 小时自动 h:mm:ss）。 */
    function citationLabel(citation) {
      const start = Number(citation && citation.start);
      const endRaw = Number(citation && citation.end);
      if (!Number.isFinite(start) || start < 0) return '';
      const end = Number.isFinite(endRaw) && endRaw >= start ? endRaw : start;
      const pad2 = (value) => String(Math.max(0, Math.floor(value))).padStart(2, '0');
      const stamp = (seconds) => {
        const total = Math.max(0, Math.floor(seconds));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
      };
      return `${stamp(start)}–${stamp(end)}`;
    }

    /**
     * 读取 /resolve 返回的 doc.analysis（host 0.4.0 的分析缓存）。
     * 字段可能缺失 / 为 null / 来自旧版本，这里统一容错成面板用的形状；
     * 没有任何可回填内容时返回 null。
     */
    function readCachedAnalysis(doc) {
      const raw = doc && doc.analysis;
      if (!raw || typeof raw !== 'object') return null;
      // host 的时间字段可能是 ISO 字符串，也可能是毫秒时间戳（实测 host 0.4.0 用数字），两种都接受。
      const stamp = (value) => {
        if (typeof value === 'string' && value) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        return '';
      };
      const cache = {
        savedAt: stamp(raw.savedAt),
        summary: null, chapters: null, mindmap: null, chat: [],
      };
      const summary = raw.summary;
      if (summary && typeof summary === 'object' && typeof summary.text === 'string' && summary.text.trim()) {
        cache.summary = {
          text: summary.text,
          suggestions: Array.isArray(summary.suggestions)
            ? summary.suggestions.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3)
            : [],
          generatedAt: stamp(summary.generatedAt),
        };
      }
      const chapters = raw.chapters;
      if (chapters && typeof chapters === 'object' && Array.isArray(chapters.items)) {
        const items = chapters.items.filter((item) => item && typeof item === 'object').map((item) => {
          const start = Number(item.start);
          return {
            start: Number.isFinite(start) && start >= 0 ? start : null,
            title: String(item.title || '(未命名章节)'),
            gist: String(item.gist || ''),
          };
        });
        if (items.length) {
          cache.chapters = {
            items,
            source: typeof chapters.source === 'string' ? chapters.source : 'cache',
            generatedAt: stamp(chapters.generatedAt),
          };
        }
      }
      const mindmap = raw.mindmap;
      if (mindmap && typeof mindmap === 'object') {
        const tree = mindmap.mindmap && typeof mindmap.mindmap === 'object' ? mindmap.mindmap : null;
        if (tree && Array.isArray(tree.children)) {
          cache.mindmap = {
            data: tree,
            generatedAt: stamp(mindmap.generatedAt),
          };
        }
      }
      const chat = Array.isArray(raw.chat) ? raw.chat : [];
      cache.chat = chat.filter((message) => message && typeof message === 'object'
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.text === 'string').map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        text: message.text,
        citations: message.role === 'assistant' ? sanitizeCitations(message.citations) : [],
        at: stamp(message.at),
      }));
      return cache;
    }

    function friendlyResolveError(error, rawUrl) {
      const code = String(error?.code ?? '');
      const platform = guessPlatform(rawUrl);
      const who = platform === 'bilibili' ? 'B 站' : platform === 'youtube' ? 'YouTube' : '平台';
      const message = String(error?.message ?? error ?? '未知错误');
      if (code === 'bad-url') return '没认出这个链接：请粘贴 YouTube 或哔哩哔哩的视频链接（支持 BV 号、分享短链）。';
      if (code === 'not-found') {
        return platform === 'bilibili'
          ? 'B 站里没找到这个视频：可能已删除或设为私密；也可能是没登录导致接口不返回，去「设置」填 Cookie 再试。'
          : `${who}里没找到这个视频：可能已删除、设为私密或地区受限。`;
      }
      if (code === 'unsupported') return `这个视频暂不支持解析：${message}`;
      if (code === 'fetch-failed') {
        const limited = /-352|-412|-401|-403|风控|限流/.test(message);
        const hint = limited
          ? (platform === 'bilibili' ? '，稍后重试或去「设置」里填 Cookie' : '，稍后重试')
          : '，平台接口暂时不可用，稍后重试';
        return `${who}解析失败：${message}${hint}。`;
      }
      return `解析失败：${message}`;
    }
    function friendlyStreamError(error, kind) {
      const message = String(error?.message ?? error ?? '未知错误');
      if (/401|403|unauthorized|权限/i.test(message)) return `${kind}生成失败：模型或接口没有权限，检查 DSH 的模型配置（${message}）`;
      if (/超时|timeout/i.test(message)) return `${kind}生成失败：请求超时，稍后重试（${message}）`;
      return `${kind}生成失败：${message}`;
    }

    /** /transcribe 的错误码 → 用户能执行的中文提示（host 自带安装提示时原样透出）。 */
    function friendlyAsrError(error) {
      const code = String(error?.code ?? '');
      const message = String(error?.message ?? error ?? '未知错误');
      if (code === 'asr-needs-ytdlp' || /yt-dlp[^\n]*(缺|没有|not found|ENOENT)/i.test(message)) {
        return '本地转写失败：缺少 yt-dlp（下载视频音轨要用），在终端执行 `brew install yt-dlp`，然后去设置点「刷新状态」再试。';
      }
      if (code === 'asr-no-tools' || /ffmpeg[^\n]*(缺|没有|not found|ENOENT)/i.test(message)) {
        return '本地转写失败：缺少 ffmpeg，在终端执行 `brew install ffmpeg`，然后去设置点「刷新状态」再试。';
      }
      if (code === 'asr-disabled') return '本地转写已关闭：去「设置 → 本地语音转写」打开开关后再试。';
      if (code === 'asr-empty') return '没有识别出可用语音，画面里也没有可用的文字：这个视频可能是纯音乐或纯画面。';
      if (code === 'ocr-unavailable') return `画面文字识别不可用：${message}`;
      if (code === 'ocr-needs-ytdlp') return '画面文字识别需要 yt-dlp 下载视频：在终端执行 `brew install yt-dlp`，然后去设置点「刷新状态」再试。';
      if (code === 'ocr-no-ffmpeg') return '画面文字识别需要 ffmpeg 抽帧：在终端执行 `brew install ffmpeg`，然后去设置点「刷新状态」再试。';
      if (code === 'ocr-frames-failed') return `抽帧失败：${message}`;
      if (code === 'ocr-failed') return `画面文字识别失败：${message}`;
      if (code === 'vision-unavailable') return '画面理解不可用：当前没有可用的视觉模型或附件服务，可以改用「仅画面文字」。';
      if (code === 'vision-no-model') return '没有可用的视觉模型：请在设置里指定一个支持图片输入的模型。';
      if (code === 'vision-failed') return `画面理解失败：${message}，可以重试或改用「仅画面文字」。`;
      if (code === 'ocr-download-failed') return `下载视频失败（抽帧要用）：${message}`;
      if (code === 'asr-convert-failed') return `音频转换失败：检查 ffmpeg 是否可用（${message}）。`;
      if (code === 'aborted') return '已取消本地转写。';
      if (code === 'asr-unavailable') return `本机转写组件还没就绪：${message}（装好后点设置里的「刷新状态」）`;
      return `本地转写失败：${message}`;
    }

    /** /transcribe 的 progress.stage → 用户能看懂的中文阶段名（未知阶段原样显示）。 */
    function stageText(stage) {
      const key = String(stage ?? '').trim();
      if (!key) return '';
      return STAGE_LABEL[key] || key;
    }

    /* --------------------------------------------------------------- 剪贴板 */

    async function copyText(value) {
      const text = String(value ?? '');
      if (!text) return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* 落到 execCommand 兜底 */ }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return Boolean(ok);
      } catch { return false; }
    }

    /* ------------------------------------------------------- markdown-lite 渲染 */

    const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\d{1,2}:\d{2}(?::\d{2})?\])/g;

    function renderInline(text, prefix, onSeek) {
      return String(text ?? '').split(INLINE_PATTERN).map((part, index) => {
        if (!part) return null;
        const key = `${prefix}-${index}`;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          // 递归一层：`**[12:34]**` 里的时间戳仍要变成徽标
          return h('strong', { key }, renderInline(part.slice(2, -2), `${key}-b`, onSeek));
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return h('code', { key, className: 'dvv-code' }, part.slice(1, -1));
        }
        if (/^\[\d{1,2}:\d{2}(?::\d{2})?\]$/.test(part)) {
          const label = part.slice(1, -1);
          if (typeof onSeek !== 'function') return h('span', { key, className: 'dvv-ts' }, label);
          const seconds = clockToSeconds(label);
          if (seconds === null) return h('span', { key, className: 'dvv-ts' }, label);
          return h('button', {
            key, type: 'button', className: 'dvv-ts dvv-ts-btn',
            title: `跳转到 ${label} 播放`,
            onClick: () => onSeek(seconds),
          }, label);
        }
        return part;
      }).filter((node) => node !== null);
    }

    /** 极简 markdown → React 节点：##/### 标题、- / * 与 1. 列表、**粗体**、`行内代码`、[mm:ss]、段落。 */
    function renderMarkdown(text, onSeek) {
      const blocks = [];
      let paragraph = [];
      let list = null;
      let counter = 0;
      const flushParagraph = () => {
        if (!paragraph.length) return;
        const prefix = `p${counter++}`;
        blocks.push(h('p', { key: prefix, className: 'dvv-md-p' }, renderInline(paragraph.join('\n'), prefix, onSeek)));
        paragraph = [];
      };
      const flushList = () => {
        if (!list) return;
        const prefix = `l${counter++}`;
        blocks.push(h(list.ordered ? 'ol' : 'ul', { key: prefix, className: 'dvv-md-list' },
          list.items.map((item, index) => h('li', { key: `${prefix}-${index}` }, renderInline(item, `${prefix}-${index}`, onSeek)))));
        list = null;
      };
      for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flushParagraph(); flushList(); continue; }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          flushParagraph(); flushList();
          const level = Math.min(heading[1].length, 3);
          blocks.push(h(`h${level + 2}`, { key: `h${counter++}`, className: `dvv-md-h dvv-md-h${level}` }, renderInline(heading[2], `h${counter}`, onSeek)));
          continue;
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(line);
        const ordered = /^(\d{1,3})[.)]\s+(.*)$/.exec(line);
        if (bullet || ordered) {
          flushParagraph();
          const isOrdered = !bullet;
          if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
          list.items.push(bullet ? bullet[1] : ordered[2]);
          continue;
        }
        if (list) flushList();
        paragraph.push(line);
      }
      flushParagraph();
      flushList();
      return blocks;
    }

    /* ------------------------------------------------------------------ 图标 */

    /** 16x16 原创图标：播放三角 + 三颗星芒，active 时用品牌色。 */
    function VideoIcon({ size = 16, active = false }) {
      const stroke = active ? 'var(--dsw-alias-brand-primary, currentColor)' : 'currentColor';
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'p', d: 'M2.9 4.1 9.6 8 2.9 11.9Z', stroke, strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round' }),
        h('path', { key: 'r1', d: 'M12.4 1.9v2.8', stroke, strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'r2', d: 'M11 3.3h2.8', stroke, strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { key: 's', cx: 12.4, cy: 11.1, r: 0.9, fill: stroke }),
      ]);
    }

    /* ---------------------------------------------------------------- 小组件 */

    function PlatformBadge({ platform, compact = false }) {
      const meta = platformMeta(platform);
      return h('span', {
        className: `dvv-plat${compact ? ' dvv-plat-compact' : ''}`,
        style: { background: meta.color }, title: meta.label,
      }, compact ? meta.short : meta.label);
    }

    function CoverImage({ src, alt }) {
      const [broken, setBroken] = useState(false);
      const url = String(src ?? '');
      if (!url || broken) return h('div', { className: 'dvv-cover dvv-cover-ph', 'aria-hidden': 'true' }, h('span', null, '无封面'));
      return h('div', { className: 'dvv-cover' }, h('img', { src: url, alt: alt ?? '', loading: 'lazy', onError: () => setBroken(true) }));
    }

    function CapabilityRow({ name, ok, text }) {
      return h('div', { className: 'dvv-cap' }, [
        h('span', { key: 'd', className: 'dvv-cap-dot', 'data-ok': ok ? 'true' : 'false' }),
        h('span', { key: 't', className: 'dvv-cap-text' }, [h('strong', { key: 'n' }, `${name}：`), text]),
      ]);
    }

    /* ------------------------------------------------------------------ 空态 */

    /** 首页：Google 式居中的大号解析框 + 最近分析列表。 */
    function HomeHero({ url, busy, statusError, biliReady, onUrl, onSubmit, onGoSettings }) {
      const canSubmit = !busy && String(url ?? '').trim().length > 0;
      const submit = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (canSubmit) onSubmit();
      };
      return h('div', { className: 'dvv-home' }, [
        statusError ? h('div', { key: 'host', className: 'dvv-error' }, `插件主机未就绪：${statusError}（面板要等 host 半启动后才能解析）`) : null,
        h('div', { key: 'hero', className: 'dvv-home-hero' }, [
          h('h1', { key: 't', className: 'dvv-home-title' }, '视频解析'),
          h('p', { key: 's', className: 'dvv-home-sub' }, '粘贴 YouTube / 哔哩哔哩链接，自动抓字幕、生成总结、章节和思维导图，还能对着视频追问'),
          h('form', { key: 'form', className: 'dvv-home-form', onSubmit: submit }, [
            h('input', {
              key: 'i', className: 'dvv-home-input', type: 'text', value: url,
              placeholder: '粘贴视频链接，例如 https://www.youtube.com/watch?v=... 或 https://www.bilibili.com/video/BV...',
              'aria-label': '视频链接', spellCheck: false,
              onChange: (event) => onUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') submit(event); },
            }),
            h('button', {
              key: 'go', type: 'submit', className: 'dvv-btn dvv-home-btn', 'data-primary': 'true', disabled: !canSubmit,
            }, busy ? '解析中…' : '解析'),
          ]),
          !biliReady ? h('div', { key: 'cookie', className: 'dvv-home-hint' }, [
            h('span', { key: 't' }, 'B 站 AI 字幕需要登录 Cookie：'),
            h('button', { key: 'b', type: 'button', className: 'dvv-btn dvv-btn-mini', onClick: onGoSettings }, '去设置'),
          ]) : null,
        ]),
      ].filter(Boolean));
    }

    /* ------------------------------------------------------------------ 播放器 */

    function PlayerArea({ doc, collapsed, startAt, frameRef, onToggle, onLoaded }) {
      const meta = platformMeta(doc.platform);
      const src = playerSrc(doc, startAt);
      return h('section', { className: 'dvv-player' }, [
        h('div', { key: 'bar', className: 'dvv-player-bar' }, [
          h(PlatformBadge, { key: 'p', platform: doc.platform, compact: true }),
          h('span', { key: 't', className: 'dvv-player-title' }, collapsed ? '播放器已收起' : '播放器'),
          h('div', { key: 's', className: 'dvv-spacer' }),
          h('a', {
            key: 'open', className: 'dvv-btn dvv-link-btn', href: doc.url || '#', target: '_blank', rel: 'noreferrer noopener',
          }, `在 ${meta.short} 打开`),
          h('button', { key: 'toggle', type: 'button', className: 'dvv-btn', onClick: onToggle }, collapsed ? '展开播放器' : '收起播放器'),
        ]),
        collapsed ? null : h('div', { key: 'body', className: 'dvv-player-body' },
          src
            ? h('div', { className: 'dvv-frame-wrap' }, h('iframe', {
                key: `frame-${startAt ?? 0}`,
                ref: frameRef,
                className: 'dvv-frame',
                src,
                title: String(doc.title || '视频播放器'),
                allowFullScreen: true,
                allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
                referrerPolicy: 'strict-origin-when-cross-origin',
                loading: 'lazy',
                frameBorder: '0',
                onLoad: onLoaded,
              }))
            : h('div', { className: 'dvv-player-empty' }, [
                h('div', { key: 't', className: 'dvv-player-empty-title' }, '当前环境无法内嵌播放器'),
                h('div', { key: 'd', className: 'dvv-player-empty-note' }, `请用「在 ${meta.short} 打开」在新窗口播放。`),
              ])),
      ].filter(Boolean));
    }

    /* -------------------------------------------------------------- 顶部工具栏 */

    /**
     * 顶部紧凑工具栏：返回 + 标题/平台/状态 + 历史/设置。
     * 视频信息压缩成两行（标题一行省略、元信息一行），不再占掉一整块纵向空间。
     */
    function VideoToolbar({ doc, historyCount, canGoBack, onBack, onHistory, onSettings }) {
      let metaBits = [];
      if (doc) {
        const stats = doc.stats ?? {};
        metaBits = [
          h(PlatformBadge, { key: 'plat', platform: doc.platform, compact: true }),
          doc.duration ? h('span', { key: 'dur', className: 'dvv-dur' }, fmtTime(doc.duration)) : null,
          doc.author ? h('span', { key: 'author', className: 'dvv-note' }, doc.author) : null,
          doc.publishedAt ? h('span', { key: 'when', className: 'dvv-note' }, fmtDate(doc.publishedAt)) : null,
        ].filter(Boolean);
        const bits = [['播放', stats.views], ['点赞', stats.likes], ['评论', stats.comments]]
          .filter(([, value]) => Number(value) > 0)
          .map(([label, value], index) => h('span', { key: `s-${label}` }, `${index ? '· ' : ''}${label} ${fmtCount(value)}`));
        if (bits.length) metaBits.push(h('span', { key: 'stats', className: 'dvv-toolbar-stats' }, bits));
      }
      return h('header', { className: 'dvv-toolbar' }, [
        canGoBack ? h('button', {
          key: 'back', type: 'button', className: 'dvv-btn dvv-back',
          title: doc ? '返回首页' : '返回对话', 'aria-label': doc ? '返回首页' : '返回上一级',
          onClick: () => { if (onBack) onBack(); },
        }, '← 返回') : null,
        doc ? h('div', { key: 'cover', className: 'dvv-toolbar-cover' }, h(CoverImage, { src: doc.cover, alt: doc.title })) : null,
        h('div', { key: 'main', className: 'dvv-toolbar-main' }, doc ? [
          h('a', {
            key: 'title', className: 'dvv-toolbar-title', href: doc.url || '#', target: '_blank',
            rel: 'noreferrer noopener', title: doc.title || '',
          }, doc.title || '(无标题视频)'),
          h('div', { key: 'meta', className: 'dvv-toolbar-meta' }, metaBits),
        ] : null),
        h('div', { key: 'actions', className: 'dvv-toolbar-actions' }, [
          h('button', { key: 'history', type: 'button', className: 'dvv-btn', onClick: onHistory }, historyCount ? `历史 ${historyCount}` : '历史'),
          h('button', { key: 'settings', type: 'button', className: 'dvv-btn', onClick: onSettings }, '设置'),
        ]),
      ].filter(Boolean));
    }

    /** 进度条：percent 不是有效数字时用不确定进度动画。 */
    function AsrProgress({ percent }) {
      const raw = percent;
      const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
      const known = Number.isFinite(value) && value >= 0;
      return h('div', { className: 'dvv-progress', 'data-indeterminate': known ? undefined : 'true' },
        h('div', { className: 'dvv-progress-fill', style: known ? { width: `${Math.min(100, Math.max(0, value))}%` } : undefined }));
    }

    /** 本地转写来源徽标（local-whisper / local-sensevoice）。 */
    function LocalBadge({ source }) {
      const label = SOURCE_LABEL[source];
      return label ? h('span', { className: 'dvv-local-badge' }, label) : null;
    }

    /** 字幕来源行的其余信息：语言 · N 条 · M 字 · 用时。 */
    function transcriptMetaBits(doc) {
      const transcript = doc.transcript ?? {};
      const bits = [];
      const lang = langLabel(transcript.lang);
      if (lang) bits.push(lang);
      const count = transcriptSegments(doc).length;
      if (count) bits.push(`${count} 条`);
      if (transcript.chars) bits.push(`${fmtCount(transcript.chars)} 字`);
      const took = Number(transcript.tookMs);
      if (Number.isFinite(took) && took > 0) bits.push(`用时 ${(took / 1000).toFixed(1)}s`);
      return bits;
    }

    /**
     * 视频头卡下方的字幕行：
     *  - 有字幕：来源 · 语言 · 条数 · 字数（本地转写用徽标）；
     *  - 无字幕：本地转写引导条（自动转写进行中显示阶段/进度/取消，失败可重试）。
     */
    function TranscriptNote({ doc, asr, transcribe, onTranscribe, onCancel, onGoSettings }) {
      const transcript = doc.transcript ?? {};
      const warnings = Array.isArray(doc.warnings) ? doc.warnings.filter(Boolean) : [];
      const available = Boolean(transcript.available);
      const source = String(transcript.source || '');
      const local = source.startsWith('local-');
      if (available) {
        const parts = [
          h('span', { key: 'k', className: 'dvv-note' }, '字幕'),
          h('span', { key: 's0', className: 'dvv-meta-sep' }, '·'),
        ];
        if (local) parts.push(h(LocalBadge, { key: 'badge', source }));
        else parts.push(h('span', { key: 'src' }, SOURCE_LABEL[source] || source || '未知来源'));
        transcriptMetaBits(doc).forEach((bit, index) => {
          parts.push(h('span', { key: `sep-${index}`, className: 'dvv-meta-sep' }, '·'));
          parts.push(h('span', { key: `bit-${index}` }, bit));
        });
        return h('div', { className: 'dvv-meta-line' }, parts);
      }

      const enabled = Boolean(asr && asr.enabled !== false);
      const ready = Boolean(asr && asr.ready !== false);
      const hints = asr && Array.isArray(asr.hints) ? asr.hints.filter(Boolean) : [];
      const parts = [];
      parts.push(h('div', { key: 'title', className: 'dvv-asr-note-title' }, '这个视频没有字幕'));
      parts.push(h('div', { key: 'desc', className: 'dvv-note' }, warnings[0]
        ? `${warnings[0]}。可以在这台电脑上本地转写（音频不会上传），或先看简介做分析。`
        : '可以在这台电脑上本地转写：音频只在本机处理、不会上传，文字稿会用于总结、章节与追问。'));
      if (transcribe && transcribe.loading) {
        parts.push(h('div', { key: 'phase', className: 'dvv-asr-phase' }, [
          h('span', { key: 's', className: 'dvv-spinner' }),
          transcribe.phase || '准备转写…',
        ]));
        parts.push(h(AsrProgress, { key: 'bar', percent: transcribe.percent }));
        parts.push(h('div', { key: 'actions', className: 'dvv-actions' },
          h('button', { key: 'cancel', type: 'button', className: 'dvv-btn', onClick: onCancel }, '取消')));
      } else {
        if (transcribe && transcribe.error) parts.push(h('div', { key: 'error', className: 'dvv-error' }, transcribe.error));
        const actions = [];
        if (!asr) {
          actions.push(h('button', { key: 'go', type: 'button', className: 'dvv-btn', onClick: onGoSettings }, '转写设置'));
        } else if (!enabled) {
          parts.push(h('div', { key: 'off', className: 'dvv-note' }, '本地转写当前是关闭的：去「设置 → 本地语音转写」打开开关后，就能在本机生成字幕；也可以先用简介做分析。'));
          actions.push(h('button', { key: 'go', type: 'button', className: 'dvv-btn', onClick: onGoSettings }, '去设置里开启'));
        } else if (!ready) {
          parts.push(h('div', { key: 'miss', className: 'dvv-note' }, `本机转写组件还没装好：${hints[0] || '缺少 ffmpeg / whisper / sherpa 之一'}`));
          actions.push(h('button', { key: 'go', type: 'button', className: 'dvv-btn', onClick: onGoSettings }, '去设置查看'));
        } else {
          actions.push(h('button', {
            key: 'go', type: 'button', className: 'dvv-btn', 'data-primary': 'true',
            onClick: () => onTranscribe(),
          }, transcribe && transcribe.error ? '重试转写' : (local ? '重新转写' : '本地转写')));
        }
        if (actions.length) parts.push(h('div', { key: 'actions', className: 'dvv-actions' }, actions));
      }
      return h('div', { className: 'dvv-asr-note' }, parts);
    }

    /* ------------------------------------------------------------------ 总结 */

    function SummaryTab({ doc, summary, onRun, onStop, onCopy, onGoSettings, onSeek }) {
      const available = hasTranscript(doc);
      const official = doc && doc.officialSummary && doc.officialSummary.summary ? String(doc.officialSummary.summary) : '';
      const parts = [];
      if (!available) {
        parts.push(h('div', { key: 'cap', className: 'dvv-notice' }, [
          h('div', { key: 't', className: 'dvv-notice-title' }, '这个视频没拿到字幕'),
          h('div', { key: 'd', className: 'dvv-note' }, doc && doc.platform === 'bilibili'
            ? 'B 站需要登录 Cookie 才能读取 AI 字幕与官方总结。去「设置」粘贴 SESSDATA 后重新解析这个链接即可。'
            : 'YouTube 视频可能本身没有字幕，或作者关闭了自动字幕。'),
          h('div', { key: 'a', className: 'dvv-actions' }, h('button', { type: 'button', className: 'dvv-btn', 'data-primary': 'true', onClick: onGoSettings }, '去设置')),
        ]));
        if (official) {
          parts.push(h('div', { key: 'official', className: 'dvv-official' }, [
            h('div', { key: 'l', className: 'dvv-label' }, 'B 站官方 AI 摘要'),
            h('div', { key: 't', className: 'dvv-md' }, renderMarkdown(official, onSeek)),
          ]));
        }
        return h('div', { className: 'dvv-tabpane' }, parts);
      }
      if (summary.cached && summary.cachedAt) {
        parts.push(h('div', { key: 'cached', className: 'dvv-cache-note dvv-note' }, `已缓存 · ${fmtRelative(summary.cachedAt)}（点「重新生成」可覆盖）`));
      }
      if (summary.error) parts.push(h('div', { key: 'err', className: 'dvv-error' }, summary.error));
      if (summary.loading && !summary.text) {
        parts.push(h('div', { key: 'loading', className: 'dvv-loading-block' }, [h('span', { key: 's', className: 'dvv-spinner' }), summary.phase || '正在生成总结…']));
      }
      if (summary.text) {
        parts.push(h('div', { key: 'md', className: 'dvv-md dvv-md-wrap' }, [
          ...renderMarkdown(summary.text, onSeek),
          summary.loading ? h('span', { key: 'caret', className: 'dvv-caret' }) : null,
        ].filter(Boolean)));
      }
      if (summary.loading && summary.text && summary.phase) parts.push(h('div', { key: 'phase', className: 'dvv-note' }, summary.phase));
      const actions = [];
      if (summary.loading) actions.push(h('button', { key: 'stop', type: 'button', className: 'dvv-btn', onClick: onStop }, '停止'));
      else {
        if (summary.text || summary.error) actions.push(h('button', { key: 'again', type: 'button', className: 'dvv-btn', onClick: onRun }, '重新生成'));
        if (summary.text) actions.push(h('button', { key: 'copy', type: 'button', className: 'dvv-btn', onClick: onCopy }, '复制'));
      }
      if (actions.length) parts.push(h('div', { key: 'actions', className: 'dvv-actions' }, actions));
      if (!summary.loading && !summary.text && !summary.error) {
        parts.push(h('div', { key: 'idle', className: 'dvv-notice' }, [
          h('div', { key: 'n', className: 'dvv-note' }, '还没有生成总结。'),
          h('div', { key: 'a', className: 'dvv-actions' }, h('button', { type: 'button', className: 'dvv-btn', 'data-primary': 'true', onClick: onRun }, '生成总结')),
        ]));
      }
      return h('div', { className: 'dvv-tabpane' }, parts);
    }

    /* ------------------------------------------------------------------ 章节 */

    function ChapterRow({ item, index, open, onToggle, onSeek }) {
      const start = item.start !== null && item.start !== undefined && Number.isFinite(Number(item.start)) ? Number(item.start) : null;
      const timeLabel = start !== null ? `[${fmtTime(start)}]` : `P${item.pageIndex ?? index + 1}`;
      const activate = () => {
        onToggle(open ? -1 : index);
        if (start !== null) onSeek(start); // 章节时间戳同时跳转播放位置
      };
      return h('div', { className: 'dvv-ch' }, [
        h('div', {
          key: 'head', className: 'dvv-ch-head', role: 'button', tabIndex: 0,
          onClick: activate,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } },
        }, [
          h('span', { key: 't', className: 'dvv-ts' }, timeLabel),
          h('span', { key: 'title', className: 'dvv-ch-title' }, item.title || '(未命名章节)'),
          h('span', { key: 'chev', className: 'dvv-ch-chev' }, open ? '▴' : '▾'),
        ]),
        open ? h('div', { key: 'body', className: 'dvv-ch-body' }, item.gist || '暂无这节的说明。') : null,
      ]);
    }

    function ChaptersTab({ chapters, openIndex, onToggle, onRetry, onSeek }) {
      if (chapters.loading) {
        return h('div', { className: 'dvv-tabpane' }, h('div', { className: 'dvv-chlist' },
          [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'dvv-skel' }))));
      }
      const parts = [];
      if (chapters.cachedAt) parts.push(h('div', { key: 'cached', className: 'dvv-cache-note dvv-note' }, `已缓存 · ${fmtRelative(chapters.cachedAt)}`));
      if (chapters.error) parts.push(h('div', { key: 'err', className: 'dvv-error' }, chapters.error));
      if (chapters.note) parts.push(h('div', { key: 'note', className: 'dvv-note' }, chapters.note));
      const items = Array.isArray(chapters.items) ? chapters.items : [];
      if (items.length) {
        parts.push(h('div', { key: 'list', className: 'dvv-chlist' }, items.map((item, index) => h(ChapterRow, {
          key: `ch-${index}`, item, index, open: openIndex === index, onToggle, onSeek,
        }))));
      } else {
        parts.push(h('div', { key: 'empty', className: 'dvv-notice' }, [
          h('div', { key: 't', className: 'dvv-notice-title' }, '没有拿到章节'),
          h('div', { key: 'd', className: 'dvv-note' }, '这个视频可能太短，或者字幕内容不足以切分章节。'),
        ]));
      }
      parts.push(h('div', { key: 'act', className: 'dvv-actions' }, h('button', { type: 'button', className: 'dvv-btn', onClick: onRetry }, '重新生成章节')));
      return h('div', { className: 'dvv-tabpane' }, parts);
    }

    /* ------------------------------------------------------------------ 原文 */

    function TranscriptTab({ doc, query, showAll, onQuery, onShowAll, onCopySegment, onCopyAll, onGoSettings, onSeek }) {
      if (!hasTranscript(doc)) {
        return h('div', { className: 'dvv-tabpane' }, h('div', { className: 'dvv-notice' }, [
          h('div', { key: 't', className: 'dvv-notice-title' }, '这个视频没拿到字幕'),
          h('div', { key: 'd', className: 'dvv-note' }, doc && doc.platform === 'bilibili'
            ? 'B 站要登录 Cookie 才能读 AI 字幕。去「设置」里粘贴 SESSDATA，再重新解析。'
            : 'YouTube 视频可能没有字幕，或作者关闭了自动字幕。'),
          h('div', { key: 'a', className: 'dvv-actions' }, h('button', { type: 'button', className: 'dvv-btn', 'data-primary': 'true', onClick: onGoSettings }, '去设置')),
        ]));
      }
      const segments = transcriptSegments(doc);
      const keyword = String(query ?? '').trim().toLowerCase();
      const filtered = keyword ? segments.filter((segment) => String(segment.text ?? '').toLowerCase().includes(keyword)) : segments;
      const shown = !showAll && filtered.length > SEGMENT_LIMIT ? filtered.slice(0, SEGMENT_LIMIT) : filtered;
      return h('div', { className: 'dvv-tabpane' }, [
        h('div', { key: 'bar', className: 'dvv-segbar' }, [
          h('input', {
            key: 'q', className: 'dvv-search', value: query, placeholder: '在字幕里搜索关键词…', 'aria-label': '搜索字幕',
            onChange: (event) => onQuery(event.target.value),
          }),
          h('span', { key: 'count', className: 'dvv-note' }, `共 ${filtered.length} 条${keyword ? ` / 全部 ${segments.length} 条` : ''}`),
          h('button', { key: 'copy', type: 'button', className: 'dvv-btn', disabled: !filtered.length, onClick: () => onCopyAll(filtered) }, '复制全部'),
        ]),
        !segments.length ? h('div', { key: 'empty', className: 'dvv-note' }, '这个视频的字幕是空的。') : null,
        segments.length && !filtered.length ? h('div', { key: 'nomatch', className: 'dvv-note' }, '没有匹配的字幕。') : null,
        h('div', { key: 'list', className: 'dvv-segs' }, shown.map((segment, index) => h('button', {
          key: `seg-${index}`, type: 'button', className: 'dvv-seg',
          onClick: () => {
            onCopySegment(segment); // 原有行为：点单条复制
            const start = Number(segment.start);
            if (Number.isFinite(start)) onSeek(start); // 同时跳转播放位置
          },
        }, [
          h('span', { key: 't', className: 'dvv-seg-time' }, `[${fmtTime(segment.start)}]`),
          h('span', { key: 'x', className: 'dvv-seg-text' }, segment.text),
        ]))),
        filtered.length > SEGMENT_LIMIT && !showAll
          ? h('div', { key: 'more', className: 'dvv-actions' }, h('button', { type: 'button', className: 'dvv-btn', onClick: onShowAll }, `显示全部（${filtered.length} 条）`))
          : null,
      ].filter(Boolean));
    }

    /* -------------------------------------------------------------- 追问对话框 */

    /**
     * 左栏常驻的追问对话框：占满播放器下方的剩余高度。
     * 消息区独立滚动，输入框固定在卡片底部（不再随页签切换而卸载）。
     */
    function AskPanel({ chat, input, busy, onInput, onSend, onSeek, suggestions }) {
      const parts = [];
      const aiSuggestions = Array.isArray(suggestions) ? suggestions.slice(0, 3) : [];
      if (!chat.length) {
        parts.push(h('div', { key: 'examples', className: 'dvv-examples' }, [
          h('div', { key: 'l', className: 'dvv-note' }, '不知道问什么？从这三句开始：'),
          ...ASK_EXAMPLES.map((example) => h('button', { key: example, type: 'button', className: 'dvv-example', onClick: () => onSend(example) }, example)),
          // 这三条是模型读完本视频总结后给出的，只对本期内容成立
          aiSuggestions.length
            ? h('div', { key: 'ai-l', className: 'dvv-note dvv-note-ai' }, 'AI 看完这个视频，猜你可能想问：')
            : null,
          ...aiSuggestions.map((example) => h('button', {
            key: `ai-${example}`, type: 'button', className: 'dvv-example', 'data-ai': 'true',
            onClick: () => onSend(example),
          }, example)),
        ].filter(Boolean)));
      }
      parts.push(h('div', { key: 'chat', className: 'dvv-chat' }, chat.map((message, index) => {
        if (message.role === 'user') return h('div', { key: `m-${index}`, className: 'dvv-bubble', 'data-role': 'user' }, message.text);
        const body = [];
        if (message.text) body.push(h('div', { key: 't', className: 'dvv-md' }, renderMarkdown(message.text, onSeek)));
        if (message.error) body.push(h('div', { key: 'e', className: 'dvv-note' }, message.error));
        if (message.streaming && !message.text) body.push(h('span', { key: 'ph', className: 'dvv-note' }, message.phase || '正在思考…'));
        if (message.streaming) body.push(h('span', { key: 'c', className: 'dvv-caret' }));
        const citations = Array.isArray(message.citations) ? message.citations : [];
        if (citations.length) {
          body.push(h('div', { key: 'cites', className: 'dvv-cites' }, [
            h('span', { key: 'l', className: 'dvv-cites-label' }, '依据'),
            ...citations.map((citation, citeIndex) => h('button', {
              key: `c-${citeIndex}`, type: 'button', className: 'dvv-cite',
              title: citation.preview || `跳到 ${fmtTime(citation.start)}`,
              onClick: () => { if (typeof onSeek === 'function') onSeek(citation.start); },
            }, citationLabel(citation))),
          ]));
        }
        return h('div', { key: `m-${index}`, className: 'dvv-bubble', 'data-role': 'assistant', 'data-error': message.error ? 'true' : undefined }, body);
      })));
      return h('section', { className: 'dvv-chat-panel' }, [
        h('div', { key: 'head', className: 'dvv-chat-head' }, [
          h('span', { key: 't', className: 'dvv-chat-head-title' }, '追问'),
          h('span', { key: 'n', className: 'dvv-note' }, '基于当前视频的字幕回答'),
        ]),
        h('div', { key: 'scroll', className: 'dvv-chat-scroll' }, parts),
        h('div', { key: 'composer', className: 'dvv-composer' }, [
          h('textarea', {
            key: 'input', className: 'dvv-textarea', value: input,
            placeholder: '就这个视频继续追问，Enter 发送 / Shift+Enter 换行',
            onChange: (event) => onInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)) return;
              event.preventDefault();
              if (String(input).trim() && !busy) onSend(input);
            },
          }),
          h('button', {
            key: 'send', type: 'button', className: 'dvv-btn', 'data-primary': 'true',
            disabled: busy || !String(input).trim(), onClick: () => onSend(input),
          }, busy ? '生成中…' : '发送'),
        ]),
      ]);
    }

    /* -------------------------------------------------------------- 思维导图 */

    const EMPTY_MINDMAP = { data: null, loading: false, error: '', code: '', source: '', generatedAt: '', cached: false, cachedAt: '' };

    /** 思维导图错误 → 用户能看懂的中文。 */
    function friendlyMindmapError(error) {
      const code = String((error && error.code) || '');
      const message = String((error && error.message) || error || '未知错误');
      if (code === 'no-transcript' || /no-transcript|没有字幕|无字幕|还没有字幕|transcript/i.test(message)) {
        return '这个视频还没有字幕或本地转写，先生成字幕再生成思维导图。';
      }
      return `生成思维导图失败：${message}`;
    }

    /* ---- 图形化布局：纯计算、不读 DOM，方便单测 ---- */

    const MM_CANVAS_PAD = 18;
    const MM_GAP_X = 64;
    const MM_GAP_Y = 14;
    const MM_DEPTH_WIDTHS = [200, 170, 150];
    const MM_BRANCH_COUNT = 8;

    function mindmapNodeWidth(depth) {
      const index = Math.max(0, Math.min(Number(depth) || 0, MM_DEPTH_WIDTHS.length - 1));
      return MM_DEPTH_WIDTHS[index];
    }

    /** 估算标题在卡片里占几行（宽度决定每行字数，最多两行，超出用 CSS 截断）。 */
    function mindmapTextLines(title, width) {
      const text = String(title ?? '');
      const perLine = Math.max(6, Math.floor((width - 28) / 13));
      return text.length > perLine ? 2 : 1;
    }

    function mindmapNodeHeight(depth, title) {
      return mindmapTextLines(title, mindmapNodeWidth(depth)) > 1 ? 54 : 36;
    }

    function walkMindmap(node, path, depth, visit) {
      if (!node || typeof node !== 'object') return;
      visit(node, path, depth);
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach((child, index) => walkMindmap(child, `${path}.${index}`, depth + 1, visit));
    }

    /** 默认展开前两层（根节点 + 一级子节点）。 */
    function defaultMindmapExpanded(tree) {
      const map = {};
      walkMindmap(tree, '0', 0, (node, path, depth) => { if (depth < 2) map[path] = true; });
      return map;
    }

    function allMindmapPaths(tree) {
      const map = {};
      walkMindmap(tree, '0', 0, (node, path) => { map[path] = true; });
      return map;
    }

    /**
     * 横向树布局：根在左侧居中，一级分支向右展开，子节点继续向右。
     * 返回 { nodes, links, width, height }：
     * - nodes：{ path, depth, branch, title, width, height, x, y, hasChildren, open, childPaths }
     * - links：{ from, to, branch, d }（d 是 SVG 三次贝塞尔路径）
     * 纯函数、不依赖 DOM，测试可直接调用。
     */
    function buildMindmapLayout(tree, expanded) {
      if (!tree || typeof tree !== 'object') {
        return { nodes: [], links: [], width: MM_CANVAS_PAD * 2, height: MM_CANVAS_PAD * 2 };
      }
      const byPath = new Map();
      const order = [];
      const depthWidths = [];
      const buildNode = (node, path, depth, branch) => {
        const title = String(node?.title ?? '');
        const children = Array.isArray(node?.children)
          ? node.children.filter((child) => child && typeof child === 'object')
          : [];
        const width = mindmapNodeWidth(depth);
        const record = {
          path,
          depth,
          branch,
          title,
          width,
          height: mindmapNodeHeight(depth, title),
          x: 0,
          y: 0,
          hasChildren: children.length > 0,
          open: children.length > 0 && Boolean(expanded && expanded[path]),
          childPaths: [],
        };
        depthWidths[depth] = Math.max(depthWidths[depth] || 0, width);
        byPath.set(path, record);
        order.push(record);
        if (record.open) {
          children.forEach((child, index) => {
            const childPath = `${path}.${index}`;
            const childBranch = depth === 0 ? index % MM_BRANCH_COUNT : branch;
            record.childPaths.push(childPath);
            buildNode(child, childPath, depth + 1, childBranch);
          });
        }
        return record;
      };
      const root = buildNode(tree, '0', 0, 0);

      // x：每层宽度取该层最宽节点，逐层向右累加；同层节点左对齐
      const columnX = [];
      let cursorX = MM_CANVAS_PAD;
      for (let depth = 0; depth < depthWidths.length; depth += 1) {
        columnX[depth] = cursorX;
        cursorX += (depthWidths[depth] || 0) + MM_GAP_X;
      }
      for (const record of order) record.x = columnX[record.depth] ?? MM_CANVAS_PAD;

      // y：叶子按顺序垂直排开，父节点居中于首尾子节点之间
      let leafCursor = MM_CANVAS_PAD;
      const place = (record) => {
        if (record.open && record.childPaths.length) {
          const kids = record.childPaths.map((childPath) => byPath.get(childPath)).filter(Boolean);
          kids.forEach(place);
          record.y = (kids[0].y + kids[kids.length - 1].y) / 2;
        } else {
          record.y = leafCursor + record.height / 2;
          leafCursor += record.height + MM_GAP_Y;
        }
        return record;
      };
      place(root);

      // 连线：父节点右边缘中点 → 子节点左边缘中点
      const links = [];
      for (const record of order) {
        for (const childPath of record.childPaths) {
          const child = byPath.get(childPath);
          if (!child) continue;
          const x1 = record.x + record.width;
          const y1 = record.y;
          const x2 = child.x;
          const y2 = child.y;
          const curve = Math.max(26, Math.round((x2 - x1) * 0.55));
          links.push({
            from: record.path,
            to: child.path,
            branch: child.branch,
            d: `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`,
          });
        }
      }

      const width = Math.max(cursorX - MM_GAP_X + MM_CANVAS_PAD, MM_CANVAS_PAD * 2);
      const height = Math.max(leafCursor - MM_GAP_Y + MM_CANVAS_PAD, MM_CANVAS_PAD * 2);
      return { nodes: order, links, width, height };
    }

    /** 一个图形化导图节点：绝对定位卡片，点击折叠/展开子分支。 */
    function MindGraphNode({ record, onToggle }) {
      const toggle = record.hasChildren ? () => onToggle(record.path) : undefined;
      return h('div', {
        className: `dvv-mm2-node dvv-mm-branch-${record.branch}`,
        'data-depth': String(record.depth),
        'data-open': record.open ? 'true' : 'false',
        title: record.title,
        style: {
          left: `${Math.round(record.x)}px`,
          top: `${Math.round(record.y - record.height / 2)}px`,
          width: `${record.width}px`,
          height: `${record.height}px`,
        },
        onClick: toggle,
      }, [
        h('span', { key: 't', className: 'dvv-mm2-title' }, record.title || '（空节点）'),
        record.hasChildren
          ? h('span', { key: 'c', className: 'dvv-mm2-count', 'aria-hidden': 'true' }, record.open ? '▾' : '▸')
          : null,
      ].filter(Boolean));
    }

    /** 思维导图页签：loading / 错误（含 no-transcript 引导）/ 横向树状图。 */
    function MindmapTab({ doc, mindmap, expanded, onRetry, onExpandAll, onCollapseAll, onToggle, onGoTranscript }) {
      const [zoom, setZoom] = useState(1);
      const layout = mindmap.data && !mindmap.loading && !mindmap.error
        ? buildMindmapLayout(mindmap.data, expanded)
        : null;
      const zoomBy = (delta) => setZoom((current) => Math.min(1.6, Math.max(0.5, Math.round((current + delta) * 10) / 10)));
      const bar = h('div', { key: 'bar', className: 'dvv-mm-bar' }, [
        h('span', { key: 't', className: 'dvv-mm-bar-title' }, '思维导图'),
        h('div', { key: 's', className: 'dvv-spacer' }),
        h('button', { key: 'all', type: 'button', className: 'dvv-btn', disabled: !mindmap.data, onClick: onExpandAll }, '全部展开'),
        h('button', { key: 'none', type: 'button', className: 'dvv-btn', disabled: !mindmap.data, onClick: onCollapseAll }, '全部收起'),
        h('button', { key: 'zout', type: 'button', className: 'dvv-btn', disabled: !layout, onClick: () => zoomBy(-0.1) }, '缩小'),
        h('span', { key: 'z', className: 'dvv-mm-zoom' }, `${Math.round(zoom * 100)}%`),
        h('button', { key: 'zin', type: 'button', className: 'dvv-btn', disabled: !layout, onClick: () => zoomBy(0.1) }, '放大'),
        h('button', { key: 'again', type: 'button', className: 'dvv-btn', disabled: mindmap.loading, onClick: onRetry }, mindmap.loading ? '生成中…' : '重新生成'),
      ]);
      let body;
      if (mindmap.loading) {
        body = h('div', { key: 'loading', className: 'dvv-loading-block' }, [
          h('span', { key: 's', className: 'dvv-spinner' }),
          h('span', { key: 't' }, '正在生成思维导图…'),
        ]);
      } else if (mindmap.error) {
        const canRetry = mindmap.code === 'no-transcript' && doc && !hasTranscript(doc);
        body = h('div', { key: 'error', className: 'dvv-error dvv-mm-error' }, [
          h('div', { key: 'm' }, mindmap.error),
          canRetry ? h('button', {
            key: 'go', type: 'button', className: 'dvv-btn', 'data-primary': 'true', onClick: onGoTranscript,
          }, '本地转写') : null,
        ].filter(Boolean));
      } else if (!mindmap.data) {
        body = h('div', { key: 'empty', className: 'dvv-note' }, '还没有生成思维导图。点「重新生成」开始。');
      } else if (!layout || !layout.nodes.length) {
        body = h('div', { key: 'empty', className: 'dvv-note' }, '导图内容是空的。点「重新生成」再试一次。');
      } else {
        const edges = h('svg', {
          key: 'edges',
          className: 'dvv-mm2-svg',
          width: layout.width,
          height: layout.height,
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          'aria-hidden': 'true',
          focusable: 'false',
        }, layout.links.map((link) => h('path', {
          key: `${link.from}->${link.to}`,
          className: `dvv-mm2-link dvv-mm-branch-${link.branch}`,
          d: link.d,
          fill: 'none',
        })));
        const cards = layout.nodes.map((record) => h(MindGraphNode, { key: record.path, record, onToggle }));
        const inner = h('div', {
          key: 'inner',
          className: 'dvv-mm2-inner',
          style: {
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
          },
        }, [edges].concat(cards));
        body = h('div', { key: 'canvas', className: 'dvv-mm2-scroll' }, h('div', {
          key: 'box',
          className: 'dvv-mm2-box',
          style: { width: `${Math.round(layout.width * zoom)}px`, height: `${Math.round(layout.height * zoom)}px` },
          'data-nodes': String(layout.nodes.length),
          'data-links': String(layout.links.length),
        }, inner));
      }
      const metaBits = [];
      if (mindmap.source) metaBits.push(`来源：${mindmap.source === 'llm' ? '当前模型' : mindmap.source}`);
      if (mindmap.cached && mindmap.generatedAt) metaBits.push(`已缓存 · ${fmtRelative(mindmap.generatedAt)}`);
      else if (mindmap.generatedAt) metaBits.push(`生成于 ${fmtRelative(mindmap.generatedAt)}`);
      return h('div', { className: 'dvv-tabpane dvv-mm' }, [
        bar,
        metaBits.length ? h('div', { key: 'meta', className: 'dvv-mm-meta dvv-note' }, metaBits.join(' · ')) : null,
        body,
      ].filter(Boolean));
    }

    /* ---------------------------------------------------------- 历史列表 / 抽屉 */

    /** 封面缩略图：没有 cover 或加载失败时用纯色占位。 */
    function HistoryCover({ src, alt }) {
      const [broken, setBroken] = useState(false);
      const url = String(src ?? '');
      if (!url || broken) return h('div', { className: 'dvv-hist-cover dvv-hist-cover-ph', 'aria-hidden': 'true' });
      return h('img', { className: 'dvv-hist-cover', src: url, alt: alt ?? '', loading: 'lazy', onError: () => setBroken(true) });
    }

    /** 一条历史记录：封面、标题、作者/时长、平台标签、相对时间、字幕标记、删除。 */
    function HistoryRow({ item, onOpen, onRemove }) {
      const platform = item.platform || guessPlatform(item.url);
      const duration = Number(item.duration) > 0 ? fmtTime(item.duration) : '';
      return h('div', {
        className: 'dvv-hist', role: 'button', tabIndex: 0,
        onClick: () => onOpen(item),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item); } },
      }, [
        h(HistoryCover, { key: 'cover', src: item.cover, alt: item.title }),
        h('div', { key: 'main', className: 'dvv-hist-main' }, [
          h('div', { key: 'title', className: 'dvv-hist-title' }, item.title || '(无标题视频)'),
          h('div', { key: 'sub', className: 'dvv-hist-sub' }, [
            item.author ? h('span', { key: 'author', className: 'dvv-hist-author' }, item.author) : null,
            duration ? h('span', { key: 'dur' }, duration) : null,
          ].filter(Boolean)),
          h('div', { key: 'meta', className: 'dvv-hist-meta' }, [
            h(PlatformBadge, { key: 'p', platform, compact: true }),
            h('span', { key: 'when' }, fmtRelative(item.analyzedAt)),
            h('span', { key: 'cap', className: 'dvv-mini', 'data-ok': item.hasTranscript ? 'true' : 'false' }, item.hasTranscript ? '字幕' : '无字幕'),
            item.hasSummary ? h('span', { key: 'sum', className: 'dvv-mini' }, '总结') : null,
            item.hasChapters ? h('span', { key: 'ch', className: 'dvv-mini' }, '章节') : null,
            item.hasMindmap ? h('span', { key: 'mm', className: 'dvv-mini' }, '导图') : null,
            Number(item.chatCount) > 0 ? h('span', { key: 'chat', className: 'dvv-mini' }, `${Number(item.chatCount)} 条对话`) : null,
          ]),
        ]),
        onRemove ? h('button', {
          key: 'del', type: 'button', className: 'dvv-del', title: '删除这条记录', 'aria-label': '删除这条记录',
          onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            onRemove(item);
          },
        }, '×') : null,
      ].filter(Boolean));
    }

    /** 无视频空态时直接铺在主区的历史列表（复用抽屉里的行）。 */
    function HistoryList({ items, onOpen, onRemove }) {
      if (!Array.isArray(items) || !items.length) return null;
      return h('section', { className: 'dvv-recent' }, [
        h('div', { key: 'head', className: 'dvv-recent-head' }, [
          h('span', { key: 't', className: 'dvv-label' }, '最近分析'),
          h('span', { key: 'c', className: 'dvv-note' }, `共 ${items.length} 条`),
        ]),
        h('div', { key: 'list', className: 'dvv-hist-list' }, items.map((item, index) => h(HistoryRow, {
          key: `${item.docId || item.url || 'item'}-${index}`, item, onOpen, onRemove,
        }))),
      ]);
    }

    function HistoryDrawer({ items, error, onOpen, onRemove, onClear, onClose }) {
      const [confirming, setConfirming] = useState(false);
      const list = Array.isArray(items) ? items : [];
      return h('div', { className: 'dvv-overlay', onClick: onClose }, h('div', {
        key: 'drawer', className: 'dvv-drawer', onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); },
      }, [
        h('div', { key: 'head', className: 'dvv-drawer-head' }, [
          h('div', { key: 't', className: 'dvv-drawer-title' }, `历史记录${list.length ? ` · ${list.length}` : ''}`),
          h('button', { key: 'close', type: 'button', className: 'dvv-btn', onClick: onClose }, '关闭'),
        ]),
        h('div', { key: 'body', className: 'dvv-drawer-body' }, [
          error ? h('div', { key: 'err', className: 'dvv-error' }, error) : null,
          list.length ? list.map((item, index) => h(HistoryRow, {
            key: `${item.docId || item.url || 'item'}-${index}`, item,
            onOpen: (picked) => { setConfirming(false); onOpen(picked); },
            onRemove,
          })) : h('div', { key: 'empty', className: 'dvv-empty-note' }, '还没有分析记录。解析过的视频会出现在这里，最多保留 20 条。'),
        ].filter(Boolean)),
        h('div', { key: 'foot', className: 'dvv-drawer-foot' }, [
          h('button', {
            key: 'clear', type: 'button', className: 'dvv-btn', disabled: !list.length,
            'data-danger': confirming ? 'true' : undefined,
            onClick: () => { if (!confirming) { setConfirming(true); return; } setConfirming(false); onClear(); },
          }, confirming ? '确认清空？' : '清空历史'),
          confirming ? h('button', { key: 'cancel', type: 'button', className: 'dvv-btn', onClick: () => setConfirming(false) }, '取消') : null,
        ].filter(Boolean)),
      ]));
    }

    /* ---------------------------------------------------- 设置：本地语音转写 */

    /** 设置里的小数字输入：失焦 / 回车时提交，空值或越界会被夹紧。 */
    function AsrNumberField({ label, value, min, max, hint, onCommit }) {
      const [draft, setDraft] = useState(String(value ?? 0));
      useEffect(() => { setDraft(String(value ?? 0)); }, [value]);
      const commit = () => {
        const number = Number(draft);
        const fallback = Number(value) || 0;
        const next = Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
        setDraft(String(next));
        if (next !== Number(value ?? 0)) onCommit(next);
      };
      return h('label', { className: 'dvv-asr-field' }, [
        h('span', { key: 'l', className: 'dvv-label' }, label),
        h('input', {
          key: 'i', className: 'dvv-input dvv-input-sm', type: 'number', min, max, value: draft,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } },
        }),
        hint ? h('span', { key: 'h', className: 'dvv-note' }, hint) : null,
      ].filter(Boolean));
    }

    /**
     * 视觉模型输入框：留空表示用会话默认模型；blur/Enter 时提交，空串就是清空。
     */
    function VisionModelField({ value, onCommit }) {
      const [draft, setDraft] = useState(String(value ?? ''));
      useEffect(() => { setDraft(String(value ?? '')); }, [value]);
      const commit = () => {
        const next = String(draft ?? '').trim();
        setDraft(next);
        if (next !== String(value ?? '')) onCommit(next);
      };
      return h('input', {
        className: 'dvv-input', type: 'text', value: draft, placeholder: VISION_MODEL_PLACEHOLDER,
        'aria-label': '视觉模型', spellCheck: false,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } },
      });
    }

    /**
     * 设置里的「本地语音转写」区块：开关 / 引擎 / 线程数 / 时长上限 / 保留音频 /
     * 本机组件与模型路径 / host 返回的安装提示。改任一设置都会立即 POST 生效。
     */
    function AsrSection({ asr, saving, note, error, onConfig }) {
      if (!asr) {
        return h('div', { className: 'dvv-asr-box' }, [
          h('div', { key: 't', className: 'dvv-label' }, '本地语音转写'),
          h('div', { key: 'e', className: 'dvv-note' }, error ? `本地转写状态读取失败：${error}（点右上角「刷新状态」重试）` : '正在读取本地转写状态…'),
        ]);
      }
      const config = asr.config || {};
      const tools = asr.tools || {};
      const models = asr.models || {};
      const engines = asr.engines || {};
      const hints = Array.isArray(asr.hints) ? asr.hints.filter(Boolean) : [];
      const whisperModel = (models.whisper || {}).path || '';
      const senseVoice = models.sensevoice || {};
      const engineLabel = (key) => {
        const meta = engines[key];
        return `${(meta && meta.label) || key}${meta && meta.available === false ? '（未就绪）' : ''}`;
      };
      const rows = [
        h('div', { key: 'head', className: 'dvv-asr-head' }, [
          h('span', { key: 't', className: 'dvv-label' }, '本地语音转写'),
          saving ? h('span', { key: 'saving', className: 'dvv-note' }, '保存中…') : null,
        ].filter(Boolean)),
      ];
      if (asr.privacy) rows.push(h('div', { key: 'privacy', className: 'dvv-asr-privacy' }, String(asr.privacy)));
      if (asr.ready === false) {
        rows.push(h('div', { key: 'miss', className: 'dvv-warn' }, `本机转写组件还没装好：${hints[0] || '缺少 ffmpeg / whisper / sherpa 之一'}。装好后点「刷新状态」重新检测。`));
      }
      if (asr.downloadReady === false) {
        rows.push(h('div', { key: 'dl', className: 'dvv-note' }, '提示：下载视频音轨需要 yt-dlp；ffmpeg 用于提取与转换音频。'));
      }
      rows.push(h('label', { key: 'enabled', className: 'dvv-check' }, [
        h('input', { key: 'c', type: 'checkbox', checked: Boolean(asr.enabled), onChange: () => onConfig({ enabled: !asr.enabled }) }),
        h('span', { key: 't' }, asr.enabled ? '已开启：无字幕视频可以在这台电脑上转写' : '已关闭：无字幕视频不会转写'),
      ]));
      rows.push(h('label', { key: 'auto', className: 'dvv-check' }, [
        h('input', {
          key: 'c', type: 'checkbox', checked: config.autoTranscribe !== false,
          onChange: () => onConfig({ autoTranscribe: config.autoTranscribe === false }),
        }),
        h('span', { key: 't' }, '无字幕视频自动转写（解析到没有字幕的视频时自动在本地跑一次转写，长视频可能要等一会儿）'),
      ]));
      const ocr = asr.ocr || {};
      rows.push(h('label', { key: 'ocr', className: 'dvv-check' }, [
        h('input', {
          key: 'c', type: 'checkbox', checked: config.ocrFallback !== false,
          onChange: () => onConfig({ ocrFallback: config.ocrFallback === false }),
        }),
        h('span', { key: 't' }, `没有语音时识别画面文字（OCR）：${ocr.available ? '可用' : `不可用${ocr.reason ? ` · ${ocr.reason}` : ''}`}${ocr.available ? '（纯音乐/无声视频也能出文字稿）' : ''}`),
      ]));
      if (ocr.available && ocr.note) {
        rows.push(h('div', { key: 'ocr-note', className: 'dvv-note' }, String(ocr.note)));
      }
      rows.push(h('div', { key: 'ocr-numbers', className: 'dvv-asr-grid' }, [
        h(AsrNumberField, {
          key: 'ocr-interval', label: '抽帧间隔（秒）', value: config.ocrIntervalSeconds ?? 8, min: 3, max: 60,
          hint: '越小越细但更慢', onCommit: (number) => onConfig({ ocrIntervalSeconds: number }),
        }),
        h(AsrNumberField, {
          key: 'ocr-frames', label: '最多识别帧数', value: config.ocrMaxFrames ?? 120, min: 20, max: 240,
          hint: '默认 120 帧', onCommit: (number) => onConfig({ ocrMaxFrames: number }),
        }),
      ]));
      rows.push(h('div', { key: 'ocr-privacy', className: 'dvv-note' }, '空间识别用 macOS 自带的 Vision 框架离线完成，视频和画面都不会上传。'));

      // 「画面理解」子区块：没有可用文字时，用视觉模型看抽样画面（图片会离开本机）。
      const vision = asr.vision || {};
      const visionConfig = vision.config || {};
      const frameMode = String(config.frameMode || visionConfig.frameMode || 'auto');
      const visionMode = String(vision.mode || frameMode);
      const visionMaxFrames = config.visionMaxFrames ?? visionConfig.visionMaxFrames ?? 48;
      const visionModelValue = String(config.visionModel ?? visionConfig.visionModel ?? '');
      const candidates = Array.isArray(vision.candidates) ? vision.candidates : [];
      const candidateLabels = candidates
        .map((item) => (typeof item === 'string' ? item : String((item && (item.routeLabel || item.label || item.model)) || '')))
        .filter(Boolean);
      rows.push(h('div', { key: 'vision-head', className: 'dvv-label' }, '画面理解（视觉模型）'));
      rows.push(h('div', { key: 'vision-mode', className: 'dvv-vseg', role: 'group', 'aria-label': '画面理解模式' },
        FRAME_MODES.map(([key, label]) => h('button', {
          key, type: 'button', className: 'dvv-vseg-btn',
          'data-active': frameMode === key ? 'true' : undefined,
          'aria-pressed': frameMode === key ? 'true' : 'false',
          title: FRAME_MODE_DESC[key] || label,
          onClick: () => onConfig({ frameMode: key }),
        }, label))));
      rows.push(h('div', { key: 'vision-mode-desc', className: 'dvv-note' }, FRAME_MODE_DESC[frameMode] || FRAME_MODE_DESC.auto));
      if (vision.available) {
        const route = String(vision.routeLabel || [vision.provider, vision.model].filter(Boolean).join('/') || '未命名模型');
        rows.push(h('div', { key: 'vision-state', className: 'dvv-cap' }, [
          h('span', { key: 'd', className: 'dvv-cap-dot', 'data-ok': 'true' }),
          h('span', { key: 't', className: 'dvv-cap-text' }, `画面理解可用 · ${route}${visionMode && visionMode !== frameMode ? `（当前实际：${visionMode}）` : ''}`),
        ]));
      } else {
        rows.push(h('div', { key: 'vision-state', className: 'dvv-warn' },
          [
            `画面理解不可用${vision.reason ? `：${vision.reason}` : '：当前没有可用的视觉模型或附件服务'}`,
            candidateLabels.length ? `可切换为 ${candidateLabels.slice(0, 2).join('、')}` : '',
          ].filter(Boolean).join('；')));
      }
      if (vision.supportsImage === false) {
        rows.push(h('div', { key: 'vision-image', className: 'dvv-note' }, '当前模型不支持图片输入：请改用「自动」或「仅画面文字」。'));
      }
      rows.push(h('div', { key: 'vision-model', className: 'dvv-asr-field' }, [
        h('span', { key: 'l', className: 'dvv-label' }, '视觉模型'),
        h(VisionModelField, { key: 'i', value: visionModelValue, onCommit: (text) => onConfig({ visionModel: text }) }),
        h('span', { key: 'h', className: 'dvv-note' }, '留空 = 使用会话默认模型；可填 provider/model 覆盖'),
      ]));
      rows.push(h('div', { key: 'vision-numbers', className: 'dvv-asr-grid' }, [
        h(AsrNumberField, {
          key: 'vision-frames', label: '画面理解最多帧数', value: visionMaxFrames, min: 8, max: 160,
          hint: '每帧约 2-4 秒；可填 8–160 帧', onCommit: (number) => onConfig({ visionMaxFrames: number }),
        }),
      ]));
      if (vision.privacy) {
        rows.push(h('div', { key: 'vision-privacy', className: 'dvv-note' }, String(vision.privacy)));
      }
      rows.push(h('div', { key: 'engine', className: 'dvv-asr-row' }, [
        h('span', { key: 'l', className: 'dvv-label' }, '识别引擎'),
        h('select', {
          key: 's', className: 'dvv-select', value: String(asr.engine || 'auto'), 'aria-label': '识别引擎',
          onChange: (event) => onConfig({ engine: event.target.value }),
        }, ASR_ENGINES.map(([key, label]) => h('option', {
          key, value: key, disabled: Boolean(engines[key] && engines[key].available === false),
        }, label))),
        h('span', { key: 'cur', className: 'dvv-note' }, `当前使用：${asr.activeEngine ? engineLabel(asr.activeEngine) : (asr.engineLabel || '未知')}`),
      ]));
      rows.push(h('div', { key: 'numbers', className: 'dvv-asr-grid' }, [
        h(AsrNumberField, {
          key: 'threads', label: '线程数', value: config.threads ?? 0, min: 0, max: 32,
          hint: '0 = 自动', onCommit: (number) => onConfig({ threads: number }),
        }),
        h(AsrNumberField, {
          key: 'seconds', label: '最长处理时长（秒）', value: config.maxSeconds ?? 0, min: 0, max: 7200,
          hint: '0 = 不限制；只处理前 N 秒可以明显加速', onCommit: (number) => onConfig({ maxSeconds: number }),
        }),
      ]));
      rows.push(h('label', { key: 'keep', className: 'dvv-check' }, [
        h('input', { key: 'c', type: 'checkbox', checked: Boolean(config.keepAudio), onChange: () => onConfig({ keepAudio: !config.keepAudio }) }),
        h('span', { key: 't' }, '保留临时音频（~/.dsh/video-models/last-audio.*，默认不保留）'),
      ]));
      rows.push(h('div', { key: 'tools', className: 'dvv-label' }, '本机组件'));
      ASR_TOOLS.forEach(([key, label]) => {
        const tool = tools[key] || {};
        const available = Boolean(tool.available);
        rows.push(h('div', { key: `tool-${key}`, className: 'dvv-cap' }, [
          h('span', { key: 'd', className: 'dvv-cap-dot', 'data-ok': available ? 'true' : 'false' }),
          h('span', { key: 'n', className: 'dvv-cap-text' }, `${label}：${available ? '可用' : '未找到'}${tool.path ? ` · ${tool.path}` : ''}`),
        ]));
      });
      rows.push(h('div', { key: 'models', className: 'dvv-asr-models' }, [
        h('div', { key: 'l', className: 'dvv-label' }, '本地模型'),
        h('div', { key: 'w', className: 'dvv-kv' }, [
          h('span', { key: 'k', className: 'dvv-label' }, 'Whisper'),
          h('span', { key: 'v', className: 'dvv-mono' }, whisperModel || '未下载（首次转写会按设置自动下载）'),
        ]),
        h('div', { key: 'sv', className: 'dvv-kv' }, [
          h('span', { key: 'k', className: 'dvv-label' }, 'SenseVoice'),
          h('span', { key: 'v', className: 'dvv-mono' }, senseVoice.modelPath ? `${senseVoice.modelPath}${senseVoice.tokensPath ? ` · ${senseVoice.tokensPath}` : ''}` : '未下载'),
        ]),
      ]));
      hints.forEach((hint, index) => {
        rows.push(h('div', { key: `hint-${index}`, className: 'dvv-note' }, `提示：${hint}`));
      });
      if (note) rows.push(h('div', { key: 'note', className: 'dvv-note' }, note));
      if (error) rows.push(h('div', { key: 'error', className: 'dvv-error' }, error));
      return h('div', { className: 'dvv-asr-box' }, rows);
    }

    /* -------------------------------------------------------------- 设置弹层 */

    function SettingsModal({ status, cookie, saving, note, onCookie, onSave, onClear, onClose, onRefresh, asr, asrSaving, asrNote, asrError, onAsrConfig, doc, onClearAnalysis, onClearChat }) {
      // 「清空本视频分析缓存」的二次确认只影响当前打开的视频。
      const [confirmCache, setConfirmCache] = useState(false);
      const model = status && status.model ? `${status.model.provider ?? '?'} · ${status.model.model ?? '?'}` : '未获取到（插件主机可能还没就绪）';
      const biliCookie = Boolean(status && status.bilibili && status.bilibili.cookie);
      return h('div', { className: 'dvv-overlay', onClick: onClose }, h('div', {
        key: 'modal', className: 'dvv-modal', role: 'dialog', 'aria-modal': 'true', onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); },
      }, [
        h('div', { key: 'head', className: 'dvv-drawer-head' }, [
          h('div', { key: 't', className: 'dvv-drawer-title' }, '设置'),
          h('button', { key: 'refresh', type: 'button', className: 'dvv-btn', onClick: onRefresh }, '刷新状态'),
          h('button', { key: 'close', type: 'button', className: 'dvv-btn', onClick: onClose }, '关闭'),
        ]),
        h('div', { key: 'body', className: 'dvv-drawer-body' }, [
          h('div', { key: 'status', className: 'dvv-status-box' }, [
            h('div', { key: 'model', className: 'dvv-kv' }, [h('span', { key: 'l', className: 'dvv-label' }, '当前模型'), h('span', { key: 'v' }, model)]),
            h('div', { key: 'cookie', className: 'dvv-kv' }, [
              h('span', { key: 'l', className: 'dvv-label' }, 'B 站 Cookie'),
              h('span', { key: 'v' }, biliCookie ? '已配置' : '未配置'),
            ]),
            status && status.version ? h('div', { key: 'ver', className: 'dvv-note' }, `dsh-video v${status.version}`) : null,
          ].filter(Boolean)),
          h('div', { key: 'field', className: 'dvv-field' }, [
            h('div', { key: 'l', className: 'dvv-label' }, 'B 站 Cookie（SESSDATA）'),
            h('textarea', {
              key: 't', className: 'dvv-textarea', value: cookie,
              placeholder: biliCookie
                ? '已保存。留空保存表示不修改；要清除请点「清除」。'
                : '浏览器 F12 → Application → Cookies → bilibili.com，复制 SESSDATA；整串或只填 SESSDATA=xxx 都可以',
              onChange: (event) => onCookie(event.target.value),
            }),
            h('div', { key: 'h', className: 'dvv-note' }, 'B 站读 AI 字幕、官方总结需要登录态；YouTube 不需要 Cookie。凭证只写在本机 ~/.dsh/video-credentials.json（权限 600）。'),
          ]),
          h('div', { key: 'actions', className: 'dvv-actions' }, [
            h('button', { key: 'save', type: 'button', className: 'dvv-btn', 'data-primary': 'true', disabled: saving, onClick: () => onSave(cookie) }, saving ? '保存中…' : '保存'),
            h('button', { key: 'clear', type: 'button', className: 'dvv-btn', disabled: saving, onClick: () => onClear() }, '清除'),
            note ? h('span', { key: 'note', className: 'dvv-note' }, note) : null,
          ].filter(Boolean)),
          h('div', { key: 'caps', className: 'dvv-caps' }, [
            h('div', { key: 'label', className: 'dvv-label' }, '各平台字幕能力'),
            h(CapabilityRow, { key: 'yt', name: 'YouTube', ok: Boolean(status && status.platforms && status.platforms.youtube !== false), text: '官方字幕 / 自动识别音轨，无需 Cookie 直接可读。' }),
            h(CapabilityRow, {
              key: 'bili', name: '哔哩哔哩', ok: biliCookie,
              text: biliCookie ? '已配置 Cookie：可读 AI 字幕、B 站官方总结与分 P 信息。' : '未配置 Cookie：只能读标题、封面、时长等元信息，拿不到 AI 字幕。',
            }),
          ]),
          doc ? h('div', { key: 'cache', className: 'dvv-cache-box' }, [
            h('div', { key: 'head', className: 'dvv-cache-head' }, [
              h('span', { key: 'l', className: 'dvv-label' }, '本视频分析缓存'),
              h('span', { key: 't', className: 'dvv-note' }, doc.analysis && doc.analysis.savedAt ? `已缓存 · ${fmtRelative(doc.analysis.savedAt)}` : '暂无缓存'),
            ]),
            h('div', { key: 'id', className: 'dvv-mono' }, String(doc.docId || '')),
            h('div', { key: 'acts', className: 'dvv-actions' }, [
              h('button', {
                key: 'chat', type: 'button', className: 'dvv-btn',
                onClick: () => { setConfirmCache(false); onClearChat(doc); },
              }, '清空对话'),
              h('button', {
                key: 'all', type: 'button', className: 'dvv-btn',
                'data-danger': confirmCache ? 'true' : undefined,
                onClick: () => {
                  if (!confirmCache) { setConfirmCache(true); return; }
                  setConfirmCache(false);
                  onClearAnalysis(doc);
                },
              }, confirmCache ? '确认清空？' : '清空本视频分析缓存'),
              confirmCache ? h('button', { key: 'cancel', type: 'button', className: 'dvv-btn', onClick: () => setConfirmCache(false) }, '取消') : null,
            ].filter(Boolean)),
            h('div', { key: 'hint', className: 'dvv-note' }, '只清 host 保存的总结 / 章节 / 导图 / 对话，不影响视频本身与字幕；清空后可以重新生成。'),
          ]) : null,
          h(AsrSection, {
            key: 'asr', asr, saving: asrSaving, note: asrNote, error: asrError,
            onConfig: onAsrConfig,
          }),
        ]),
      ]));
    }

    /* ------------------------------------------------------------------ 主面板 */

    function VideoPanel() {
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState('');
      const [url, setUrl] = useState('');
      const [doc, setDoc] = useState(null);
      const [resolveBusy, setResolveBusy] = useState(false);
      const [error, setError] = useState('');
      const [tab, setTab] = useState('summary');
      const [summary, setSummary] = useState(EMPTY_SUMMARY);
      const [chapters, setChapters] = useState(EMPTY_CHAPTERS);
      const [openChapter, setOpenChapter] = useState(-1);
      const [segQuery, setSegQuery] = useState('');
      const [segAll, setSegAll] = useState(false);
      const [chat, setChat] = useState([]);
      const [askInput, setAskInput] = useState('');
      const [askBusy, setAskBusy] = useState(false);
      const [overlay, setOverlay] = useState('');
      const [cookie, setCookie] = useState('');
      const [savingCookie, setSavingCookie] = useState(false);
      const [cookieNote, setCookieNote] = useState('');
      const [historyItems, setHistoryItems] = useState([]);
      const [historyError, setHistoryError] = useState('');
      const [playerCollapsed, setPlayerCollapsed] = useState(() => readPlayerCollapsed());
      const [toast, setToast] = useState('');
      const [asr, setAsr] = useState(null);
      const [asrError, setAsrError] = useState('');
      const [asrSaving, setAsrSaving] = useState(false);
      const [asrNote, setAsrNote] = useState('');
      const [transcribe, setTranscribe] = useState(EMPTY_TRANSCRIBE);
      const [mindmap, setMindmap] = useState(EMPTY_MINDMAP);
      const [mmExpanded, setMmExpanded] = useState({});

      const mounted = useRef(true);
      /** 同一时刻只允许一条在途请求（解析或流式），切视频 / 新请求前 abort。 */
      const active = useRef(null);
      const docRef = useRef(null);
      const chatRef = useRef([]);
      const askBusyRef = useRef(false);
      const resolveTicket = useRef(0);
      const toastTimer = useRef(0);
      const frameRef = useRef(null);
      /** YouTube 的 seek 要等 iframe 加载完再补发。 */
      const pendingSeek = useRef(null);
      /** 自动转写判重：docId → running | done | cancelled | failed | manual（同一视频不重复自动触发）。 */
      const autoAsrRef = useRef(new Map());
      docRef.current = doc;
      chatRef.current = chat;

      /* ---- 通用：toast / 复制 / 状态 ---- */

      const showToast = useCallback((message) => {
        if (!mounted.current) return;
        setToast(String(message ?? ''));
        if (typeof window.setTimeout !== 'function') return;
        try { window.clearTimeout(toastTimer.current); } catch { /* ignore */ }
        toastTimer.current = window.setTimeout(() => { if (mounted.current) setToast(''); }, 1600);
      }, []);

      const copy = useCallback(async (text, okMessage) => {
        const ok = await copyText(text);
        showToast(ok ? (okMessage || '已复制') : '复制失败，请手动选中文本复制');
        return ok;
      }, [showToast]);

      const refreshStatus = useCallback(async () => {
        try {
          const value = await call('status');
          if (!mounted.current) return;
          setStatus(value || {});
          setStatusError('');
        } catch (caught) {
          if (!mounted.current) return;
          setStatus(null);
          setStatusError(String(caught?.message ?? caught));
        }
      }, []);

      /* ---- 本地语音转写：状态与设置（GET /asr/status、POST /asr/config） ---- */

      const refreshAsr = useCallback(async () => {
        try {
          const value = await call('asr/status');
          if (!mounted.current) return;
          setAsr(value || {});
          setAsrError('');
        } catch (caught) {
          if (!mounted.current) return;
          setAsr(null);
          setAsrError(String(caught?.message ?? caught));
        }
      }, []);

      /** 保存一项转写设置：host 返回最新状态直接替换，失败保留原状态并写错误。 */
      const submitAsrConfig = useCallback(async (patch) => {
        setAsrSaving(true);
        setAsrNote('');
        setAsrError('');
        try {
          const value = await post('asr/config', patch || {});
          if (!mounted.current) return;
          if (value && typeof value === 'object' && ('enabled' in value || 'config' in value)) setAsr(value);
          else await refreshAsr();
          if (mounted.current) setAsrNote('已保存，立即生效');
        } catch (caught) {
          if (mounted.current) setAsrError(`保存失败：${String(caught?.message ?? caught)}`);
        } finally {
          if (mounted.current) setAsrSaving(false);
        }
      }, [refreshAsr]);

      /* ---- 历史：host 持久化（GET /history、POST /history/clear|remove） ---- */

      const refreshHistory = useCallback(async () => {
        try {
          const value = await call('history');
          if (!mounted.current) return;
          const items = value && Array.isArray(value.items) ? value.items.filter(Boolean).slice(0, HISTORY_LIMIT) : [];
          setHistoryItems(items);
          setHistoryError('');
        } catch (caught) {
          if (mounted.current) setHistoryError(`历史记录加载失败：${String(caught?.message ?? caught)}`);
        }
      }, []);

      /** host 返回完整列表，直接替换本地状态（20 条上限由 host 保证，这里再裁一次）。 */
      const applyHistory = useCallback((value) => {
        const items = value && Array.isArray(value.items) ? value.items.filter(Boolean).slice(0, HISTORY_LIMIT) : [];
        setHistoryItems(items);
        setHistoryError('');
      }, []);

      const removeHistory = useCallback(async (item) => {
        const docId = String((item && item.docId) || '');
        if (!docId) { showToast('这条记录缺少 docId，无法删除'); return; }
        try {
          const value = await post('history/remove', { docId });
          if (!mounted.current) return;
          applyHistory(value);
          showToast('已删除这条记录');
        } catch (caught) {
          if (mounted.current) showToast(`删除失败：${String(caught?.message ?? caught)}`);
        }
      }, [applyHistory, showToast]);

      const clearHistory = useCallback(async () => {
        try {
          const value = await post('history/clear', {});
          if (!mounted.current) return;
          applyHistory(value);
          showToast('历史已清空');
        } catch (caught) {
          if (mounted.current) showToast(`清空失败：${String(caught?.message ?? caught)}`);
        }
      }, [applyHistory, showToast]);

      /* ---- 播放器：折叠状态 + seek ---- */

      const togglePlayer = useCallback(() => {
        setPlayerCollapsed((current) => {
          const next = !current;
          writePlayerCollapsed(next);
          return next;
        });
      }, []);

      /** 通过外壳 iframe 转发 seek：外壳再转给内层播放器（YouTube 走 Message API，B 站重建内层 src）。 */
      const postWrapperSeek = useCallback((seconds) => {
        const sec = Math.max(0, Math.floor(Number(seconds) || 0));
        const frame = frameRef.current;
        const win = frame && frame.contentWindow;
        if (!win || typeof win.postMessage !== 'function') { pendingSeek.current = sec; return; }
        try { win.postMessage({ type: 'dsh-video:seek', seconds: sec }, '*'); }
        catch { pendingSeek.current = sec; } // 跨域/未就绪：留给 load / wrapper ready 补发
      }, []);

      /** 时间戳点击：折叠时先展开并挂起 seek；外壳就绪后由 onLoad / wrapper 消息补发。 */
      const seekTo = useCallback((seconds) => {
        if (!docRef.current) return;
        const sec = Math.max(0, Math.floor(Number(seconds) || 0));
        if (playerCollapsed) {
          setPlayerCollapsed(false);
          writePlayerCollapsed(false);
          pendingSeek.current = sec;
          return;
        }
        postWrapperSeek(sec);
      }, [playerCollapsed, postWrapperSeek]);

      /** 外壳（外层 iframe）加载完成：外壳会先排队，等内层播放器就绪再执行。 */
      const handleFrameLoaded = useCallback(() => {
        const pending = pendingSeek.current;
        if (pending === null || pending === undefined) return;
        postWrapperSeek(pending);
      }, [postWrapperSeek]);

      /** 外壳内层播放器就绪（dsh-video:wrapper）：补发挂起的 seek 并清空。 */
      useEffect(() => {
        const onWrapperMessage = (event) => {
          const data = event && event.data;
          if (!data || typeof data !== 'object' || data.type !== 'dsh-video:wrapper') return;
          const pending = pendingSeek.current;
          if (pending === null || pending === undefined) return;
          pendingSeek.current = null;
          postWrapperSeek(pending);
        };
        try { window.addEventListener('message', onWrapperMessage); }
        catch { return undefined; }
        return () => { try { window.removeEventListener('message', onWrapperMessage); } catch { /* ignore */ } };
      }, [postWrapperSeek]);

      const abortActive = useCallback(() => {
        const current = active.current;
        active.current = null;
        if (current && current.controller) { try { current.controller.abort(); } catch { /* ignore */ } }
      }, []);

      /** 打断在途请求，并把界面上「进行中」的标记收干净（已生成内容保留）。 */
      const interruptActive = useCallback(() => {
        abortActive();
        setSummary((current) => (current.loading ? { ...current, loading: false, phase: '' } : current));
        setAskBusy(false);
        askBusyRef.current = false;
        setChat((current) => (current.some((message) => message.streaming)
          ? current.map((message) => (message.streaming ? { ...message, streaming: false, phase: '' } : message))
          : current));
        setTranscribe((current) => (current.loading ? { ...current, loading: false, phase: '', percent: null } : current));
      }, [abortActive]);

      const resetPanels = useCallback(() => {
        setSummary(EMPTY_SUMMARY);
        setChapters(EMPTY_CHAPTERS);
        setOpenChapter(-1);
        setSegQuery('');
        setSegAll(false);
        setChat([]);
        setAskInput('');
        setAskBusy(false);
        askBusyRef.current = false;
        setTranscribe(EMPTY_TRANSCRIBE);
      }, []);

      /** 把 host 返回的 doc.analysis 回填到面板状态（summary / chapters / mindmap / chat）。 */
      const applyAnalysisCache = useCallback((cache) => {
        if (!cache) return;
        const savedAt = cache.savedAt || '';
        if (cache.summary) {
          setSummary({
            ...EMPTY_SUMMARY,
            text: cache.summary.text,
            suggestions: Array.isArray(cache.summary.suggestions) ? cache.summary.suggestions : [],
            done: true,
            loading: false,
            cached: true,
            cachedAt: cache.summary.generatedAt || savedAt,
          });
        }
        if (cache.chapters) {
          setChapters({
            loading: false,
            error: '',
            note: '',
            items: cache.chapters.items,
            source: cache.chapters.source || 'cache',
            cachedAt: cache.chapters.generatedAt || savedAt,
          });
          setOpenChapter(-1);
        }
        if (cache.mindmap) {
          setMindmap({
            ...EMPTY_MINDMAP,
            data: cache.mindmap.data,
            source: 'llm',
            generatedAt: cache.mindmap.generatedAt || savedAt,
            cached: true,
          });
          setMmExpanded(defaultMindmapExpanded(cache.mindmap.data));
        }
        if (cache.chat && cache.chat.length) {
          setChat(cache.chat.map((message) => ({ ...message, streaming: false, phase: '' })));
        }
      }, []);

      /** 清空 host 上这个视频的分析缓存（总结 / 章节 / 导图 / 对话）。 */
      const clearAnalysisCache = useCallback(async (video) => {
        const target = video ?? docRef.current;
        if (!target || !target.docId) return;
        interruptActive();
        try {
          await post('analysis/clear', { docId: target.docId });
          if (!mounted.current) return;
          setSummary(EMPTY_SUMMARY);
          setChapters(EMPTY_CHAPTERS);
          setOpenChapter(-1);
          setMindmap(EMPTY_MINDMAP);
          setMmExpanded({});
          setChat([]);
          setAskInput('');
          setTab('summary');
          setDoc((current) => (current && current.docId === target.docId ? { ...current, analysis: null } : current));
          showToast('已清空本视频的分析缓存');
        } catch (caught) {
          if (mounted.current) showToast(`清空失败：${String((caught && caught.message) || caught)}`);
        }
      }, [interruptActive, showToast]);

      /** 只清空 host 上这个视频的追问对话记录。 */
      const clearChatCache = useCallback(async (video) => {
        const target = video ?? docRef.current;
        if (!target || !target.docId) return;
        interruptActive();
        try {
          await post('analysis/chat/clear', { docId: target.docId });
          if (!mounted.current) return;
          setChat([]);
          setAskInput('');
          setDoc((current) => (current && current.docId === target.docId && current.analysis
            ? { ...current, analysis: { ...current.analysis, chat: [] } }
            : current));
          showToast('已清空这个视频的对话记录');
        } catch (caught) {
          if (mounted.current) showToast(`清空对话失败：${String((caught && caught.message) || caught)}`);
        }
      }, [interruptActive, showToast]);

      /* ---- 总结：SSE 流式生成 ---- */

      const runSummary = useCallback(async (video) => {
        const target = video ?? docRef.current;
        if (!target || !mounted.current) return;
        interruptActive();
        const controller = new AbortController();
        active.current = { controller, kind: 'summary' };
        setSummary({ text: '', loading: true, phase: '正在读取字幕…', error: '', done: false, cached: false, cachedAt: '' });
        const live = () => active.current && active.current.controller === controller && mounted.current;
        let finished = false;
        try {
          await streamSSE('analyze', { docId: target.docId, url: target.url, mode: 'summary' }, {
            signal: controller.signal,
            onEvent: (event) => {
              if (!live()) return 'stop';
              const type = event && event.type;
              if (type === 'delta') {
                const extra = String(event.text ?? '');
                if (extra) setSummary((current) => ({ ...current, phase: '', text: current.text + extra }));
              } else if (type === 'phase') {
                setSummary((current) => ({ ...current, phase: String(event.text ?? '') }));
              } else if (type === 'done') {
                finished = true;
                setSummary((current) => ({
                  ...current, loading: false, done: true, phase: '',
                  text: event.text ? String(event.text) : current.text,
                  suggestions: Array.isArray(event.suggestions) ? event.suggestions : (current.suggestions ?? []),
                }));
                void refreshHistory(); // host 在总结成功时写入历史，这里重新拉取
                return 'stop';
              } else if (type === 'error') {
                finished = true;
                setSummary((current) => ({ ...current, loading: false, phase: '', error: `总结生成失败：${String(event.message ?? '未知错误')}` }));
                return 'stop';
              }
              return undefined;
            },
          });
          if (!finished && live()) setSummary((current) => (current.loading ? { ...current, loading: false, error: '连接中断了，没有拿到完整总结，请重试。' } : current));
        } catch (caught) {
          if (caught && caught.name === 'AbortError') return;
          if (live()) setSummary((current) => ({ ...current, loading: false, phase: '', error: friendlyStreamError(caught, '总结') }));
        } finally {
          if (active.current && active.current.controller === controller) active.current = null;
        }
      }, [interruptActive, refreshHistory]);

      const stopSummary = useCallback(() => {
        abortActive();
        setSummary((current) => ({ ...current, loading: false, phase: '' }));
      }, [abortActive]);

      /* ---- 章节：接口失败回落官方章节 / 分 P ---- */

      const loadChapters = useCallback(async (video) => {
        const target = video ?? docRef.current;
        if (!target) return;
        setChapters({ loading: true, error: '', note: '', items: null, source: '', cachedAt: '' });
        const fallback = (errorText, note) => {
          const official = Array.isArray(target.officialChapters) ? target.officialChapters.filter(Boolean) : [];
          if (official.length) {
            setChapters({
              loading: false, error: errorText, note: note || '接口没有给出章节，下面是 B 站官方章节', source: 'official',
              items: official.map((item) => ({ start: item.start ?? null, title: item.title || '(未命名章节)', gist: '' })),
            });
            return;
          }
          const pages = Array.isArray(target.pages) ? target.pages.filter(Boolean) : [];
          if (pages.length > 1) {
            setChapters({
              loading: false, error: errorText, note: note || '接口没有给出章节，先按分 P 展示', source: 'pages',
              items: pages.map((page) => ({
                start: null, pageIndex: page.index ?? 1, title: page.title || `P${page.index ?? 1}`,
                gist: `第 ${page.index ?? '?'} P${page.duration ? ` · ${fmtTime(page.duration)}` : ''}`,
              })),
            });
            return;
          }
          setChapters({ loading: false, error: errorText || '没有拿到章节：这个视频可能太短，或者字幕内容不足。', note: '', items: [], source: '' });
        };
        try {
          const value = await post('chapters', { docId: target.docId, url: target.url });
          if (!mounted.current || docRef.current !== target) return;
          const list = value && Array.isArray(value.chapters) ? value.chapters.filter((item) => item && typeof item === 'object') : [];
          if (!list.length) { fallback('', ''); return; }
          setChapters({
            loading: false, error: '', note: '', source: 'api',
            items: list.map((item) => ({ start: item.start ?? null, title: item.title || '(未命名章节)', gist: item.gist || '' })),
          });
        } catch (caught) {
          if (!mounted.current || docRef.current !== target) return;
          fallback(`章节生成失败：${String(caught?.message ?? caught)}`, '');
        }
      }, []);

      /* ---- 本地语音转写：/transcribe SSE（无字幕视频用） ---- */

      /**
       * 跑一次本地转写。成功后就地替换当前 doc 的 transcript（对应旧字幕的章节/总结清掉），
       * 并切到「原文」页。auto=true 表示由「无字幕自动转写」触发，失败/取消后不自动重试。
       */
      const runTranscribe = useCallback(async (video, options) => {
        const target = video ?? docRef.current;
        if (!target || !mounted.current) return;
        const auto = Boolean(options && options.auto);
        const docId = String(target.docId || '');
        const mark = (state) => { if (docId) autoAsrRef.current.set(docId, state); };
        mark('running');
        interruptActive();
        const controller = new AbortController();
        active.current = { controller, kind: 'transcribe' };
        setTranscribe({ loading: true, phase: '正在准备音频…', percent: null, error: '' });
        const live = () => active.current && active.current.controller === controller && mounted.current;
        let finished = false;
        try {
          await streamSSE('transcribe', { docId: target.docId, url: target.url }, {
            signal: controller.signal,
            onEvent: (event) => {
              if (!live()) return 'stop';
              const type = event && event.type;
              if (type === 'phase') {
                setTranscribe((current) => ({ ...current, phase: String(event.text ?? '') || current.phase }));
              } else if (type === 'progress') {
                const rawPercent = event.percent;
                const percent = rawPercent === null || rawPercent === undefined || rawPercent === '' ? NaN : Number(rawPercent);
                setTranscribe((current) => ({
                  ...current,
                  percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null,
                  phase: stageText(event.stage) || current.phase,
                }));
              } else if (type === 'done') {
                finished = true;
                const transcript = event.transcript;
                if (transcript && typeof transcript === 'object') {
                  const next = { ...target, transcript };
                  docRef.current = next;
                  setDoc((current) => (current && current.docId === target.docId ? { ...current, transcript } : current));
                }
                setChapters(EMPTY_CHAPTERS);
                setOpenChapter(-1);
                setTranscribe(EMPTY_TRANSCRIBE);
                setMindmap(EMPTY_MINDMAP); // 字幕变了，旧导图作废
                setMmExpanded({});
                setTab('transcript');
                mark('done');
                if (transcript) {
                  const engine = transcript.engineLabel || transcript.engine || '本地引擎';
                  const took = Number(transcript.tookMs);
                  const seconds = Number.isFinite(took) && took > 0 ? ` · 用时 ${(took / 1000).toFixed(1)}s` : '';
                  showToast(`已本地转写 · ${engine} · ${langLabel(transcript.lang)} · ${fmtCount(transcript.chars)} 字${seconds}`);
                }
                return 'stop';
              } else if (type === 'error') {
                finished = true;
                setTranscribe({ loading: false, phase: '', percent: null, error: friendlyAsrError({ code: event.code, message: event.message }) });
                mark(auto ? 'failed' : 'manual');
                return 'stop';
              }
              return undefined;
            },
          });
          if (!finished && live()) {
            setTranscribe((current) => (current.loading ? { ...current, loading: false, error: '连接中断了，没有拿到转写结果，请重试。' } : current));
            mark(auto ? 'failed' : 'manual');
          }
        } catch (caught) {
          if (caught && caught.name === 'AbortError') {
            mark('cancelled');
            if (live()) { setTranscribe(EMPTY_TRANSCRIBE); showToast('已取消本地转写'); }
            return;
          }
          if (live()) setTranscribe({ loading: false, phase: '', percent: null, error: friendlyAsrError(caught) });
          mark(auto ? 'failed' : 'manual');
        } finally {
          if (active.current && active.current.controller === controller) active.current = null;
        }
      }, [interruptActive, showToast]);

      /** 取消当前转写（自动或手动）。 */
      const cancelTranscribe = useCallback(() => {
        const video = docRef.current;
        if (video && video.docId) autoAsrRef.current.set(String(video.docId), 'cancelled');
        abortActive();
        setTranscribe(EMPTY_TRANSCRIBE);
        showToast('已取消本地转写');
      }, [abortActive, showToast]);

      /* ---- 思维导图：GET /mindmap，可强制重新生成 ---- */

      const loadMindmap = useCallback(async (video, force) => {
        const target = video ?? docRef.current;
        if (!target || !target.docId || !mounted.current) return;
        setMindmap((current) => ({ ...current, loading: true, error: '', code: '', cached: false, cachedAt: '' }));
        try {
          const value = await call('mindmap', force ? { docId: target.docId, force: 1 } : { docId: target.docId });
          if (!mounted.current) return;
          const data = value && value.mindmap && typeof value.mindmap === 'object' ? value.mindmap : null;
          setMindmap({
            data,
            loading: false,
            error: '',
            code: '',
            source: String(value?.source ?? ''),
            generatedAt: String(value?.generatedAt ?? ''),
            cached: false,
            cachedAt: '',
          });
          setMmExpanded(defaultMindmapExpanded(data));
        } catch (caught) {
          if (!mounted.current || (caught && caught.name === 'AbortError')) return;
          setMindmap({
            ...EMPTY_MINDMAP,
            error: friendlyMindmapError(caught),
            code: String((caught && caught.code) || ''),
          });
        }
      }, []);

      const toggleMindmapNode = useCallback((path) => {
        setMmExpanded((current) => ({ ...current, [path]: !current[path] }));
      }, []);

      const expandMindmapAll = useCallback(() => { setMmExpanded(allMindmapPaths(mindmap.data)); }, [mindmap.data]);
      const collapseMindmapAll = useCallback(() => { setMmExpanded({}); }, []);

      /* ---- 无字幕自动转写：asr 开启且 autoTranscribe 为真时自动跑一次（同一视频只触发一次） ---- */

      useEffect(() => {
        const video = doc;
        if (!video || hasTranscript(video) || !asr || asr.enabled === false || asr.ready === false) return;
        const config = asr.config || {};
        if (config.autoTranscribe === false) return;
        const docId = String(video.docId || '');
        if (!docId) return;
        if (autoAsrRef.current.has(docId)) return;
        autoAsrRef.current.set(docId, 'running');
        void runTranscribe(video, { auto: true });
      }, [doc, asr, runTranscribe]);

      /* ---- 思维导图懒加载：切到该页签且还没有数据/错误时才请求 ---- */

      useEffect(() => {
        if (tab !== 'mindmap' || !doc || mindmap.loading || mindmap.data || mindmap.error) return;
        void loadMindmap(doc, false);
      }, [tab, doc, mindmap.loading, mindmap.data, mindmap.error, loadMindmap]);

      /* ---- 解析：/resolve 可 aborts，切换视频时中断上一条 ---- */

      const resolve = useCallback(async (raw, options) => {
        const text = String(raw ?? url ?? '').trim();
        if (!text) {
          setError('先粘贴一个视频链接，例如 https://www.bilibili.com/video/BV...');
          return;
        }
        interruptActive();
        const controller = new AbortController();
        const ticket = resolveTicket.current + 1;
        resolveTicket.current = ticket;
        active.current = { controller, kind: 'resolve' };
        setResolveBusy(true);
        setError('');
        resetPanels();
        setDoc(null);
        docRef.current = null;
        setUrl(text);
        let followUp = null;
        let cachedSummary = false;
        try {
          const video = await call('resolve', { url: text, force: options && options.force ? 1 : undefined }, { signal: controller.signal });
          if (!mounted.current || (active.current && active.current.controller !== controller && active.current.kind === 'resolve')) return;
          if (!video || !video.docId) throw makeError('插件主机没有返回视频信息', 'internal');
          setDoc(video);
          docRef.current = video;
          setTab('summary');
          pendingSeek.current = null;
          setMindmap(EMPTY_MINDMAP);
          setMmExpanded({});
          // host 0.4.0：doc 可能带分析缓存（summary / chapters / mindmap / chat），有缓存就直接回填。
          const cache = readCachedAnalysis(video);
          if (cache) {
            applyAnalysisCache(cache);
            cachedSummary = Boolean(cache.summary);
          }
          void refreshHistory(); // host 在 /resolve 成功时已写入历史，客户端只重新拉取
          followUp = video;
        } catch (caught) {
          if (caught && caught.name === 'AbortError') return;
          if (mounted.current) setError(friendlyResolveError(caught, text));
        } finally {
          if (active.current && active.current.controller === controller) active.current = null;
          if (resolveTicket.current === ticket && mounted.current) setResolveBusy(false);
        }
        if (followUp && hasTranscript(followUp) && !cachedSummary) void runSummary(followUp);
      }, [url, interruptActive, resetPanels, refreshHistory, runSummary, applyAnalysisCache]);

      /* ---- 追问：带最近 6 条 history 流式回答 ---- */

      const sendAsk = useCallback(async (raw) => {
        const video = docRef.current;
        const question = String(raw ?? '').trim();
        if (!video || !question || askBusyRef.current || !mounted.current) return;
        const prior = chatRef.current
          .filter((message) => message && message.text && !message.streaming)
          .slice(-6)
          .map((message) => ({ role: message.role === 'user' ? 'user' : 'assistant', text: String(message.text) }));
        interruptActive();
        const controller = new AbortController();
        active.current = { controller, kind: 'ask' };
        askBusyRef.current = true;
        setAskBusy(true);
        setAskInput('');
        setChat((current) => [...current, { role: 'user', text: question }, { role: 'assistant', text: '', phase: '正在思考…', streaming: true }]);
        const live = () => active.current && active.current.controller === controller && mounted.current;
        const patchLast = (patch) => setChat((current) => {
          if (!current.length) return current;
          const next = current.slice();
          next[next.length - 1] = { ...next[next.length - 1], ...patch };
          return next;
        });
        let finished = false;
        try {
          await streamSSE('analyze', { docId: video.docId, url: video.url, mode: 'ask', question, history: prior }, {
            signal: controller.signal,
            onEvent: (event) => {
              if (!live()) return 'stop';
              const type = event && event.type;
              if (type === 'delta') {
                const extra = String(event.text ?? '');
                if (extra) setChat((current) => {
                  if (!current.length) return current;
                  const next = current.slice();
                  const last = next[next.length - 1];
                  next[next.length - 1] = { ...last, phase: '', text: String(last.text ?? '') + extra };
                  return next;
                });
              } else if (type === 'phase') {
                patchLast({ phase: String(event.text ?? '') });
              } else if (type === 'done') {
                finished = true;
                patchLast({
                  streaming: false,
                  phase: '',
                  text: event.text ? String(event.text) : undefined,
                  citations: sanitizeCitations(event.citations),
                });
                void refreshHistory(); // host 在追问成功时写入历史，这里重新拉取
                return 'stop';
              } else if (type === 'error') {
                finished = true;
                patchLast({ streaming: false, phase: '', error: `回答失败：${String(event.message ?? '未知错误')}` });
                return 'stop';
              }
              return undefined;
            },
          });
          if (!finished && live()) patchLast({ streaming: false, phase: '', error: '连接中断了，回答没有生成完，请重试。' });
        } catch (caught) {
          if (!(caught && caught.name === 'AbortError') && live()) patchLast({ streaming: false, phase: '', error: friendlyStreamError(caught, '追问') });
        } finally {
          if (active.current && active.current.controller === controller) active.current = null;
          askBusyRef.current = false;
          if (mounted.current) setAskBusy(false);
        }
      }, [interruptActive, refreshHistory]);

      /* ---- 设置：凭证 ---- */

      const submitCookie = useCallback(async (value, okMessage) => {
        setSavingCookie(true);
        setCookieNote('');
        try {
          await post('credentials', { bilibiliCookie: String(value ?? '').trim() });
          if (!mounted.current) return;
          setCookieNote(okMessage || '已保存，B 站字幕能力已刷新');
          setCookie('');
          await refreshStatus();
        } catch (caught) {
          if (mounted.current) setCookieNote(`保存失败：${String(caught?.message ?? caught)}`);
        } finally {
          if (mounted.current) setSavingCookie(false);
        }
      }, [refreshStatus]);

      /* --------------------------------------------------------------- 副作用 */

      useEffect(() => () => {
        mounted.current = false;
        try { if (active.current && active.current.controller) active.current.controller.abort(); } catch { /* ignore */ }
      }, []);

      useEffect(() => { void refreshStatus(); void refreshHistory(); void refreshAsr(); }, [refreshStatus, refreshHistory, refreshAsr]);

      useEffect(() => {
        if (tab !== 'chapters' || !doc || chapters.items !== null || chapters.loading) return;
        void loadChapters(doc);
      }, [tab, doc, chapters.items, chapters.loading, loadChapters]);

      useEffect(() => {
        if (!overlay) return undefined;
        const onKeyDown = (event) => { if (event && event.key === 'Escape') setOverlay(''); };
        try {
          if (typeof window.addEventListener === 'function') window.addEventListener('keydown', onKeyDown);
        } catch { return undefined; }
        return () => {
          try { if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeyDown); } catch { /* ignore */ }
        };
      }, [overlay]);

      /* ---------------------------------------------------------------- 渲染 */

      const openSettings = () => { setOverlay('settings'); setCookieNote(''); setAsrNote(''); void refreshAsr(); };

      /** 历史项点击：host 记录里 url 是原链接，优先用 url 重新解析。 */
      const openHistoryItem = (item) => {
        setOverlay('');
        const target = (item && (item.url || item.docId)) || '';
        if (!target) { setError('这条历史记录没有链接，无法重新解析。'); return; }
        void resolve(target, { force: true });
      };

      const copyAllSegments = (list) => {
        const items = list ?? [];
        if (!items.length) { showToast('没有可复制的字幕'); return; }
        void copy(items.map((segment) => `[${fmtTime(segment.start)}] ${segment.text}`).join('\n'), `已复制 ${items.length} 条字幕`);
      };

      let tabBody = null;
      if (doc) {
        if (tab === 'summary') {
          tabBody = h(SummaryTab, {
            doc, summary,
            onRun: () => { void runSummary(doc); },
            onStop: stopSummary,
            onCopy: () => { void copy(summary.text, '已复制总结'); },
            onGoSettings: openSettings,
            onSeek: seekTo,
          });
        } else if (tab === 'chapters') {
          tabBody = h(ChaptersTab, {
            chapters, openIndex: openChapter,
            onToggle: (index) => setOpenChapter(index),
            onSeek: seekTo,
            onRetry: () => { void loadChapters(doc); },
          });
        } else if (tab === 'transcript') {
          tabBody = h(TranscriptTab, {
            doc, query: segQuery, showAll: segAll,
            onQuery: (value) => setSegQuery(value),
            onShowAll: () => setSegAll(true),
            onCopySegment: (segment) => { void copy(`[${fmtTime(segment.start)}] ${segment.text}`, '已复制这条字幕'); },
            onCopyAll: copyAllSegments,
            onGoSettings: openSettings,
            onSeek: seekTo,
          });
        } else if (tab === 'mindmap') {
          tabBody = h(MindmapTab, {
            doc, mindmap, expanded: mmExpanded,
            onRetry: () => { void loadMindmap(doc, true); },
            onExpandAll: expandMindmapAll,
            onCollapseAll: collapseMindmapAll,
            onToggle: toggleMindmapNode,
            onGoTranscript: () => { void runTranscribe(doc); },
          });
        }
      }

      /** 返回会话列表：layout 服务把当前 main 面板切回 null。 */
      const layoutService = getLayoutService();
      const canGoBack = Boolean(layoutService);
      /** 清空当前视频状态，回到插件首页（大输入框 + 最近分析）。 */
      const resetToHome = useCallback(() => {
        abortActive();
        docRef.current = null;
        setDoc(null);
        setUrl('');
        setError('');
        setSummary(EMPTY_SUMMARY);
        setChapters(EMPTY_CHAPTERS);
        setTranscribe(EMPTY_TRANSCRIBE);
        setMindmap(EMPTY_MINDMAP);
        setMmExpanded({});
        setChat([]);
        chatRef.current = [];
        setAskInput('');
        setAskBusy(false);
        askBusyRef.current = false;
        setTab('summary');
        setOpenChapter(-1);
        setSegQuery('');
        setSegAll(false);
        setOverlay('');
        pendingSeek.current = null;
        void refreshHistory();
      }, [abortActive, refreshHistory]);

      /** 「← 返回」：正在看视频 → 回插件首页；已经在首页 → 回上层对话界面。 */
      const goBack = () => {
        if (docRef.current) { resetToHome(); return; }
        try { getLayoutService()?.selectPanel(null); } catch { /* 服务不可用：按钮已隐藏 */ }
      };

      const banners = [];
      if (error) banners.push(h('div', { key: 'error', className: 'dvv-error' }, error));
      if (resolveBusy) {
        banners.push(h('div', { key: 'resolving', className: 'dvv-loading-block' }, [h('span', { key: 's', className: 'dvv-spinner' }), '正在解析视频信息…']));
      }

      // 首页：居中的解析框 + 下面列历史记录
      let body;
      if (!doc) {
        body = h('div', { key: 'body', className: 'dvv-body dvv-body-home' }, [
          h(HomeHero, {
            key: 'hero', url, busy: resolveBusy, statusError,
            biliReady: Boolean(status && status.bilibili && status.bilibili.cookie),
            onUrl: setUrl,
            onSubmit: () => { void resolve(url); },
            onGoSettings: openSettings,
          }),
          historyItems.length
            ? h('div', { key: 'recent', className: 'dvv-home-recent' }, h(HistoryList, {
                items: historyItems, onOpen: openHistoryItem, onRemove: (item) => { void removeHistory(item); },
              }))
            : h('div', { key: 'none', className: 'dvv-home-none' }, '还没有分析记录，粘贴一个链接开始吧。'),
        ].filter(Boolean));
      } else {
        // 已解析：左栏播放器 + 追问，右栏字幕提示 + 页签（各自滚动）
        body = h('div', { key: 'body', className: 'dvv-body' }, [
          h('div', { key: 'left', className: 'dvv-col-left' }, [
            h(PlayerArea, {
              key: 'player', doc, collapsed: playerCollapsed,
              frameRef, onToggle: togglePlayer, onLoaded: handleFrameLoaded,
            }),
            h(AskPanel, {
              key: 'ask', chat, input: askInput, busy: askBusy, suggestions: summary.suggestions,
              onInput: (value) => setAskInput(value),
              onSend: (value) => { void sendAsk(value); },
              onSeek: seekTo,
            }),
          ].filter(Boolean)),
          h('div', { key: 'right', className: 'dvv-col-right' }, [
            h(TranscriptNote, {
              key: 'note', doc, asr, transcribe,
              onTranscribe: () => { void runTranscribe(doc); },
              onCancel: cancelTranscribe,
              onGoSettings: openSettings,
            }),
            h('div', { key: 'tabs', className: 'dvv-tabbar' }, TABS.map(([id, label]) => h('button', {
              key: id, type: 'button', className: 'dvv-tab', 'data-active': tab === id ? 'true' : undefined, onClick: () => setTab(id),
            }, label))),
            h('div', { key: 'pane', className: 'dvv-pane' }, tabBody),
          ]),
        ]);
      }

      return h('div', { className: 'dvv-root' }, [
        h(VideoToolbar, {
          key: 'toolbar', doc, historyCount: historyItems.length, canGoBack, onBack: goBack,
          onHistory: () => setOverlay(overlay === 'history' ? '' : 'history'),
          onSettings: () => {
            if (overlay === 'settings') { setOverlay(''); return; }
            openSettings();
          },
        }),
        doc ? h('div', { key: 'inputrow', className: 'dvv-inputrow' }, [
          h('input', {
            key: 'input', className: 'dvv-input', value: url,
            placeholder: '粘贴视频链接，例如 https://www.youtube.com/watch?v=... 或 https://www.bilibili.com/video/BV...',
            'aria-label': '视频链接',
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void resolve(url); } },
          }),
          h('button', { key: 'go', type: 'button', className: 'dvv-btn', 'data-primary': 'true', disabled: resolveBusy, onClick: () => { void resolve(url); } }, resolveBusy ? '解析中…' : '解析'),
        ]) : null,
        banners.length ? h('div', { key: 'banners', className: 'dvv-banners' }, banners) : null,
        body,
        overlay === 'history' ? h(HistoryDrawer, {
          key: 'drawer', items: historyItems, error: historyError,
          onOpen: openHistoryItem,
          onRemove: (item) => { void removeHistory(item); },
          onClear: () => { void clearHistory(); },
          onClose: () => setOverlay(''),
        }) : null,
        overlay === 'settings' ? h(SettingsModal, {
          key: 'modal', status, cookie, saving: savingCookie, note: cookieNote,
          onCookie: (value) => setCookie(value),
          onSave: (value) => { void submitCookie(value, '已保存，B 站字幕能力已刷新'); },
          onClear: () => { void submitCookie('', '已清除 B 站 Cookie'); },
          onClose: () => setOverlay(''),
          onRefresh: () => { void refreshStatus(); void refreshAsr(); },
          asr, asrSaving, asrNote, asrError,
          onAsrConfig: (patch) => { void submitAsrConfig(patch); },
          doc,
          onClearAnalysis: (video) => { void clearAnalysisCache(video); },
          onClearChat: (video) => { void clearChatCache(video); },
        }) : null,
        toast ? h('div', { key: 'toast', className: 'dvv-toast', role: 'status' }, toast) : null,
      ].filter(Boolean));
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.dvv-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
/* 顶部紧凑工具栏 */
.dvv-toolbar{flex:none;display:flex;align-items:center;gap:10px;padding:10px 18px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dvv-back{flex:none}
.dvv-toolbar-cover{flex:none;width:72px}
.dvv-toolbar-cover .dvv-cover{width:72px;border-radius:8px}
.dvv-toolbar-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dvv-toolbar-title{font-size:14px;line-height:20px;font-weight:650;color:var(--dsw-alias-label-primary,inherit);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a.dvv-toolbar-title:hover{color:var(--dsw-alias-brand-primary)}
.dvv-toolbar-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,CanvasText)}
.dvv-toolbar-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,CanvasText)}
.dvv-toolbar-stats{font-variant-numeric:tabular-nums}
.dvv-toolbar-actions{flex:none;display:flex;gap:8px}
.dvv-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:22px;padding:2px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.dvv-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.dvv-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base,Canvas);font-weight:600}
.dvv-btn[data-primary="true"]:hover{opacity:.9}
.dvv-btn:disabled{opacity:.5;cursor:not-allowed}
.dvv-inputrow{flex:none;display:flex;gap:8px;padding:0 18px 12px}
.dvv-input{flex:1;min-width:0;font:inherit;font-size:13px;line-height:24px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;outline:none}
.dvv-input:focus{border-color:var(--dsw-alias-brand-primary)}
/* 主体：左栏（播放器 + 追问）/ 右栏（字幕提示 + 页签），各自独立滚动 */
.dvv-banners{flex:none;display:flex;flex-direction:column;padding:0 18px}
.dvv-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,38%) minmax(0,1fr);gap:14px;padding:6px 18px 16px}
.dvv-body-home{display:flex;flex-direction:column;overflow:hidden}
.dvv-col-left,.dvv-col-right{min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px}
.dvv-col-right{overflow:hidden}
.dvv-col-left>.dvv-player{padding:0}
.dvv-col-left>.dvv-player .dvv-frame-wrap{max-height:30vh}
.dvv-chat-panel{flex:1;min-height:240px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}
.dvv-chat-head{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dvv-chat-head-title{font-size:12px;line-height:18px;font-weight:650}
.dvv-chat-scroll{flex:1;min-height:0;overflow:auto;padding:8px 12px}
.dvv-chat-panel .dvv-chat,.dvv-chat-panel .dvv-examples{max-width:none;padding:0}
.dvv-chat-panel .dvv-composer{position:static;max-width:none;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:transparent}
.dvv-error{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:19px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;margin:8px 0}
.dvv-warn{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:19px;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 12px;margin:8px 0}
.dvv-spacer{flex:1}
.dvv-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dvv-home{flex:none;display:flex;flex-direction:column;gap:16px;width:100%;max-width:760px;margin:0 auto;padding:5vh 18px 10px}
.dvv-home-hero{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}
.dvv-home-title{margin:0;font-size:26px;line-height:34px;font-weight:700;letter-spacing:-.4px;color:var(--dsw-alias-label-primary,inherit)}
.dvv-home-sub{margin:0;max-width:560px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.dvv-home-form{display:flex;gap:10px;width:100%;max-width:640px;margin-top:6px}
.dvv-home-input{flex:1;min-width:0;font:inherit;font-size:14px;line-height:26px;padding:9px 18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dvv-home-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dvv-home-btn{flex:none;padding:0 22px;border-radius:999px;font-size:13px}
.dvv-home-hint{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dvv-btn-mini{padding:0 10px;line-height:22px;font-size:12px;border-radius:999px}
.dvv-home-recent{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;width:100%;max-width:640px;margin:10px auto 0;padding:0 2px 18px}
.dvv-home-none{flex:none;width:100%;max-width:640px;margin:14px auto 0;padding:18px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dvv-cover{flex:none;width:212px;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.dvv-cover img{display:block;width:100%;height:100%;object-fit:cover}
.dvv-cover-ph{display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dsw-alias-label-secondary,CanvasText)}
/* 平台小徽标：底色是硬编码平台色（两套主题下都成立），白字是有意为之，不属于主题兜底 */
.dvv-plat{display:inline-block;font-size:11px;line-height:16px;font-weight:600;color:#fff;padding:0 7px;border-radius:999px}
.dvv-plat-compact{font-size:10px;line-height:15px;padding:0 6px}
.dvv-dur{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dvv-meta-line{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);padding:2px 0 8px}
.dvv-tabbar{flex:none;display:flex;gap:2px;padding:2px 0 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dvv-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:24px;padding:3px 14px;border-radius:999px;cursor:pointer}
.dvv-tab:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dvv-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);font-weight:600}
.dvv-tabpane{padding-top:8px}
.dvv-pane{flex:1;min-height:0;overflow:auto;padding:4px 0 8px}
.dvv-md{font-size:13.5px;line-height:24px;color:var(--dsw-alias-label-primary,inherit)}
.dvv-md-h{margin:14px 0 6px;font-weight:650;color:var(--dsw-alias-label-primary,inherit)}
.dvv-md-h2{font-size:15px;line-height:23px}
.dvv-md-h3{font-size:13.5px;line-height:21px}
.dvv-md-p{margin:6px 0;white-space:pre-wrap;word-break:break-word}
.dvv-md-list{margin:6px 0;padding-left:20px}
.dvv-md-list li{margin:3px 0}
.dvv-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.dvv-ts{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;margin:0 1px;white-space:nowrap}
.dvv-ts-btn{cursor:pointer;border:0;font:inherit;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-brand-primary);transition:background .15s ease,color .15s ease}
.dvv-ts-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));text-decoration:underline}
.dvv-ts-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dvv-caret{display:inline-block;width:7px;height:14px;vertical-align:-2px;margin-left:2px;background:var(--dsw-alias-brand-primary);animation:dvv-blink 1s steps(2,start) infinite}
@keyframes dvv-blink{50%{opacity:0}}
.dvv-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0 2px}
.dvv-loading-block{display:flex;align-items:center;gap:8px;padding:14px 0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dvv-spinner{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-top-color:var(--dsw-alias-brand-primary);animation:dvv-spin .8s linear infinite}
@keyframes dvv-spin{to{transform:rotate(360deg)}}
.dvv-notice{border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:10px;padding:12px 14px;margin:8px 0}
.dvv-notice-title{font-size:13px;line-height:20px;font-weight:600;margin-bottom:4px}
.dvv-official{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;padding:10px 12px;margin:10px 0;background:var(--dsw-alias-bg-layer-1,transparent)}
.dvv-skel{height:44px;border-radius:10px;margin-bottom:8px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08)) 25%,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18)) 37%,var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08)) 63%);background-size:400% 100%;animation:dvv-shimmer 1.3s ease infinite}
@keyframes dvv-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
.dvv-chlist{display:flex;flex-direction:column;gap:6px;padding-top:2px}
.dvv-ch{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}
.dvv-ch-head{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
.dvv-ch-head:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.dvv-ch-title{flex:1;min-width:0;font-size:13px;line-height:20px;font-weight:550}
.dvv-ch-chev{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dvv-ch-body{border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.1));padding:8px 12px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dvv-segbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 0 8px}
.dvv-search{flex:1;min-width:150px;font:inherit;font-size:12px;line-height:22px;padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;outline:none}
.dvv-search:focus{border-color:var(--dsw-alias-brand-primary)}
.dvv-segs{display:flex;flex-direction:column}
.dvv-seg{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:6px 8px;border-radius:8px;cursor:pointer}
.dvv-seg:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.dvv-seg-time{flex:none;min-width:46px;font-size:12px;line-height:20px;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.dvv-seg-text{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dvv-seg:hover .dvv-seg-text{color:var(--dsw-alias-label-primary,inherit)}
.dvv-chat{display:flex;flex-direction:column;gap:10px;padding:4px 0 8px}
.dvv-bubble{max-width:86%;border-radius:12px;padding:8px 12px;font-size:13px;line-height:22px;white-space:pre-wrap;word-break:break-word}
.dvv-bubble[data-role="user"]{align-self:flex-end;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base,Canvas);border-bottom-right-radius:4px}
.dvv-bubble[data-role="assistant"]{align-self:flex-start;max-width:92%;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-bottom-left-radius:4px}
.dvv-bubble[data-error="true"]{border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dvv-bubble .dvv-md{font-size:13px;line-height:22px;max-width:none}
.dvv-examples{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:8px 0 4px}
.dvv-example{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:4px 12px;border-radius:999px;cursor:pointer}
.dvv-example:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dvv-note-ai{margin-top:6px;color:var(--dsw-alias-brand-primary,#1f6feb)}
.dvv-example[data-ai="true"]{border-style:dashed;color:var(--dsw-alias-label-primary)}
.dvv-composer{display:flex;align-items:flex-end;gap:8px;padding:8px 0 2px}
.dvv-textarea{flex:1;min-width:0;font:inherit;font-size:13px;line-height:21px;min-height:42px;max-height:140px;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;outline:none;resize:vertical}
.dvv-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dvv-overlay{position:absolute;inset:0;z-index:20;display:flex;justify-content:flex-end;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.32))}
.dvv-drawer{display:flex;flex-direction:column;width:min(420px,92%);height:100%;background:var(--dsw-alias-bg-layer-1,Canvas);border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}
.dvv-modal{display:flex;flex-direction:column;width:min(600px,94%);max-height:88%;margin:auto;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.24);overflow:hidden}
.dvv-drawer-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-specific-sidebar-fill,transparent)}
.dvv-drawer-title{flex:1;min-width:0;font-size:14px;line-height:21px;font-weight:600}
.dvv-drawer-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px}
.dvv-hist{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:10px;cursor:pointer}
.dvv-hist:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.dvv-hist-cover{flex:none;width:76px;aspect-ratio:16/9;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.dvv-hist-main{flex:1;min-width:0}
.dvv-hist-title{font-size:13px;line-height:19px;font-weight:550;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dvv-hist-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dvv-status-box{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:10px;padding:10px 12px;margin-bottom:14px}
.dvv-kv{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12px;line-height:19px}
.dvv-label{font-size:12px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dvv-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.dvv-caps{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-top:12px}
.dvv-cap{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dvv-cap-dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-success-primary)}
.dvv-cap-dot[data-ok="false"]{background:var(--dsw-alias-state-warn-primary)}
.dvv-cap-text{flex:1;min-width:0}
.dvv-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:30;pointer-events:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit);border-radius:999px;padding:5px 14px;font-size:12px;line-height:18px;max-width:80%;text-align:center}
.dvv-player{flex:none}
.dvv-player-bar{display:flex;align-items:center;gap:8px;padding:0 0 6px}
.dvv-player-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dvv-link-btn{display:inline-flex;align-items:center;text-decoration:none}
.dvv-player-body{display:flex;justify-content:center}
/* 播放器 letterbox：黑底是视频容器需求 */
.dvv-frame-wrap{position:relative;width:100%;max-width:calc(42vh * 16 / 9);aspect-ratio:16 / 9;max-height:42vh;border-radius:10px;overflow:hidden;background:#000;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}
.dvv-frame{display:block;width:100%;height:100%;border:0}
.dvv-player-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:100%;max-width:calc(42vh * 16 / 9);aspect-ratio:16 / 9;max-height:42vh;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,rgba(0,0,0,.6));text-align:center;padding:12px;box-sizing:border-box}
.dvv-player-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,rgba(0,0,0,.85))}
.dvv-player-empty-note{font-size:12px;line-height:1.5}
.dvv-recent{margin-top:6px}
.dvv-home-recent .dvv-recent-head{justify-content:center;padding:2px 0 10px}
.dvv-recent-head{display:flex;align-items:baseline;gap:8px;padding:2px 0 8px}
.dvv-hist-list{display:flex;flex-direction:column;gap:2px}
.dvv-hist-sub{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dvv-hist-author{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvv-hist-cover-ph{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.dvv-mini{font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary)}
.dvv-mini[data-ok="false"]{color:var(--dsw-alias-state-warn-primary)}
/* RAG 依据 chip 与「本视频分析缓存」区块 */
.dvv-cites{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.12))}
.dvv-cites-label{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dvv-cite{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-brand-primary);font:inherit;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;cursor:pointer;font-variant-numeric:tabular-nums}
.dvv-cite:hover{border-color:var(--dsw-alias-brand-primary)}
.dvv-cache-note{margin:2px 0 6px}
.dvv-cache-box{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-top:12px;margin-top:12px}
.dvv-cache-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.dvv-del{flex:none;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:24px;width:24px;height:24px;padding:0;border-radius:50%;cursor:pointer}
.dvv-del:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-state-error-primary)}
.dvv-drawer-foot{display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.dvv-btn[data-danger="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dvv-empty-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:10px;padding:12px 14px;margin:8px 0}
.dvv-asr-note{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:6px}
.dvv-asr-note-title{font-size:13px;line-height:20px;font-weight:600}
.dvv-asr-phase{display:flex;align-items:center;gap:8px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.dvv-progress{position:relative;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));margin:2px 0}
.dvv-progress-fill{height:100%;width:0;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.dvv-progress[data-indeterminate="true"] .dvv-progress-fill{width:35%;animation:dvv-indeterminate 1.1s ease-in-out infinite}
@keyframes dvv-indeterminate{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
.dvv-local-badge{display:inline-block;font-size:11px;line-height:16px;font-weight:600;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-brand-primary)}
.dvv-meta-sep{opacity:.55}
.dvv-asr-box{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-top:12px;margin-top:12px}
.dvv-asr-head{display:flex;align-items:center;gap:8px}
.dvv-asr-privacy{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:8px;padding:8px 10px}
.dvv-asr-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dvv-asr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.dvv-asr-field{display:flex;flex-direction:column;gap:4px}
.dvv-vseg{display:flex;flex-wrap:wrap;gap:6px}
.dvv-vseg-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:5px 10px;border-radius:999px;cursor:pointer}
.dvv-vseg-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary,inherit)}
.dvv-vseg-btn[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.dvv-asr-models{display:flex;flex-direction:column;gap:4px}
.dvv-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dvv-check input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary)}
.dvv-select{font:inherit;font-size:12px;line-height:22px;padding:2px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,inherit)}
.dvv-input-sm{flex:none;width:120px;font-size:12px;line-height:22px;padding:3px 10px;border-radius:8px}
.dvv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
/* 思维导图 */
.dvv-mm{display:flex;flex-direction:column;gap:4px;min-height:0}
.dvv-mm-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 0 4px}
.dvv-mm-bar-title{font-size:13px;line-height:20px;font-weight:650}
.dvv-mm-meta{padding:0 0 6px}
.dvv-mm-zoom{font-size:12px;line-height:20px;min-width:40px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dvv-mm2-scroll{flex:1;min-height:260px;max-height:min(64vh,720px);overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dvv-mm2-box{position:relative;flex:none}
.dvv-mm2-inner{position:absolute;left:0;top:0}
.dvv-mm2-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.dvv-mm2-link{fill:none;stroke-width:1.6;stroke-linecap:round;stroke:var(--dvv-mm-accent,var(--dsw-alias-border-l2))}
.dvv-mm2-node{position:absolute;display:flex;align-items:center;gap:6px;padding:0 10px 0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dvv-mm-accent,var(--dsw-alias-brand-primary));background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(15,23,42,.08);overflow:hidden;cursor:pointer;transition:box-shadow .15s ease}
.dvv-mm2-node:hover{box-shadow:0 3px 10px rgba(15,23,42,.16)}
.dvv-mm2-node[data-depth="0"]{background:var(--dsw-alias-bg-overlay);border-color:var(--dvv-mm-accent,var(--dsw-alias-brand-primary))}
.dvv-mm2-title{flex:1;min-width:0;font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dvv-mm2-node[data-depth="0"] .dvv-mm2-title{font-size:13.5px;font-weight:650}
.dvv-mm2-node[data-depth="1"] .dvv-mm2-title{font-weight:600}
.dvv-mm2-count{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
/* 按一级分支分配强调色：全部从 --dsw-alias-* 派生，暗色主题自动跟随 */
.dvv-mm-branch-0{--dvv-mm-accent:var(--dsw-alias-brand-primary)}
.dvv-mm-branch-1{--dvv-mm-accent:color-mix(in srgb, var(--dsw-alias-brand-primary) 62%, var(--dsw-alias-state-success-primary))}
.dvv-mm-branch-2{--dvv-mm-accent:var(--dsw-alias-state-success-primary)}
.dvv-mm-branch-3{--dvv-mm-accent:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-state-warn-primary))}
.dvv-mm-branch-4{--dvv-mm-accent:var(--dsw-alias-state-warn-primary)}
.dvv-mm-branch-5{--dvv-mm-accent:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary))}
.dvv-mm-branch-6{--dvv-mm-accent:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-state-error-primary))}
.dvv-mm-branch-7{--dvv-mm-accent:var(--dsw-alias-state-error-primary)}
.dvv-mm-error{flex-direction:column;align-items:flex-start;gap:8px}

@media (max-width:979px){
  /* 单列：播放器 → 页签（含字幕提示条） → 追问对话框，整页滚动。
     两栏用 display:contents 摊平，再靠 order 重排。 */
  .dvv-body{display:flex;flex-direction:column;overflow:auto;gap:10px}
  .dvv-col-left,.dvv-col-right{display:contents}
  .dvv-col-left>.dvv-player{order:1}
  .dvv-col-right>.dvv-tabbar{order:2}
  .dvv-col-right>.dvv-meta-line,.dvv-col-right>.dvv-asr-note{order:3}
  .dvv-col-right>.dvv-pane{order:4;flex:none;overflow:visible}
  .dvv-chat-panel{order:5;flex:none;min-height:320px;max-height:60vh}
  .dvv-col-left>.dvv-player .dvv-frame-wrap{max-height:42vh}
}
@media (max-width:640px){
  .dvv-toolbar{padding:8px 12px 6px}
  .dvv-toolbar-cover{display:none}
  .dvv-banners{padding:0 12px}
  .dvv-body{padding:6px 12px 12px}
  .dvv-inputrow{padding:0 12px 8px}
}
`;

    /* ------------------------------------------------------------------ 注册 */

    let inserted = false;

    /** 样式自注入：浏览器半没有样式通道，只能自己挂 <style>。 */
    function insertStyles() {
      if (inserted) return;
      inserted = true;
      try {
        const tag = document.createElement('style');
        tag.dataset.dshVideo = 'panel';
        tag.textContent = CSS;
        document.head.append(tag);
      } catch { /* 非浏览器环境：静默跳过 */ }
    }

    let pluginCtx = null;

    /**
     * 取布局服务：服务可能晚于 apply 就绪，所以每次渲染/点击时再取一次。
     * 拿不到时返回 null，返回按钮会隐藏（用户仍可从侧边栏切回会话）。
     */
    function getLayoutService() {
      try {
        const layout = pluginCtx?.get?.('layout') ?? pluginCtx?.layout ?? null;
        return layout && typeof layout.selectPanel === 'function' ? layout : null;
      } catch {
        return null;
      }
    }

    const inject = ['slots', 'layout'];

    function apply(ctx) {
      pluginCtx = ctx;
      insertStyles();
      ctx.effect(() => {
        const disposers = [];
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => '视频解析',
        }, VideoIcon)));
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, VideoPanel)));
        return () => {
          for (const dispose of disposers) dispose?.();
        };
      }, 'dsh-video: panel');
    }

    const exports_ = {
      apply,
      inject,
      // 布局是纯函数，暴露给测试直接断言坐标/连线（Host 会忽略额外字段）。
      __test: { buildMindmapLayout, mindmapTextLines, defaultMindmapExpanded, allMindmapPaths, renderMarkdown, clockToSeconds },
    };
    return exports_;
  },
});
