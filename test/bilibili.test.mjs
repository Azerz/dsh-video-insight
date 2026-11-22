// B 站字幕接口回退的单测：不发真实网络请求，用 mock fetch 造「wbi 接口异常/空列表」的场景。
import assert from 'node:assert/strict';

const SUBTITLE_URL = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/demo';
const VIEW = {
  code: 0,
  data: {
    bvid: 'BV11vsD6mE7X',
    aid: 113373010203801264,
    title: '测试视频',
    duration: 235,
    pic: 'https://i0.hdslb.com/demo.jpg',
    pubdate: 1763000000,
    desc: 'demo',
    owner: { mid: 1, name: 'UP' },
    stat: { view: 1, like: 1, reply: 0, favorite: 0, danmaku: 0 },
    pages: [{ cid: 43721034124, page: 1, part: 'P1', duration: 235 }],
    cid: 43721034124,
  },
};
const NAV = {
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};
const SUBTITLE_JSON = {
  body: [
    { from: 0.32, to: 1.8, content: '同学们好' },
    { from: 1.8, to: 3.1, content: '今天聊聊沃尔玛甜点' },
  ],
};

const player = (subtitles) => ({
  code: 0,
  data: {
    subtitle: {
      subtitles: subtitles.map((item) => ({
        lan: 'ai-zh',
        lan_doc: '中文',
        type: 1,
        subtitle_url: item.url,
      })),
    },
    view_points: [],
  },
});

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    for (const [pattern, handler] of routes) {
      if (target.includes(pattern)) {
        const body = typeof handler === 'function' ? handler(target) : handler;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

const settings = { cookie: 'SESSDATA=demo; bili_jct=demo; buvid3=demo', timeoutMs: 5000 };
const { resolveBilibili } = await import('../lib/bilibili.js');

// 1) wbi 接口返回 code 0 但字幕列表为空 —— 正是 issue #1 的现场
let calls = mockFetch([
  ['/x/web-interface/view', VIEW],
  ['/x/web-interface/nav', NAV],
  ['/x/player/wbi/v2', player([])],
  ['/x/player/v2?bvid=', player([{ url: `//${SUBTITLE_URL.replace('https://', '')}` }])],
  ['aisubtitle.hdslb.com', SUBTITLE_JSON],
]);
let doc = await resolveBilibili(settings, 'BV11vsD6mE7X');
assert.equal(doc.transcript.available, true, 'wbi 空列表时应回退 player/v2 拿到字幕');
assert.equal(doc.transcript.segments.length, 2);
assert.equal(doc.transcript.chars, 13);
assert.ok(calls.some((u) => u.includes('/x/player/v2?bvid=')), '应请求未签名的 player/v2');

// 2) wbi 接口被风控（-400）—— 仍应回退成功
calls = mockFetch([
  ['/x/web-interface/view', VIEW],
  ['/x/web-interface/nav', NAV],
  ['/x/player/wbi/v2', { code: -400, message: '请求错误' }],
  ['/x/player/v2?bvid=', player([{ url: `//${SUBTITLE_URL.replace('https://', '')}` }])],
  ['aisubtitle.hdslb.com', SUBTITLE_JSON],
]);
doc = await resolveBilibili(settings, 'BV11vsD6mE7X');
assert.equal(doc.transcript.available, true, 'wbi 报错时应回退 player/v2');

// 3) 所有接口都拿不到字幕 —— 警告里要暴露接口异常，而不是笼统说「没有字幕」
mockFetch([
  ['/x/web-interface/view', VIEW],
  ['/x/web-interface/nav', NAV],
  ['/x/player/wbi/v2', { code: -400, message: '请求错误' }],
  ['/x/player/v2?', { code: -352, message: '风控校验失败' }],
]);
doc = await resolveBilibili(settings, 'BV11vsD6mE7X');
assert.equal(doc.transcript.available, false);
assert.ok(doc.warnings.some((line) => line.includes('字幕接口异常')), `警告应包含接口异常：${doc.warnings.join(' | ')}`);

console.log('bilibili.test.mjs: pass 3/3');
