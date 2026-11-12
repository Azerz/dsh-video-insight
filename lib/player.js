/**
 * 播放器外壳页：由 Host 以 http(s) 起源提供。
 *
 * 为什么需要它：桌面客户端的主界面跑在自定义协议 `dsh-app://app` 下，
 * 页面里直接嵌 YouTube iframe 时，父页面既不是 http(s) 起源、也不会发送
 * http Referer，YouTube 内嵌播放器会拒绝播放（整块空白）。
 * 这里让 Host 返回一个极简 HTML 外壳（http://127.0.0.1:<port>/dsh-video/api/player），
 * 外壳内再去嵌真正的播放器 iframe —— 此时 YouTube 看到的父页面是正常的 http 起源，
 * Referer / origin 都合法。
 *
 * YouTube 使用官方 IFrame Player API（不是裸 postMessage）：seekTo 后立刻 playVideo，
 * 点击面板里的时间戳就能「跳到对应位置并继续播放」。B 站外壳重建内层 iframe 的
 * src 并带上 `&t=<秒>&autoplay=1`（只重载内层）。
 *
 * 注意：初始定位只用 URL 的 `start` 参数，页面加载时不要主动 seek/play
 * （播放器未就绪时操作会黑屏）。
 */

export const PLAYER_PATH = '/player';

const PLATFORMS = new Set(['youtube', 'bilibili']);

function toInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** 把查询参数收敛成安全配置；非法 id 直接返回 null（路由层回 400）。 */
export function parsePlayerQuery(searchParams) {
  const platform = String(searchParams?.get('platform') ?? '').toLowerCase();
  const id = String(searchParams?.get('id') ?? '').trim();
  if (!PLATFORMS.has(platform)) return null;
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) return null;
  return {
    platform,
    id,
    page: toInt(searchParams?.get('page'), 1, 1, 500),
    start: toInt(searchParams?.get('start'), 0, 0, 24 * 3600),
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 生成外壳页 HTML。
 * YouTube 部分走 https://www.youtube.com/iframe_api，页面里用 YT.Player 建播放器；
 * B 站部分是一个普通 iframe，seek 时换 src。
 */
export function buildPlayerDocument(options = {}) {
  const platform = options.platform === 'bilibili' ? 'bilibili' : 'youtube';
  const id = String(options.id ?? '');
  const page = toInt(options.page, 1, 1, 500);
  const start = toInt(options.start, 0, 0, 24 * 3600);
  const config = JSON.stringify({ platform, id, page, start }).replace(/</g, '\\u003c');
  const title = escapeHtml(platform === 'youtube' ? 'YouTube' : '哔哩哔哩');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
  #player, #frame { display: block; width: 100%; height: 100%; border: 0; background: #000; }
</style>
</head>
<body>
<div id="player"></div>
<iframe id="frame" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerpolicy="strict-origin-when-cross-origin" style="display:none"></iframe>
<script>
(function () {
  var CFG = ${config};
  var isYoutube = CFG.platform === 'youtube';
  var player = null;
  var ready = false;
  var queued = [];

  if (!isYoutube) {
    var frame = document.getElementById('frame');
    frame.style.display = 'block';
    document.getElementById('player').style.display = 'none';
  }

  // 注意：autoplay 只能出现一次。浏览器里重复的 query 参数会取第一个，
  // 早先「先写 autoplay=0 再追加 autoplay=1」会被播放器当成 0，表现为「跳了位置但不自动播放」。
  function bilibiliSrc(start, autoplay) {
    var src = 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(CFG.id) +
      '&page=' + String(CFG.page) +
      '&danmaku=0&as_wide=1&high_quality=1&poster=1' +
      '&autoplay=' + (autoplay ? '1' : '0');
    if (start > 0) src += '&t=' + String(Math.floor(start));
    return src;
  }

  function bilibiliSeek(seconds) {
    var next = document.getElementById('frame');
    next.src = bilibiliSrc(seconds, true);
  }

  function flushQueue() {
    ready = true;
    while (queued.length) {
      var seconds = queued.shift();
      seekAndPlay(seconds);
    }
  }

  function seekAndPlay(seconds) {
    var value = Math.max(0, Math.floor(Number(seconds) || 0));
    if (isYoutube) {
      if (!ready || !player) { queued.push(value); return; }
      try {
        player.seekTo(value, true);
        player.playVideo();
      } catch (error) {}
      return;
    }
    bilibiliSeek(value);
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (error) { return; }
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'dsh-video:seek') seekAndPlay(data.seconds);
  });

  function notifyParent() {
    try { parent.postMessage({ type: 'dsh-video:wrapper' }, '*'); } catch (error) {}
  }

  if (isYoutube) {
    // 官方 IFrame Player API：自动带上正确的 origin，且 seekTo/playVideo 有回调保证。
    var apiScript = document.createElement('script');
    apiScript.src = 'https://www.youtube.com/iframe_api';
    apiScript.onload = function () {
      if (window.YT && window.YT.Player) initPlayer();
    };
    apiScript.onerror = function () { notifyParent(); };
    document.head.appendChild(apiScript);
    window.onYouTubeIframeAPIReady = function () { initPlayer(); };
    function initPlayer() {
      if (player || !window.YT || !window.YT.Player) return;
      window.__dshPlayer = null;
      player = new window.YT.Player('player', {
        videoId: CFG.id,
        playerVars: {
          start: CFG.start,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: function () { window.__dshPlayer = player; flushQueue(); notifyParent(); },
          onError: function () { notifyParent(); },
        },
      });
    }
  } else {
    document.getElementById('frame').addEventListener('load', notifyParent);
    document.getElementById('frame').src = bilibiliSrc(CFG.start, false);
  }
})();
</script>
</body>
</html>`;
}
