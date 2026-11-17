#!/usr/bin/env node
/**
 * dsh-video-insight 浏览器半自测脚本（无第三方依赖）
 *
 * 自带极简 React hooks 运行时 + 伪造 DOM / localStorage / fetch / SSE，
 * 在 vm 里执行 client/client.js，渲染 VideoPanel 并逐项断言。
 *
 *   node test/client.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const CLIENT = new URL('../client/client.js', import.meta.url).pathname;
const SOURCE = fs.readFileSync(CLIENT, 'utf8');

let pass = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { pass += 1; return; }
  failures.push(name);
};
const checkIncludes = (name, text, needle) => check(`${name}（缺 ${needle}）`, String(text).includes(needle));

/* ================================================================ React 极简运行时 */

let renderInst = null;
let instanceMap = new Map();
let currentRendered = new Set();
let prevRendered = new Set();
let dirty = false;
let effectsQueue = [];
const frameWindows = new Map();
const runtimeErrors = [];

function createElement(type, props, ...children) {
  return { __el: true, type, props: props || {}, children };
}

function slotAt(inst, index, create) {
  if (!inst.hooks[index]) inst.hooks[index] = create();
  return inst.hooks[index];
}

function useState(initial) {
  const inst = renderInst;
  const index = inst.cursor++;
  const slot = slotAt(inst, index, () => ({ value: typeof initial === 'function' ? initial() : initial }));
  const setState = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next;
    if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
  };
  return [slot.value, setState];
}

function useRef(initial) {
  const inst = renderInst;
  const index = inst.cursor++;
  return slotAt(inst, index, () => ({ current: initial }));
}

function depsChanged(prev, next) {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  return prev.some((item, index) => !Object.is(item, next[index]));
}

function useCallback(fn, deps) {
  const inst = renderInst;
  const index = inst.cursor++;
  const slot = slotAt(inst, index, () => ({ fn, deps }));
  if (depsChanged(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}

function useEffect(fn, deps) {
  const inst = renderInst;
  const index = inst.cursor++;
  const slot = slotAt(inst, index, () => ({ deps: undefined, ran: undefined, cleanup: null, fn }));
  slot.fn = fn;
  slot.deps = deps;
  effectsQueue.push({ inst, slot });
}

const React = { createElement, useState, useRef, useCallback, useEffect };

function flattenChildren(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flattenChildren(child));
    else out.push(child);
  }
  return out;
}

function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    return node.map((child, index) => renderNode(child, `${path}[${index}]`)).filter(Boolean);
  }
  if (typeof node === 'string' || typeof node === 'number') return { __host: 'text', text: String(node) };
  if (!node || !node.__el) return null;
  if (typeof node.type === 'function') {
    const name = node.type.name || 'Anonymous';
    const key = node.props && node.props.key !== undefined ? `#${node.props.key}` : '';
    const id = `${name}@${path}${key}`;
    let inst = instanceMap.get(id);
    if (!inst) { inst = { id, hooks: [], name }; instanceMap.set(id, inst); }
    const saved = renderInst;
    renderInst = inst;
    inst.cursor = 0;
    let output;
    try {
      output = node.type(node.props || {});
    } catch (error) {
      runtimeErrors.push(`${name}: ${error && error.stack ? error.stack : error}`);
      output = null;
    } finally {
      renderInst = saved;
    }
    currentRendered.add(inst);
    return renderNode(output, id);
  }
  const host = { __host: 'element', tag: String(node.type), props: node.props || {}, children: [] };
  host.children = flattenChildren(node.children)
    .map((child, index) => renderNode(child, `${path}/${host.tag}[${index}]`))
    .filter(Boolean);
  host.getBoundingClientRect = () => {
    const isRow = String(host.props.className || '').split(/\s+/).includes('dvv-seg');
    if (sandbox.__rectMode === 'visible') return { top: 10, bottom: 20, left: 0, right: 200 };
    return isRow
      ? { top: 400, bottom: 420, left: 0, right: 200 }
      : { top: 0, bottom: 100, left: 0, right: 200 };
  };
  host.scrollIntoView = (options) => { sandbox.__scrollCalls.push({ node: host, options }); };
  if (host.tag === 'iframe') {
    let win = frameWindows.get(path);
    if (!win) {
      win = { messages: [], postMessage(data) { this.messages.push(data); } };
      frameWindows.set(path, win);
    }
    host.contentWindow = win;
  }
  for (const child of host.children) child.parentElement = host;
  const ref = host.props.ref;
  if (typeof ref === 'function') ref(host);
  else if (ref && typeof ref === 'object') ref.current = host;
  return host;
}

function runEffects() {
  const queue = effectsQueue;
  effectsQueue = [];
  for (const { inst, slot } of queue) {
    if (!currentRendered.has(inst)) continue;
    const changed = slot.ran === undefined || depsChanged(slot.ran, slot.deps);
    if (!changed) continue;
    if (typeof slot.cleanup === 'function') {
      try { slot.cleanup(); } catch (error) { runtimeErrors.push(`cleanup: ${error}`); }
      slot.cleanup = null;
    }
    slot.ran = slot.deps;
    let cleanup;
    try { cleanup = slot.fn(); } catch (error) { runtimeErrors.push(`effect: ${error && error.stack ? error.stack : error}`); }
    slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }
}

function cleanupUnmounted() {
  for (const inst of prevRendered) {
    if (currentRendered.has(inst)) continue;
    for (const slot of inst.hooks) {
      if (slot && typeof slot.cleanup === 'function') {
        try { slot.cleanup(); } catch { /* ignore */ }
      }
    }
    instanceMap.delete(inst.id);
  }
  prevRendered = new Set(currentRendered);
}

let rootComponent = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderOnce() {
  dirty = false;
  currentRendered = new Set();
  renderInst = null;
  const tree = renderNode(createElement(rootComponent, {}), 'root');
  runEffects();
  cleanupUnmounted();
  return tree;
}

async function settle(rounds = 40) {
  let tree = renderOnce();
  await tick();
  for (let round = 0; round < rounds; round += 1) {
    if (dirty) {
      tree = renderOnce();
      await tick();
      continue;
    }
    await tick();
    if (dirty) {
      tree = renderOnce();
      await tick();
      continue;
    }
    return tree;
  }
  return tree;
}

/* ================================================================ 假 DOM / fetch */

function createSandbox() {
  const styleTags = [];
  const store = new Map();
  const listeners = new Map();
  const downloads = [];
  const blobs = [];
  const revoked = [];
  const clipboardWrites = [];
  const bodyChildren = [];
  class SandboxURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return `blob:test/${blobs.length}`; }
    static revokeObjectURL(url) { revoked.push(String(url)); }
  }
  const doc = {
    baseURI: 'http://panel.test/',
    head: { append(node) { styleTags.push(node); } },
    body: {
      appendChild(node) { bodyChildren.push(node); },
      removeChild(node) { const index = bodyChildren.indexOf(node); if (index >= 0) bodyChildren.splice(index, 1); },
    },
    createElement(tag) {
      return {
        tag, dataset: {}, style: {}, textContent: '', children: [],
        setAttribute(key, value) { this[key] = value; },
        append() {}, select() {},
        click() {
          if (this.tag === 'a') downloads.push({ href: this.href, download: this.download });
          this.__clicked = true;
        },
      };
    },
    execCommand() { return true; },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: SandboxURL, URLSearchParams, TextDecoder, TextEncoder, AbortController, Blob,
    document: doc,
    navigator: { clipboard: { writeText: async (text) => { clipboardWrites.push(String(text)); return true; } } },
    localStorage: {
      getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
      setItem: (key, value) => { store.set(String(key), String(value)); },
      removeItem: (key) => { store.delete(String(key)); },
    },
    location: { origin: 'http://panel.test', href: 'http://panel.test/' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { if (listeners.has(type)) listeners.get(type).delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get(event && event.type) || []) fn(event);
      return true;
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.__ModuleLoader__ = { load(entry) { sandbox.__entry = entry; } };
  const calls = [];
  sandbox.__calls = calls;
  sandbox.__listeners = listeners;
  sandbox.__styleTags = styleTags;
  sandbox.__scrollCalls = [];
  sandbox.__rectMode = 'hidden';
  sandbox.__store = store;
  sandbox.__downloads = downloads;
  sandbox.__blobs = blobs;
  sandbox.__revoked = revoked;
  sandbox.__clipboardWrites = clipboardWrites;
  sandbox.fetch = (input, init) => fakeFetch(input, init, calls);
  return sandbox;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    body: null,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function sseResponse(events, signal) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      const abort = () => {
        if (closed) return;
        closed = true;
        try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* ignore */ }
      };
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort);
      }
      try {
        for (const event of events) {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        closed = true;
        controller.close();
      } catch { /* ignore */ }
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}), text: async () => '' };
}

let routes = {};

function fakeFetch(input, init, calls) {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/dsh-video\/api\//, '');
  const call = {
    path,
    method: (init && init.method) || 'GET',
    body: init && init.body ? JSON.parse(init.body) : undefined,
    params: Object.fromEntries(url.searchParams.entries()),
    signal: init && init.signal,
  };
  calls.push(call);
  const handler = routes[path];
  if (typeof handler === 'function') {
    try {
      const result = handler(call);
      if (result && result.__sse) return Promise.resolve(sseResponse(result.__sse, call.signal));
      return Promise.resolve(jsonResponse(result));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return Promise.resolve(jsonResponse({ ok: false, code: 'internal', error: `未配置的假接口：${path}` }));
}

/* ================================================================ DOM 查询工具 */

function walk(node, visit) {
  if (!node) return;
  visit(node);
  if (node.__host === 'element') for (const child of node.children) walk(child, visit);
}

function findAll(tree, predicate) {
  const out = [];
  walk(tree, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

function findOne(tree, predicate) {
  return findAll(tree, predicate)[0] || null;
}

function nodeText(node) {
  if (!node) return '';
  if (node.__host === 'text') return node.text;
  if (node.__host !== 'element') return '';
  return node.children.map(nodeText).join('');
}

function hasClass(node, cls) {
  const className = node && node.__host === 'element' && node.props && node.props.className;
  return typeof className === 'string' && className.split(/\s+/).includes(cls);
}

const byClass = (tree, cls) => findOne(tree, (node) => hasClass(node, cls));
const allByClass = (tree, cls) => findAll(tree, (node) => hasClass(node, cls));
const byTag = (tree, tag) => findOne(tree, (node) => node.__host === 'element' && node.tag === tag);
const allByTag = (tree, tag) => findAll(tree, (node) => node.__host === 'element' && node.tag === tag);
const byText = (tree, needle) => findOne(tree, (node) => (node.__host === 'element' || node.__host === 'text') && nodeText(node).includes(needle));
const buttonByText = (tree, needle) => findOne(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node).includes(needle));
const byLinkText = (tree, needle) => findOne(tree, (node) => node.__host === 'element' && node.tag === 'a' && nodeText(node).includes(needle));
const inputByLabel = (tree, label) => findOne(tree, (node) => node.__host === 'element' && node.tag === 'input'
  && String(node.props['aria-label'] || '') === label);

function click(node) {
  if (!node || typeof node.props.onClick !== 'function') return false;
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: { value: '', checked: false }, key: '' });
  return true;
}

function clickText(tree, needle) {
  return click(buttonByText(tree, needle));
}

function change(node, value) {
  if (!node || typeof node.props.onChange !== 'function') return false;
  node.props.onChange({ target: { value }, preventDefault() {}, stopPropagation() {}, key: '' });
  return true;
}

function keydown(node, key) {
  if (!node || typeof node.props.onKeyDown !== 'function') return false;
  node.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {}, target: { value: '' } });
  return true;
}

const callsOf = (path) => sandbox.__calls.filter((call) => call.path === path);
const lastCallOf = (path) => callsOf(path).slice(-1)[0] || null;

/* ================================================================ 假数据 */

const now = Date.now();

const STATUS = {
  version: '0.6.0',
  model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  bilibili: { cookie: false },
  platforms: { youtube: true, bilibili: true },
};

const ASR = {
  enabled: false,
  engine: 'auto',
  engineLabel: 'Whisper（whisper.cpp）',
  activeEngine: 'whisper',
  ready: true,
  downloadReady: true,
  hints: [],
  privacy: '语音转写与画面文字识别完全在本机运行；画面理解会把抽样的画面图片发给当前模型（会离开本机）；摘要使用当前配置的模型。',
  ocr: { available: true, label: '画面文字（macOS Vision）', binaryPath: '/usr/bin/swift', platform: 'darwin', reason: '', note: '', enabled: true },
  vision: {
    label: '画面理解（视觉模型）', mode: 'auto', enabled: true, available: true,
    provider: 'opencode-go', model: 'deepseek-v4.1-flash',
    routeLabel: 'opencode-go/deepseek-v4.1-flash', supportsImage: true, reason: '', candidates: [],
    config: { frameMode: 'auto', visionModel: '', visionMaxFrames: 48 },
    privacy: '画面理解会把抽出来的画面图片交给当前模型（会离开本机）；OCR 仍然完全在本机运行。',
    ocrFallback: true,
  },
  config: {
    threads: 0, maxSeconds: 0, keepAudio: false, autoTranscribe: true,
    ocrFallback: true, ocrIntervalSeconds: 8, ocrMaxFrames: 120,
    frameMode: 'auto', visionModel: '', visionMaxFrames: 48,
  },
  tools: {
    ffmpeg: { available: true, path: '/opt/homebrew/bin/ffmpeg' },
    ytdlp: { available: true, path: '/opt/homebrew/bin/yt-dlp' },
    whisper: { available: true, path: '/opt/homebrew/bin/whisper-cli' },
    sherpa: { available: true, path: '/usr/local/bin/sherpa-onnx' },
  },
  models: {
    whisper: { path: '/Users/test/.dsh/video-models/ggml-large-v3-turbo.bin', available: true },
    sensevoice: { modelPath: '/Users/test/.dsh/video-models/sensevoice/model.int8.onnx', tokensPath: '/Users/test/.dsh/video-models/sensevoice/tokens.txt', available: true },
  },
  engines: {
    whisper: { available: true, label: 'Whisper（whisper.cpp）' },
    sensevoice: { available: true, label: 'SenseVoice（sherpa-onnx）' },
  },
};

const SEGMENTS = [
  { start: 0, end: 4, text: '大家好，今天我们聊 AI 编程' },
  { start: 8, end: 12, text: '第一性原理是拆到最本质的问题' },
  { start: 62, end: 70, text: '注意力经济让内容变得碎片化' },
];

function makeDoc(overrides) {
  return {
    platform: 'bilibili',
    docId: 'bilibili:BV1xx411c7mD',
    id: 'BV1xx411c7mD',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: '用第一性原理理解 AI 编程',
    author: '硬核拆解',
    authorAvatar: '',
    cover: 'https://i0.hdslb.com/bfs/cover.jpg',
    duration: 754,
    publishedAt: '2026-10-01T10:00:00.000Z',
    description: '一期讲 AI 编程的视频',
    stats: { views: 123456, likes: 8000, comments: 321, favorites: 1000, danmaku: 88 },
    pages: [{ index: 1, title: 'P1 开场', duration: 754 }],
    officialChapters: [{ title: '开场', start: 0 }, { title: '核心论点', start: 62 }],
    transcript: {
      available: true, source: 'bilibili-ai-subtitle', lang: 'zh', chars: 26,
      segments: SEGMENTS.map((segment) => ({ ...segment })),
    },
    officialSummary: null,
    warnings: [],
    analysis: null,
    ...overrides,
  };
}

const BILI_DOC = makeDoc({});

const YT_DOC = makeDoc({
  platform: 'youtube',
  docId: 'youtube:seekYT',
  id: 'seekYT',
  url: 'https://www.youtube.com/watch?v=seekYT',
  title: 'YouTube 视频：如何做产品',
  author: 'Product Guy',
  cover: '',
  duration: 213,
  transcript: {
    available: true, source: 'youtube-caption', lang: 'en', chars: 20,
    segments: [{ start: 0, end: 5, text: 'hello world' }, { start: 10, end: 15, text: 'product thinking' }],
  },
});

const CACHE_DOC = makeDoc({
  docId: 'bilibili:BVcache1',
  id: 'BVcache1',
  url: 'https://www.bilibili.com/video/BVcache1',
  title: '带缓存分析结果的视频',
  analysis: {
    savedAt: now - 3600e3,
    summary: { text: '## 缓存结论\n- 缓存要点一\n- 缓存要点二', generatedAt: now - 3600e3 },
    chapters: { items: [{ start: 0, title: '缓存章节一', gist: '缓存章节说明' }, { start: 30, title: '缓存章节二', gist: '' }], source: 'llm', generatedAt: now - 3600e3 },
    mindmap: {
      mindmap: { title: '缓存思维导图', children: [{ title: '缓存分支', children: [{ title: '缓存叶子' }] }] },
      generatedAt: now - 3600e3,
    },
    chat: [
      { role: 'user', text: '缓存问题是什么？', citations: [], at: now - 3500e3 },
      { role: 'assistant', text: '缓存回答在这里。', citations: [{ start: 3, end: 9, preview: '缓存依据片段' }], at: now - 3500e3 },
    ],
  },
});

const NOCAP_DOC = makeDoc({
  docId: 'bilibili:BVnocap1',
  id: 'BVnocap1',
  url: 'https://www.bilibili.com/video/BVnocap1',
  title: '没有字幕的视频',
  transcript: { available: false, source: 'none', lang: '', chars: 0, segments: [] },
  warnings: ['这个视频没有可用的字幕（B 站 AI 字幕需要登录 Cookie）。'],
});

const AUTO_DOC = makeDoc({
  docId: 'bilibili:BVauto1',
  id: 'BVauto1',
  url: 'https://www.bilibili.com/video/BVauto1',
  title: '自动转写的视频',
  transcript: { available: false, source: 'none', lang: '', chars: 0, segments: [] },
  warnings: ['这个视频没有可用的字幕。'],
});

const MINDMAP_VALUE = {
  docId: 'bilibili:BV1xx411c7mD',
  mindmap: {
    title: '思维导图：用第一性原理理解 AI 编程',
    children: [
      { title: '开场', children: [{ title: '信息密度' }, { title: '注意力经济' }] },
      { title: '核心论点', children: [{ title: '时间成本' }, { title: '创造力' }] },
    ],
  },
  source: 'llm',
  generatedAt: now - 60e3,
};

const CHAPTERS_VALUE = {
  chapters: [
    { start: 0, title: '开场', gist: '开场先讲今天要解决的问题。' },
    { start: 62, title: '核心论点', gist: '注意力经济让内容碎片化。' },
  ],
};

const STORYBOARD_VALUE = {
  docId: 'bilibili:BV1xx411c7mD',
  url: BILI_DOC.url,
  title: BILI_DOC.title,
  platform: 'bilibili',
  duration: BILI_DOC.duration,
  generatedAt: now - 30e3,
  tookMs: 1200,
  frameSampling: 'cuts',
  cuts: 3,
  frames: 4,
  cols: 2,
  rows: 2,
  cellWidth: 640,
  cellHeight: 360,
  described: false,
  cells: [
    { index: 0, row: 0, col: 0, seconds: 0 },
    { index: 1, row: 0, col: 1, seconds: 30 },
    { index: 2, row: 1, col: 0, seconds: 62 },
    { index: 3, row: 1, col: 1, seconds: 120 },
  ],
};

const SUMMARY_TEXT = '## 结论\n- 要点一\n- 要点二\n\n**重点**：`代码` 与 [00:08]\n\n### 深入\n1. 第一\n2. 第二';

const SUMMARY_EVENTS = [
  { type: 'phase', text: '正在读取字幕…' },
  { type: 'delta', text: SUMMARY_TEXT.slice(0, 20) },
  { type: 'delta', text: SUMMARY_TEXT.slice(20) },
  { type: 'done', text: SUMMARY_TEXT, usage: {}, suggestions: [] },
];

const ASK_ANSWER = '这是回答：核心论点是拆到最本质的问题。';
const ASK_EVENTS = [
  { type: 'phase', text: '正在检索字幕相关段落…' },
  { type: 'delta', text: ASK_ANSWER.slice(0, 8) },
  { type: 'delta', text: ASK_ANSWER.slice(8) },
  {
    type: 'done', text: ASK_ANSWER,
    citations: [
      { start: 62, end: 70, preview: '注意力经济让内容变得碎片化' },
      { start: 8, end: 12, preview: '第一性原理是拆到最本质的问题' },
    ],
  },
];

const TRANSCRIBE_EVENTS = [
  { type: 'phase', text: '正在准备音频…' },
  { type: 'progress', stage: 'download', percent: 20 },
  { type: 'progress', stage: 'frames', percent: null },
  {
    type: 'done',
    docId: 'bilibili:BVauto1',
    transcript: {
      available: true, source: 'local-whisper', engine: 'whisper', engineLabel: 'Whisper（whisper.cpp）',
      lang: 'zh', chars: 12,
      segments: [{ start: 0, end: 4, text: '本地转写第一句' }, { start: 4, end: 8, text: '本地转写第二句' }],
    },
  },
];

const STORYBOARD_EVENTS = [
  { type: 'progress', stage: 'download', percent: 10 },
  { type: 'phase', text: '正在扫描镜头…' },
  { type: 'progress', stage: 'frames', percent: null },
  { type: 'done', cached: false, docId: 'bilibili:BV1xx411c7mD', storyboard: STORYBOARD_VALUE },
];

const TRANSLATE_TEXTS = {
  en: [
    'Hi everyone, today we talk about AI coding',
    'First principles is about the most essential question',
    'Attention economy fragments content',
  ],
  zh: ['中文译文第一句', '中文译文第二句', '中文译文第三句'],
};

function translateEvents(lang) {
  const texts = TRANSLATE_TEXTS[lang] || TRANSLATE_TEXTS.en;
  return [
    { type: 'phase', text: lang === 'zh' ? '正在把字幕翻译成中文…' : '正在把字幕翻译成英文…' },
    { type: 'progress', stage: 'translate', percent: 40 },
    {
      type: 'done', docId: 'bilibili:BV1xx411c7mD', lang,
      langLabel: lang === 'zh' ? '中文' : 'English', cached: false, count: SEGMENTS.length,
      translations: SEGMENTS.map((segment, index) => ({
        start: segment.start, end: segment.end, text: segment.text,
        translation: texts[index] || `translation ${index}`,
      })),
    },
  ];
}

let translateCache = null;

let historyItems = [
  {
    docId: 'bilibili:BV1xx411c7mD', url: BILI_DOC.url, platform: 'bilibili', id: 'BV1xx411c7mD',
    title: BILI_DOC.title, author: '硬核拆解', duration: 754, cover: BILI_DOC.cover,
    hasTranscript: true, hasSummary: true, hasChapters: true, hasMindmap: true, chatCount: 3,
    analyzedAt: now - 120e3, action: 'analyze',
  },
  {
    docId: 'youtube:hist1', url: 'https://www.youtube.com/watch?v=hist1', platform: 'youtube', id: 'hist1',
    title: '历史上的 YouTube 视频', author: 'Someone', duration: 213, cover: '',
    hasTranscript: false, hasSummary: false, hasChapters: false, hasMindmap: false, chatCount: 0,
    analyzedAt: now - 3 * 3600e3, action: 'view',
  },
];

function resetRoutes() {
  translateCache = null;
  routes = {
    status: () => ({ ok: true, value: STATUS }),
    history: () => ({ ok: true, value: { items: historyItems } }),
    'history/remove': (call) => {
      historyItems = historyItems.filter((item) => item.docId !== (call.body && call.body.docId));
      return { ok: true, value: { items: historyItems } };
    },
    'history/clear': () => {
      historyItems = [];
      return { ok: true, value: { items: [] } };
    },
    'asr/status': () => ({ ok: true, value: ASR }),
    'asr/config': (call) => {
      const body = call.body || {};
      for (const key of ['enabled', 'engine']) if (key in body) ASR[key] = body[key];
      for (const key of ['threads', 'maxSeconds', 'keepAudio', 'autoTranscribe', 'ocrFallback', 'ocrIntervalSeconds', 'ocrMaxFrames', 'frameMode', 'visionModel', 'visionMaxFrames']) {
        if (key in body) ASR.config[key] = body[key];
      }
      if (ASR.vision && ASR.vision.config) {
        for (const key of ['frameMode', 'visionModel', 'visionMaxFrames']) if (key in body) ASR.vision.config[key] = body[key];
      }
      return { ok: true, value: ASR };
    },
    'asr/config/_:unused': () => ({ ok: true, value: ASR }),
    credentials: () => ({ ok: true, value: { bilibili: { cookie: true } } }),
    resolve: (call) => {
      const target = String(call.params.url || '');
      if (target.includes('bad-url')) {
        return { ok: false, code: 'bad-url', error: '链接无法识别，请粘贴 YouTube 或 B 站视频链接。' };
      }
      if (target.includes('cache1')) return { ok: true, value: CACHE_DOC };
      if (target.includes('BVnocap1') || target.includes('nocap')) return { ok: true, value: NOCAP_DOC };
      if (target.includes('BVauto1') || target.includes('auto')) return { ok: true, value: AUTO_DOC };
      if (target.includes('seekYT') || target.includes('youtu')) return { ok: true, value: YT_DOC };
      return { ok: true, value: BILI_DOC };
    },
    chapters: () => ({ ok: true, value: CHAPTERS_VALUE }),
    mindmap: () => ({ ok: true, value: MINDMAP_VALUE }),
    analyze: (call) => ({ __sse: call.body && call.body.mode === 'ask' ? ASK_EVENTS : SUMMARY_EVENTS }),
    transcribe: () => ({ __sse: TRANSCRIBE_EVENTS }),
    translate: (call) => {
      if (call.method === 'GET') return { ok: true, value: translateCache };
      const lang = String((call.body && call.body.lang) || 'en');
      return { __sse: translateEvents(lang) };
    },
    storyboard: (call) => {
      if (call.method === 'GET') return { ok: true, value: null };
      return { __sse: STORYBOARD_EVENTS };
    },
    'storyboard/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    'analysis/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    'analysis/chat/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    'analysis': () => ({ ok: false, code: 'not-found', error: '没有缓存' }),
  };
}

/* ================================================================ 启动 */

const sandbox = createSandbox();
resetRoutes();
vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });

const entry = sandbox.__entry;
check('模块通过 __ModuleLoader__ 加载', Boolean(entry));
check('插件 id 为 dsh-video-insight', entry && entry.id === 'dsh-video-insight');

const requireStub = (id) => {
  if (id === 'react') return React;
  throw new Error(`未知依赖：${id}`);
};
const exports_ = entry.factory(requireStub);
check('factory 返回 apply', typeof exports_.apply === 'function');
check('inject 含 slots 与 layout', Array.isArray(exports_.inject) && exports_.inject.includes('slots') && exports_.inject.includes('layout'));
check('暴露 __test 纯函数', Boolean(exports_.__test && typeof exports_.__test.buildMindmapLayout === 'function'
  && typeof exports_.__test.renderMarkdown === 'function' && typeof exports_.__test.clockToSeconds === 'function'));

// buildNoteMarkdown：标题 / 来源行 / 正文 / 章节
const mdAll = exports_.__test.buildNoteMarkdown(BILI_DOC, { summary: SUMMARY_TEXT, chapters: CHAPTERS_VALUE.chapters });
check('buildNoteMarkdown 暴露', typeof exports_.__test.buildNoteMarkdown === 'function');
check('buildNoteMarkdown 标题行', mdAll.startsWith(`# ${BILI_DOC.title}\n`));
checkIncludes('buildNoteMarkdown 来源行', mdAll, `> 哔哩哔哩 · ${BILI_DOC.author} · 12:34 · ${BILI_DOC.url}`);
checkIncludes('buildNoteMarkdown 保留总结正文', mdAll, '## 结论');
checkIncludes('buildNoteMarkdown 保留列表', mdAll, '- 要点一');
checkIncludes('buildNoteMarkdown 章节段', mdAll, '## 章节');
checkIncludes('buildNoteMarkdown 章节第一行', mdAll, '- [0:00] 开场');
checkIncludes('buildNoteMarkdown 章节第二行', mdAll, '- [1:02] 核心论点');
check('buildNoteMarkdown 没有空 · 分隔', !mdAll.includes('· ·') && !/>\s*·/m.test(mdAll));
const mdNoChapters = exports_.__test.buildNoteMarkdown(BILI_DOC, { summary: '一段总结', chapters: [] });
check('buildNoteMarkdown chapters 为空时无章节段', !mdNoChapters.includes('## 章节') && mdNoChapters.includes('一段总结'));
const mdSparse = exports_.__test.buildNoteMarkdown({ title: '只有标题', platform: 'youtube', url: 'https://youtu.be/x' }, { summary: '', chapters: [] });
check('buildNoteMarkdown 缺项省略不留空 ·', mdSparse.includes('> YouTube · https://youtu.be/x') && !mdSparse.includes('· ·'));
check('sanitizeFileName 去掉非法字符', exports_.__test.sanitizeFileName('a/b:c*?"<>|d') === 'a b c d');

const registered = [];
const layoutCalls = [];
const ctx = {
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  slots: {
    inject(name, fn) { fn(); return () => {}; },
    register(spec, component) { registered.push({ spec, component }); return () => {}; },
  },
  get(name) {
    if (name === 'layout') return { panel: 'video', selectPanel(id) { layoutCalls.push(id); } };
    return null;
  },
};
exports_.apply(ctx);
check('注册两个插槽', registered.length === 2);
const sidebar = registered.find((item) => item.spec.name === 'sidebar.panellist');
const main = registered.find((item) => item.spec.name === 'main');
check('侧栏注册 id=video', sidebar && sidebar.spec.id === 'video');
check('侧栏注册 order=30', sidebar && sidebar.spec.order === 30);
check('侧栏 label 返回「视频解析」', sidebar && sidebar.spec.label() === '视频解析');
check('侧栏组件是 VideoIcon', sidebar && typeof sidebar.component === 'function');
check('主区注册 key=video', main && main.spec.key === 'video');
check('主区组件是 VideoPanel', main && typeof main.component === 'function');
const styleTag = sandbox.__styleTags[0];
check('样式已注入 <style data-dsh-video=panel>', Boolean(styleTag) && styleTag.dataset && styleTag.dataset.dshVideo === 'panel');
const css = styleTag ? String(styleTag.textContent) : '';
checkIncludes('样式含播放器外壳', css, '.dvv-frame-wrap');
checkIncludes('样式含分镜格子', css, '.dvv-sb-cell');
checkIncludes('样式含品牌 token', css, '--dsw-alias-brand-primary');

rootComponent = main.component;

const report = (phase) => {
  if (failures.length) console.log(`[${phase}] 已失败：${failures.slice(-4).join(' / ')}`);
};

/* ---------------------------------------------------------------- 首页 */

let tree = await settle();
checkIncludes('首页标题「视频解析」', nodeText(tree), '视频解析');
checkIncludes('首页副标题', nodeText(tree), '粘贴 YouTube / 哔哩哔哩链接，自动抓字幕、生成总结、章节和思维导图');
check('首页有解析输入框', Boolean(byClass(tree, 'dvv-home-input')));
checkIncludes('输入框带示例占位', String((byClass(tree, 'dvv-home-input') || {}).props?.placeholder || ''), 'youtube.com');
check('首页有「解析」按钮', Boolean(buttonByText(tree, '解析')));
checkIncludes('未配置 Cookie 有 B 站提示', nodeText(tree), 'B 站 AI 字幕需要登录 Cookie');
checkIncludes('首页历史列表', nodeText(tree), '最近分析');
checkIncludes('首页历史条目标题', nodeText(tree), '用第一性原理理解 AI 编程');
check('挂载时拉取 status/history/asr', callsOf('status').length === 1 && callsOf('history').length >= 1 && callsOf('asr/status').length === 1);
check('侧栏图标为 16x16 播放三角', (() => {
  const icon = sidebar.component({ size: 16, active: false });
  const texts = JSON.stringify(icon);
  return texts.includes('viewBox') && texts.includes('16');
})());

/* ---------------------------------------------------------------- 解析视频 */

let homeInput = byClass(tree, 'dvv-home-input');
change(homeInput, BILI_DOC.url);
tree = await settle();
homeInput = byClass(tree, 'dvv-home-input');
keydown(homeInput, 'Enter');
tree = await settle();
check('回车触发 /resolve', callsOf('resolve').length === 1);
checkIncludes('错误横幅为空（解析成功）', nodeText(tree), '用第一性原理理解 AI 编程');
checkIncludes('工具栏显示标题', nodeText(tree), '用第一性原理理解 AI 编程');
checkIncludes('工具栏显示平台与统计', nodeText(tree), 'B 站');
checkIncludes('工具栏显示统计行', nodeText(tree), '播放');
checkIncludes('工具栏显示作者', nodeText(tree), '硬核拆解');
checkIncludes('工具栏显示播放数（万）', nodeText(tree), '12.3万');

const toolbar = byClass(tree, 'dvv-toolbar');
check('解析后有工具栏', Boolean(toolbar));
check('解析后有返回按钮', Boolean(buttonByText(tree, '返回')));
check('解析后有双栏布局', Boolean(byClass(tree, 'dvv-body') && byClass(tree, 'dvv-col-left') && byClass(tree, 'dvv-col-right')));

const iframe = byTag(tree, 'iframe');
checkIncludes('播放器走 Host 外壳（同源相对路径）', String(iframe && iframe.props.src), '/dsh-video/api/player?platform=bilibili&id=BV1xx411c7mD&page=1&start=0');
check('播放器 iframe 不直连平台', Boolean(iframe) && !/youtube\.com\/embed|player\.bilibili\.com/.test(String(iframe.props.src)));
checkIncludes('字幕来源与语言', nodeText(tree), 'B 站 AI 字幕');
checkIncludes('字幕条数', nodeText(tree), '3 条');
checkIncludes('字幕字数', nodeText(tree), '26 字');
checkIncludes('链接可在新窗口打开', JSON.stringify(byClass(tree, 'dvv-toolbar-title')?.props || {}), '_blank');

// 播放器折叠
clickText(tree, '收起播放器');
tree = await settle();
check('折叠后 iframe 消失', !byTag(tree, 'iframe'));
check('折叠状态写入 localStorage', sandbox.__store.get('dsh-video.player.collapsed') === '1');
clickText(tree, '展开播放器');
tree = await settle();
check('展开后 iframe 恢复', Boolean(byTag(tree, 'iframe')));
check('展开状态写入 localStorage', sandbox.__store.get('dsh-video.player.collapsed') === '0');

// 播放器外壳基址：transport 优先
sandbox.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:50231/' };
tree = await settle();
checkIncludes('有传输层时用绝对 http 外壳', String((byTag(tree, 'iframe') || {}).props?.src || ''), 'http://127.0.0.1:50231/dsh-video/api/player?');
delete sandbox.__DSH_TRANSPORT__;
sandbox.location.origin = 'dsh-app://app';
tree = await settle();
checkIncludes('无 http 起源时显示占位', nodeText(tree), '当前环境无法内嵌播放器');
check('无 http 起源时不渲染 iframe', !byTag(tree, 'iframe'));
sandbox.location.origin = 'http://panel.test';
tree = await settle();

/* ---------------------------------------------------------------- 总结页 */

checkIncludes('总结自动生成并渲染标题', nodeText(tree), '结论');
checkIncludes('总结渲染列表项', nodeText(tree), '要点一');
checkIncludes('总结渲染粗体', JSON.stringify(findAll(tree, (n) => n.__host === 'element' && n.tag === 'strong').map(nodeText)), '重点');
checkIncludes('总结渲染行内代码', nodeText(tree), '代码');
checkIncludes('总结把 [00:08] 渲染为时间徽标', JSON.stringify(allByClass(tree, 'dvv-md').map(nodeText)), '00:08');
check('总结完成后有重新生成按钮', Boolean(buttonByText(tree, '重新生成')));
check('总结完成后有复制按钮', Boolean(buttonByText(tree, '复制')));
check('总结页有「复制 Markdown」按钮', Boolean(buttonByText(tree, '复制 Markdown')));
check('总结页有「下载 .md」按钮', Boolean(buttonByText(tree, '下载 .md')));
const expectedMd = exports_.__test.buildNoteMarkdown(BILI_DOC, { summary: SUMMARY_TEXT, chapters: null });
clickText(tree, '复制 Markdown');
tree = await settle();
check('复制 Markdown 写入剪贴板', sandbox.__clipboardWrites.length === 1 && sandbox.__clipboardWrites[0] === expectedMd);
checkIncludes('复制 Markdown 提示字数', nodeText(tree), '已复制 Markdown（');
clickText(tree, '下载 .md');
tree = await settle();
await new Promise((resolve) => setTimeout(resolve, 1100));
check('下载 .md 触发 a[download]', sandbox.__downloads.length === 1 && /\.md$/.test(sandbox.__downloads[0].download));
check('下载文件名为视频标题', sandbox.__downloads[0] && sandbox.__downloads[0].download === `${BILI_DOC.title}.md`);
check('下载 blob 类型为 markdown', sandbox.__blobs.length === 1 && String(sandbox.__blobs[0].type).includes('text/markdown'));
check('下载后 revokeObjectURL', sandbox.__revoked.length === 1);
checkIncludes('页签包含分镜', nodeText(byClass(tree, 'dvv-tabbar')), '分镜');
check('页签共 5 个', allByClass(tree, 'dvv-tab').length === 5);

// 点总结里的时间徽标 → seek
const tsBadge = allByClass(tree, 'dvv-md-ts')[0] || allByClass(tree, 'dvv-ts')[0];
if (tsBadge) click(tsBadge);
tree = await settle();
const frameWin = (() => {
  const frames = allByTag(tree, 'iframe');
  return frames.length ? frames[0].contentWindow : null;
})();
check('点击时间徽标向播放器外壳发 seek', Boolean(frameWin && frameWin.messages.some((msg) => msg && msg.type === 'dsh-video:seek' && msg.seconds === 8)));

/* ---------------------------------------------------------------- 章节页 */

clickText(tree, '章节');
tree = await settle();
check('切到章节时 POST /chapters', callsOf('chapters').length >= 1);
checkIncludes('章节列表标题', nodeText(tree), '开场');
checkIncludes('章节列表时间戳', nodeText(tree), '[0:00]');
checkIncludes('章节重新生成按钮', nodeText(tree), '重新生成章节');
const chapterHead = allByClass(tree, 'dvv-ch-head')[0];
check('章节头部可展开', Boolean(chapterHead) && click(chapterHead));
tree = await settle();
checkIncludes('展开后显示章节 gist', nodeText(tree), '开场先讲今天要解决的问题');
click(allByClass(tree, 'dvv-ch-head')[1]);
tree = await settle();
const chFrame = allByTag(tree, 'iframe')[0];
check('点击章节发送 seek 到外壳', Boolean(chFrame) && chFrame.contentWindow.messages.some((msg) => msg && msg.seconds === 62));

/* ---------------------------------------------------------------- 原文页 */

clickText(tree, '原文');
tree = await settle();
checkIncludes('原文页显示字幕文本', nodeText(tree), '大家好，今天我们聊 AI 编程');
checkIncludes('原文页显示条数', nodeText(tree), '共 3 条');
check('原文页有搜索框', Boolean(byClass(tree, 'dvv-search')));
const search = byClass(tree, 'dvv-search');
change(search, '第一性');
tree = await settle();
checkIncludes('搜索过滤命中一条', nodeText(tree), '共 1 条');
checkIncludes('搜索命中内容', nodeText(tree), '第一性原理是拆到最本质的问题');
change(byClass(tree, 'dvv-search'), '');
tree = await settle();
clickText(tree, '复制全部');
tree = await settle();
checkIncludes('复制全部后给出提示', nodeText(tree), '已复制 3 条字幕');
const segs = allByClass(tree, 'dvv-seg');
click(segs[2]);
tree = await settle();
const segFrame = allByTag(tree, 'iframe')[0];
check('点击字幕发送 seek 到外壳', Boolean(segFrame) && segFrame.contentWindow.messages.some((msg) => msg && msg.seconds === 62));

/* ---------------------------------------------------------------- 双语对照 */

const trGetsBefore = callsOf('translate').filter((call) => call.method === 'GET').length;
const trPostsBefore = callsOf('translate').filter((call) => call.method === 'POST').length;
clickText(tree, '双语');
tree = await settle(60);
const trGets = callsOf('translate').filter((call) => call.method === 'GET');
const trPosts = callsOf('translate').filter((call) => call.method === 'POST');
check('开启双语先 GET 翻译缓存', trGets.length === trGetsBefore + 1);
check('没有缓存时 POST /translate 生成', trPosts.length === trPostsBefore + 1);
check('双语默认目标语言按字幕推断为 en', (trGets[trGets.length - 1] || {}).params.lang === 'en' && (trPosts[trPosts.length - 1] || {}).body.lang === 'en');
check('译文行数量 = 段落数量', allByClass(tree, 'dvv-tr-text').length === 3);
checkIncludes('译文内容渲染', nodeText(tree), 'Hi everyone');
const trBtn = buttonByText(tree, '双语');
check('双语开关处于激活态', Boolean(trBtn) && trBtn.props['data-active'] === 'true');

// 搜索同时匹配译文
change(byClass(tree, 'dvv-search'), 'Attention');
tree = await settle();
checkIncludes('搜索译文词命中一条', nodeText(tree), '共 1 条');
check('搜索译文词仍渲染译文行', allByClass(tree, 'dvv-tr-text').length === 1);
change(byClass(tree, 'dvv-search'), '');
tree = await settle();

// 复制全文带译文缩进
clickText(tree, '复制全部');
tree = await settle();
const trCopy = sandbox.__clipboardWrites[sandbox.__clipboardWrites.length - 1] || '';
checkIncludes('复制全文包含译文行', trCopy, '  译文：Hi everyone');

// 切换目标语言
const langSelect = allByTag(tree, 'select').find((node) => node.props['aria-label'] === '翻译目标语言');
check('双语开启后有目标语言下拉', Boolean(langSelect));
change(langSelect, 'zh');
tree = await settle(60);
const trZhPost = callsOf('translate').filter((call) => call.method === 'POST').slice(-1)[0];
check('切换语言请求 zh', Boolean(trZhPost) && trZhPost.body.lang === 'zh');
checkIncludes('中文译文渲染', nodeText(tree), '中文译文第一句');
change(allByTag(tree, 'select').find((node) => node.props['aria-label'] === '翻译目标语言'), 'en');
tree = await settle(60);

// 跟随播放高亮（dsh-video:time）
sandbox.__rectMode = 'hidden';
sandbox.__scrollCalls.length = 0;
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 9 } });
tree = await settle();
const trCurrent = allByClass(tree, 'dvv-seg').filter((node) => node.props['data-current'] === 'true');
check('跟随播放高亮当前段落', trCurrent.length === 1 && nodeText(trCurrent[0]).includes('第一性原理'));
check('当前行不可见时调用 scrollIntoView', sandbox.__scrollCalls.length === 1 && sandbox.__scrollCalls[0].options.block === 'nearest');
sandbox.__rectMode = 'visible';
sandbox.__scrollCalls.length = 0;
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 63 } });
tree = await settle();
const trCurrent2 = allByClass(tree, 'dvv-seg').filter((node) => node.props['data-current'] === 'true');
check('高亮随播放位置移动且只有一行', trCurrent2.length === 1 && nodeText(trCurrent2[0]).includes('注意力经济'));
check('当前行已在可视区时不滚动', sandbox.__scrollCalls.length === 0);
clickText(tree, '跟随');
tree = await settle();
sandbox.__rectMode = 'hidden';
sandbox.__scrollCalls.length = 0;
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 1 } });
tree = await settle();
const trCurrent3 = allByClass(tree, 'dvv-seg').filter((node) => node.props['data-current'] === 'true');
check('关闭跟随后高亮仍生效', trCurrent3.length === 1 && nodeText(trCurrent3[0]).includes('大家好'));
check('关闭跟随后不再自动滚动', sandbox.__scrollCalls.length === 0);
clickText(tree, '跟随');
tree = await settle();

/* ---------------------------------------------------------------- 思维导图 */

clickText(tree, '思维导图');
tree = await settle();
check('切到导图页 GET /mindmap', callsOf('mindmap').length >= 1);
checkIncludes('导图渲染根节点', nodeText(tree), '思维导图：用第一性原理理解 AI 编程');
checkIncludes('导图渲染一级分支', nodeText(tree), '信息密度');
check('导图 SVG 连线存在', allByTag(tree, 'path').length >= 2);
check('导图有全部展开按钮', Boolean(buttonByText(tree, '全部展开')));
clickText(tree, '全部收起');
tree = await settle();
check('收起后隐藏深层节点', !nodeText(tree).includes('信息密度'));
clickText(tree, '全部展开');
tree = await settle();
checkIncludes('全部展开后显示深层节点', nodeText(tree), '信息密度');
checkIncludes('导图显示缓存/生成信息', nodeText(tree), '当前模型');

/* ---------------------------------------------------------------- 分镜页 */

clickText(tree, '分镜');
tree = await settle();
check('切到分镜先读缓存 GET /storyboard', callsOf('storyboard').some((call) => call.method === 'GET'));
check('没有缓存时自动 POST 生成分镜', callsOf('storyboard').some((call) => call.method === 'POST'));
checkIncludes('分镜工具条帧数', nodeText(tree), '4 格 · 2×2');
checkIncludes('分镜格子时间戳', nodeText(tree), '0:00');
const sbCells = allByClass(tree, 'dvv-sb-cell');
check('分镜渲染 4 个格子', sbCells.length === 4);
check('分镜 image 指向 host 图片接口', String((byClass(tree, 'dvv-sb-img') || {}).props?.src || '').includes('/dsh-video/api/storyboard/image?docId='));
check('分镜有「打开大图」', Boolean(byLinkText(tree, '打开大图')));
click(sbCells[2]);
tree = await settle();
const sbFrame = allByTag(tree, 'iframe')[0];
check('点击分镜格子发送 seek', Boolean(sbFrame) && sbFrame.contentWindow.messages.some((msg) => msg && msg.seconds === 62));
const describeBox = byClass(tree, 'dvv-sb-check');
check('分镜有「附画面描述」开关', Boolean(describeBox) && nodeText(describeBox).includes('附画面描述'));

/* ---------------------------------------------------------------- 追问 */

const askInput = byTag(tree, 'textarea');
check('追问面板常驻', Boolean(byClass(tree, 'dvv-chat-panel')));
check('追问输入框存在', Boolean(askInput));
change(askInput, '这个视频的核心论点是什么？');
tree = await settle();
const askInput2 = byTag(tree, 'textarea');
keydown(askInput2, 'Enter');
tree = await settle();
check('追问 POST /analyze(mode=ask)', callsOf('analyze').some((call) => call.body && call.body.mode === 'ask'));
checkIncludes('追问显示回答', nodeText(tree), '这是回答：核心论点是拆到最本质的问题');
const cites = allByClass(tree, 'dvv-cite');
check('追问回答带 2 个「依据」chip', cites.length === 2);
checkIncludes('依据 chip 文字', nodeText(cites[0] || {}), '01:02–01:10');
check('依据 chip 带预览 title', Boolean(cites[0]) && cites[0].props.title === '注意力经济让内容变得碎片化');
click(cites[0]);
tree = await settle();
const citeFrame = allByTag(tree, 'iframe')[0];
check('点击依据 chip 发送 seek', Boolean(citeFrame) && citeFrame.contentWindow.messages.some((msg) => msg && msg.seconds === 62));

/* ---------------------------------------------------------------- 设置 */

clickText(tree, '设置');
tree = await settle();
checkIncludes('设置弹窗显示当前模型', nodeText(tree), 'opencode-go · deepseek-v4.1-flash');
const cookieField = findOne(tree, (node) => node.__host === 'element' && hasClass(node, 'dvv-field') && nodeText(node).includes('SESSDATA'));
const cookieArea = cookieField ? byTag(cookieField, 'textarea') : null;
check('设置弹窗有 Cookie 输入', Boolean(cookieArea));
change(cookieArea, 'SESSDATA=abc');
tree = await settle();
clickText(tree, '保存');
tree = await settle();
check('保存 Cookie POST /credentials', callsOf('credentials').some((call) => call.body && call.body.bilibiliCookie === 'SESSDATA=abc'));
checkIncludes('语音转写区块', nodeText(tree), '本地语音转写');
checkIncludes('抽帧间隔字段', nodeText(tree), '抽帧间隔（秒）');
checkIncludes('画面理解帧数字段', nodeText(tree), '画面理解最多帧数');
checkIncludes('线程数字段', nodeText(tree), '线程数');
checkIncludes('最长处理时长字段', nodeText(tree), '最长处理时长（秒）');

const settingsModal = byClass(tree, 'dvv-modal');
const checkboxes = allByTag(settingsModal, 'input').filter((node) => node.props.type === 'checkbox');
check('设置里有 4 个复选框', checkboxes.length === 4);
const enabledLabel = findOne(settingsModal, (node) => node.__host === 'element' && node.tag === 'label'
  && (nodeText(node).includes('已开启') || nodeText(node).includes('已关闭')));
const enabledBox = enabledLabel ? allByTag(enabledLabel, 'input')[0] : null;
enabledBox && enabledBox.props.onChange && enabledBox.props.onChange({ target: { checked: true } });
tree = await settle();
check('开启转写 POST enabled=true', callsOf('asr/config').some((call) => call.body && call.body.enabled === true));
enabledBox && enabledBox.props.onChange && enabledBox.props.onChange({ target: { checked: false } });
tree = await settle();

const numberFields = allByTag(byClass(tree, 'dvv-modal'), 'input').filter((node) => node.props.type === 'number');
check('设置里有 5 个数字输入', numberFields.length === 5);
const threadsField = findOne(tree, (node) => node.__host === 'element' && node.tag === 'label'
  && nodeText(node).includes('线程数') && allByTag(node, 'input').some((input) => input.props.type === 'number'));
check('线程数字段可定位', Boolean(threadsField));
const threadsInput = threadsField ? allByTag(threadsField, 'input')[0] : null;
change(threadsInput, '4');
tree = await settle();
const threadsField2 = findOne(tree, (node) => node.__host === 'element' && node.tag === 'label'
  && nodeText(node).includes('线程数') && allByTag(node, 'input').some((input) => input.props.type === 'number'));
const threadsInput2 = threadsField2 ? allByTag(threadsField2, 'input')[0] : null;
threadsInput2 && threadsInput2.props.onBlur && threadsInput2.props.onBlur({});
tree = await settle();
check('线程数提交 POST threads=4', callsOf('asr/config').some((call) => call.body && call.body.threads === 4));

const modeButtons = allByClass(tree, 'dvv-vseg-btn');
check('画面理解三选一存在', modeButtons.length === 3);
check('默认自动模式 active', modeButtons[0] && modeButtons[0].props['data-active'] === 'true');
click(modeButtons[2]);
tree = await settle();
check('切到画面理解 POST frameMode=vision', callsOf('asr/config').some((call) => call.body && call.body.frameMode === 'vision'));

const visionInput = inputByLabel(tree, '视觉模型');
check('视觉模型输入框存在', Boolean(visionInput));
change(visionInput, 'custom/vision-model');
tree = await settle();
const visionInput2 = inputByLabel(tree, '视觉模型');
visionInput2 && visionInput2.props.onBlur && visionInput2.props.onBlur({});
tree = await settle();
check('视觉模型 blur 提交', callsOf('asr/config').some((call) => call.body && call.body.visionModel === 'custom/vision-model'));

// 关闭设置
const closeBtn = buttonByText(tree, '关闭');
click(closeBtn);
tree = await settle();
check('设置弹窗关闭', !byClass(tree, 'dvv-modal'));

/* ---------------------------------------------------------------- 历史 */

clickText(tree, '历史');
tree = await settle();
checkIncludes('历史抽屉标题与条数', nodeText(tree), '历史记录 · 2');
check('历史抽屉里 2 条记录', allByClass(tree, 'dvv-hist').length >= 2);
checkIncludes('历史徽标：总结', nodeText(tree), '总结');
checkIncludes('历史徽标：导图', nodeText(tree), '导图');
checkIncludes('历史徽标：对话条数', nodeText(tree), '3 条对话');
checkIncludes('历史相对时间', nodeText(tree), '分钟前');
const delBtn = allByClass(tree, 'dvv-del')[0];
check('历史行有删除按钮', Boolean(delBtn));
click(delBtn);
tree = await settle();
check('删除历史 POST /history/remove', callsOf('history/remove').length === 1);
checkIncludes('删除后剩 1 条', nodeText(tree), '历史记录 · 1');
clickText(tree, '清空历史');
tree = await settle();
checkIncludes('清空需二次确认', nodeText(tree), '确认清空？');
clickText(tree, '确认清空？');
tree = await settle();
check('清空历史 POST /history/clear', callsOf('history/clear').length === 1);
checkIncludes('清空后空态', nodeText(tree), '还没有分析记录');
clickText(tree, '关闭');
tree = await settle();

/* ---------------------------------------------------------------- 缓存回填 */

let homeInput2 = byClass(tree, 'dvv-input');
change(homeInput2, CACHE_DOC.url);
tree = await settle();
homeInput2 = byClass(tree, 'dvv-input');
keydown(homeInput2, 'Enter');
const analyzeSummaryBefore = callsOf('analyze').filter((call) => call.body && call.body.mode === 'summary').length;
tree = await settle();
checkIncludes('缓存总结直接回填', nodeText(tree), '缓存结论');
checkIncludes('缓存标记显示', nodeText(tree), '已缓存');
check('缓存命中不重复生成总结', callsOf('analyze').filter((call) => call.body && call.body.mode === 'summary').length === analyzeSummaryBefore);
const chaptersBefore = callsOf('chapters').length;
clickText(tree, '章节');
tree = await settle();
checkIncludes('缓存章节回填', nodeText(tree), '缓存章节一');
check('缓存章节不重复请求', callsOf('chapters').length === chaptersBefore);
clickText(tree, '思维导图');
tree = await settle();
checkIncludes('缓存导图回填', nodeText(tree), '缓存分支');
checkIncludes('缓存对话回填', nodeText(tree), '缓存回答在这里');
check('缓存对话带依据 chip', allByClass(tree, 'dvv-cite').length >= 1);

/* ---------------------------------------------------------------- 无字幕 */

let input3 = byClass(tree, 'dvv-input');
change(input3, NOCAP_DOC.url);
tree = await settle();
input3 = byClass(tree, 'dvv-input');
keydown(input3, 'Enter');
tree = await settle();
checkIncludes('无字幕显示告警条', nodeText(tree), '这个视频没有可用的字幕');
checkIncludes('告警条说明 B 站需要 Cookie', nodeText(tree), 'B 站 AI 字幕需要登录 Cookie');
clickText(tree, '原文');
tree = await settle();
checkIncludes('原文页解释没拿到字幕', nodeText(tree), '这个视频没拿到字幕');
check('无转写稿时不渲染双语开关', !buttonByText(tree, '双语'));

/* ---------------------------------------------------------------- 自动转写 */

ASR.enabled = true;
ASR.config.autoTranscribe = true;
let input4 = byClass(tree, 'dvv-input');
change(input4, AUTO_DOC.url);
tree = await settle();
input4 = byClass(tree, 'dvv-input');
keydown(input4, 'Enter');
tree = await settle(60);
check('无字幕且开启自动转写时自动 POST /transcribe', callsOf('transcribe').length >= 1);
checkIncludes('转写后原文页出现字幕', nodeText(tree), '本地转写第一句');
checkIncludes('转写来源徽标', nodeText(tree), '本地 Whisper');
clickText(tree, '总结');
tree = await settle();
const mdCopyBtn = buttonByText(tree, '复制 Markdown');
const mdDownloadBtn = buttonByText(tree, '下载 .md');
check('总结为空时「复制 Markdown」禁用', Boolean(mdCopyBtn) && mdCopyBtn.props.disabled === true);
check('总结为空时「下载 .md」禁用', Boolean(mdDownloadBtn) && mdDownloadBtn.props.disabled === true);

/* ---------------------------------------------------------------- 错误与返回 */

let input5 = byClass(tree, 'dvv-input');
change(input5, 'https://example.com/bad-url');
tree = await settle();
input5 = byClass(tree, 'dvv-input');
keydown(input5, 'Enter');
tree = await settle();
checkIncludes('错误显示中文横幅', nodeText(tree), '没认出这个链接');

// 返回按钮：先回插件首页，再回上层
tree = await settle();
const backBtn = buttonByText(tree, '返回');
click(backBtn);
tree = await settle();
check('返回按钮回到插件首页', Boolean(byClass(tree, 'dvv-home')));
const backBtn2 = buttonByText(tree, '返回');
check('首页仍有返回按钮', Boolean(backBtn2));
click(backBtn2);
check('首页点返回调用 layout.selectPanel(null)', layoutCalls.includes(null));

check('渲染期间没有运行时异常', runtimeErrors.length === 0);
if (runtimeErrors.length) console.log(`运行时异常：\n${runtimeErrors.slice(0, 3).join('\n')}`);

/* ---------------------------------------------------------------- 报告 */

console.log('');
if (failures.length) {
  console.log(`pass ${pass}/${pass + failures.length}（通过 ${pass}，失败 ${failures.length} 项）：`);
  for (const item of failures) console.log(`  ✗ ${item}`);
  process.exit(1);
}
console.log(`pass ${pass}/${pass}（${pass} 项全部通过）`);
process.exit(0);
