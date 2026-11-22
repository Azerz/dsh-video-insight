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
  // 只截获后台任务轮询（2000/10000ms）的定时器，其余保持真实计时（供既有慢速用例）。
  const jobTimers = [];
  const realSetTimeout = setTimeout;
  sandbox.setTimeout = (fn, ms, ...args) => {
    if (ms === 2000 || ms === 10000) {
      const entry = { fn, ms, args };
      jobTimers.push(entry);
      return entry;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  sandbox.clearTimeout = (id) => {
    const index = jobTimers.indexOf(id);
    if (index >= 0) { jobTimers.splice(index, 1); return; }
    clearTimeout(id);
  };
  sandbox.__jobTimers = jobTimers;
  sandbox.__jobsTick = async () => {
    const entry = jobTimers.find((item) => item.ms === 2000 || item.ms === 10000);
    if (!entry) return false;
    jobTimers.splice(jobTimers.indexOf(entry), 1);
    try { entry.fn(); } catch { /* ignore */ }
    return true;
  };
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

function slowSseResponse(events, signal, holdMs = 260) {
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
      } catch { /* ignore */ }
      setTimeout(() => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', downloaded: true })}\n\n`));
          controller.close();
        } catch { /* ignore */ }
      }, holdMs);
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
      if (result && typeof result.then === 'function') {
        return result.then((resolved) => {
          if (resolved && resolved.__sse) return sseResponse(resolved.__sse, call.signal);
          if (resolved && resolved.__sseSlow) return slowSseResponse(resolved.__sseSlow, call.signal);
          return jsonResponse(resolved);
        });
      }
      if (result && result.__sse) return Promise.resolve(sseResponse(result.__sse, call.signal));
      if (result && result.__sseSlow) return Promise.resolve(slowSseResponse(result.__sseSlow, call.signal));
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
    frameMode: 'auto', visionModel: '', visionMaxFrames: 48, crossCheck: true,
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

const ASR_MODELS = {
  models: {
    whisper: {
      id: 'whisper', label: 'Whisper large-v3-turbo（q5_0，约 574 MB）', available: false,
      files: [{ key: 'whisperModelPath', path: '/Users/test/.dsh/video-models/ggml-large-v3-turbo-q5_0.bin', expectedBytes: 574041195, actualBytes: 0, exists: false }],
    },
    sensevoice: {
      id: 'sensevoice', label: 'SenseVoice small（int8，约 240 MB）', available: false,
      files: [
        { key: 'sensevoiceModelPath', path: '/Users/test/.dsh/video-models/sensevoice/model.int8.onnx', expectedBytes: 239233841, actualBytes: 0, exists: false },
        { key: 'sensevoiceTokensPath', path: '/Users/test/.dsh/video-models/sensevoice/tokens.txt', expectedBytes: 315894, actualBytes: 0, exists: false },
      ],
    },
  },
  catalog: [],
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
      { title: '开场', t: 0, children: [{ title: '信息密度', t: 33 }, { title: '注意力经济' }] },
      { title: '核心论点', t: 62, children: [{ title: '时间成本' }, { title: '创造力' }] },
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

const OUTLINE_VALUE = {
  docId: 'bilibili:BV1xx411c7mD',
  duration: BILI_DOC.duration,
  source: 'mindmap',
  signature: 'sig-1',
  visuals: null,
  items: [
    { seconds: 0, title: '开场', detail: ['开场先讲今天要解决的问题。'], description: '' },
    { seconds: 62, title: '核心论点', detail: ['注意力经济让内容碎片化。'], description: '' },
  ],
};
let outlineMode = 'ok';
/** 后台解析队列的假状态（测试里直接改写再 tick）。 */
let jobsState = { concurrency: 2, active: 0, running: 0, jobs: [] };
let jobsCancelCalls = [];
let jobsAllCalls = [];
let jobsClearCalls = [];
/** task-25：POST /jobs 行为（'ok' 建任务 / 'fail' 模拟老 host 让客户端回退内联）与调用记录。 */
let jobsCreateMode = 'fail';
let jobsCreateCalls = [];
/** GET /analysis 的假数据（task-25 完成后回填）。 */
let analysisMode = 'notfound';
let analysisValue = null;
let storyboardMode = 'single';

const OUTLINE_HINT_VALUE = {
  docId: 'bilibili:BV1xx411c7mD',
  duration: BILI_DOC.duration,
  source: 'uniform',
  signature: 'sig-hint',
  visuals: null,
  hint: '这段视频还没有章节标题：生成思维导图（或 AI 章节）后会自动按内容切分。',
  items: [
    { seconds: 0, title: '片段 1', detail: [], description: '' },
    { seconds: 251, title: '片段 2', detail: [], description: '' },
    { seconds: 502, title: '片段 3', detail: [], description: '' },
  ],
};

const OUTLINE_VISUALS_EVENTS = [
  { type: 'phase', text: '正在准备视频…' },
  { type: 'progress', stage: 'frames', percent: 40 },
  { type: 'progress', stage: 'describe', percent: null },
  {
    type: 'done',
    cached: false,
    items: [
      { seconds: 0, title: '开场', detail: ['开场先讲今天要解决的问题。'], description: '白色地面上，一只脚走过。' },
      { seconds: 62, title: '核心论点', detail: ['注意力经济让内容碎片化。'], description: '主持人站在黑板前写公式。' },
    ],
    usage: {},
  },
];

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

const KEYFRAME_ITEMS = [
  { seconds: 0, label: '开场：什么是第一性原理' },
  { seconds: 22, label: '问题拆解' },
  { seconds: 62, label: '拆到最本质的问题' },
  { seconds: 124, label: '信息密度与注意力' },
  { seconds: 188, label: '时间成本' },
  { seconds: 250, label: '为什么需要 AI 编程' },
  { seconds: 330, label: '错误与调试' },
  { seconds: 510, label: '创作力的边界' },
];
let keyframesMode = 'ok';

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

const SB_MULTI_VALUE = {
  docId: 'youtube:seekYT',
  url: YT_DOC.url,
  title: YT_DOC.title,
  platform: 'youtube',
  duration: 1203,
  generatedAt: now - 20e3,
  tookMs: 2400,
  frameSampling: 'cuts',
  cuts: 150,
  frames: 6,
  cols: 3,
  rows: 2,
  cellWidth: 640,
  cellHeight: 360,
  described: true,
  budget: {
    frames: 48, secondsPerFrame: 20, sheets: 2, cellsPerSheet: 24,
    density: 'normal', duration: 1203, ceiling: 48,
    reason: '1203s · 150 个镜头 · 每 20s 一帧 · 常规节奏 · 48 帧 / 2 张图',
  },
  sheets: [
    { index: 0, cols: 3, rows: 2, cellWidth: 640, cellHeight: 360, cells: [] },
    { index: 1, cols: 3, rows: 2, cellWidth: 640, cellHeight: 360, cells: [] },
  ],
  cells: [
    { index: 0, sheet: 0, row: 0, col: 0, seconds: 0 },
    { index: 1, sheet: 0, row: 0, col: 1, seconds: 20 },
    { index: 2, sheet: 0, row: 0, col: 2, seconds: 40 },
    { index: 3, sheet: 0, row: 1, col: 0, seconds: 60 },
    { index: 4, sheet: 1, row: 0, col: 0, seconds: 500, description: '第二张第一格' },
    { index: 5, sheet: 1, row: 1, col: 2, seconds: 700 },
  ],
};

const SB_MULTI_EVENTS = [
  { type: 'phase', text: '正在扫描镜头…' },
  { type: 'done', cached: false, docId: 'youtube:seekYT', storyboard: SB_MULTI_VALUE },
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

const INSTALL_PLAN = {
  platform: 'darwin',
  plan: [
    { id: 'ffmpeg', label: 'ffmpeg', method: 'download', bytes: 19000000, platform: 'darwin-arm64', hint: '', installed: true, detectedPath: '/opt/homebrew/bin/ffmpeg' },
    { id: 'ytdlp', label: 'yt-dlp', method: 'download', bytes: 37000000, platform: 'darwin-arm64', hint: '', installed: false, detectedPath: '' },
    { id: 'whisper', label: 'whisper-cli', method: 'brew', bytes: 0, platform: 'darwin-arm64', hint: 'macOS/Linux 上推荐 brew install whisper.cpp', installed: false, detectedPath: '' },
    { id: 'sherpa', label: 'sherpa-onnx', method: 'download', bytes: 246000000, platform: 'darwin-arm64', hint: '', installed: true, detectedPath: '/Users/test/.dsh/video-tools/sherpa-onnx/bin/sherpa-onnx-offline' },
  ],
};
const STORAGE_FIXTURE = [
  ['assets', 168 * 1024 * 1024, 12],
  ['storyboards', 17 * 1024 * 1024, 68],
  ['transcripts', 228 * 1024, 12],
  ['analyses', 468 * 1024, 41],
  ['outlines', 60 * 1024, 9],
  ['translations', 12 * 1024, 1],
];
function storageValue(clearedKind) {
  const cleared = (id) => clearedKind === 'all' || clearedKind === id;
  const kinds = STORAGE_FIXTURE.map(([id, bytes, files]) => ({
    id, dir: `/tmp/${id}`, keepDays: 90, keepCount: 0,
    bytes: cleared(id) ? 0 : bytes, files: cleared(id) ? 0 : files, newestAt: 0, oldestAt: 0,
  }));
  return {
    kinds,
    readonly: [
      { id: 'models', dir: '/tmp/models', bytes: 776 * 1024 * 1024, files: 3, newestAt: 0, oldestAt: 0 },
      { id: 'tools', dir: '/tmp/tools', bytes: 853 * 1024 * 1024, files: 46, newestAt: 0, oldestAt: 0 },
    ],
    totalBytes: kinds.reduce((sum, item) => sum + item.bytes, 0),
    totalFiles: kinds.reduce((sum, item) => sum + item.files, 0),
    lastPrunedAt: 0,
    policy: { pruneIntervalHours: 6 },
  };
}
let storageCleared = '';
let installPlanValue = null;
let installMode = 'ok';

let bookmarkItems = [
  { id: 'bm-1', start: 8, end: 12, text: '第一性原理是拆到最本质的问题', createdAt: now - 60e3 },
  { id: 'bm-2', start: 62, end: 70, text: '注意力经济让内容变得碎片化', label: '重点', createdAt: now - 30e3 },
];

let historyItems = [
  {
    docId: 'bilibili:BV1xx411c7mD', url: BILI_DOC.url, platform: 'bilibili', id: 'BV1xx411c7mD',
    title: BILI_DOC.title, author: '硬核拆解', duration: 754, cover: BILI_DOC.cover,
    hasTranscript: true, hasSummary: true, hasChapters: true, hasMindmap: true, chatCount: 3,
    favorite: false, analyzedAt: now - 120e3, action: 'analyze',
  },
  {
    docId: 'youtube:hist1', url: 'https://www.youtube.com/watch?v=hist1', platform: 'youtube', id: 'hist1',
    title: '历史上的 YouTube 视频', author: 'Someone', duration: 213, cover: '',
    hasTranscript: false, hasSummary: false, hasChapters: false, hasMindmap: false, chatCount: 0,
    favorite: false, analyzedAt: now - 3 * 3600e3, action: 'view',
  },
];

let asrStatusOverride = null;
let asrModelsValue = null;
let modelDownloadMode = 'ok';

function resetRoutes() {
  translateCache = null;
  routes = {
    status: () => ({ ok: true, value: STATUS }),
    history: () => ({ ok: true, value: { items: historyItems } }),
    'history/remove': (call) => {
      historyItems = historyItems.filter((item) => item.docId !== (call.body && call.body.docId));
      return { ok: true, value: { items: historyItems } };
    },
    'history/favorite': (call) => {
      const body = call.body || {};
      historyItems = historyItems.map((item) => (
        item.docId === body.docId ? { ...item, favorite: Boolean(body.favorite) } : item
      ));
      return { ok: true, value: { items: historyItems } };
    },
    'history/clear': () => {
      historyItems = [];
      return { ok: true, value: { items: [] } };
    },
    'asr/status': () => ({ ok: true, value: asrStatusOverride || ASR }),
    'asr/models': (call) => {
      if (call.method === 'GET') return { ok: true, value: asrModelsValue || ASR_MODELS };
      if (modelDownloadMode === 'slow') return { __sseSlow: [{ type: 'phase', text: '正在下载模型…' }, { type: 'progress', stage: 'download', percent: null, received: 1024, total: 0 }] };
      if (modelDownloadMode === 'error') return { __sse: [{ type: 'phase', text: '正在下载模型…' }, { type: 'error', code: 'http-error', message: 'HTTP 404' }] };
      return { __sse: [{ type: 'phase', text: '正在下载模型…' }, { type: 'progress', stage: 'download', percent: 42, received: 1024, total: 2048 }, { type: 'done', downloaded: true }] };
    },
    'asr/config': (call) => {
      const body = call.body || {};
      for (const key of ['enabled', 'engine']) if (key in body) ASR[key] = body[key];
      if ('whisperBackend' in body) {
        ASR.config.whisperBackend = body.whisperBackend;
        if (asrStatusOverride && asrStatusOverride.config) asrStatusOverride.config.whisperBackend = body.whisperBackend;
      }
      for (const key of ['threads', 'maxSeconds', 'keepAudio', 'autoTranscribe', 'crossCheck', 'ocrFallback', 'ocrIntervalSeconds', 'ocrMaxFrames', 'frameMode', 'visionModel', 'visionMaxFrames', 'ffmpegPath', 'ytdlpPath', 'whisperBinaryPath', 'sherpaBinaryPath', 'whisperModelPath', 'sensevoiceModelPath', 'sensevoiceTokensPath']) {
        if (key in body) ASR.config[key] = body[key];
      }
      if (ASR.vision && ASR.vision.config) {
        for (const key of ['frameMode', 'visionModel', 'visionMaxFrames']) if (key in body) ASR.vision.config[key] = body[key];
      }
      return { ok: true, value: asrStatusOverride || ASR };
    },
    'asr/config/_:unused': () => ({ ok: true, value: ASR }),
    'install/plan': () => ({ ok: true, value: installPlanValue || INSTALL_PLAN }),
    storage: () => ({ ok: true, value: storageValue(storageCleared) }),
    'storage/clear': (call) => {
      storageCleared = String((call.body || {}).kind || 'all');
      return { ok: true, value: { removed: 68, freedBytes: 17 * 1024 * 1024, status: storageValue(storageCleared) } };
    },
    'storage/prune': () => ({ ok: true, value: { skipped: false, removed: 3, freedBytes: 4096, status: storageValue(storageCleared) } }),
    install: (call) => {
      if (installMode === 'slow') {
        return { __sseSlow: [{ type: 'phase', text: '正在下载 yt-dlp…' }, { type: 'progress', stage: 'download', component: 'ytdlp', percent: null, received: 1024, total: 0 }] };
      }
      if (installMode === 'error') {
        return { __sse: [{ type: 'phase', text: '正在下载 yt-dlp…' }, { type: 'error', code: 'install-download-failed', message: '镜像不可用' }] };
      }
      return { __sse: [
        { type: 'phase', text: '正在下载 yt-dlp…' },
        { type: 'progress', stage: 'download', component: 'ytdlp', percent: 42, received: 1024, total: 4096 },
        { type: 'installed', component: 'yt-dlp', path: '/Users/test/.dsh/video-tools/bin/yt-dlp' },
        { type: 'progress', stage: 'extract', component: 'ytdlp', percent: 100, received: 4096, total: 4096 },
        { type: 'done', installed: ['yt-dlp'], status: 'ok' },
      ] };
    },
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
    outline: () => {
      if (outlineMode === 'notfound') return { ok: false, code: 'not-found', error: '这个视频还没有解析分镜。' };
      if (outlineMode === 'hint' || outlineMode === 'hint-fail' || outlineMode === 'hint-slow') return { ok: true, value: OUTLINE_HINT_VALUE };
      return { ok: true, value: OUTLINE_VALUE };
    },
    'outline/visuals': () => ({ __sse: OUTLINE_VISUALS_EVENTS }),
    mindmap: () => {
      if (outlineMode === 'hint-fail') return { ok: false, code: 'llm-failed', error: '模型调用失败' };
      if (outlineMode === 'hint-slow') {
        return new Promise((resolve) => {
          setTimeout(() => { outlineMode = 'ok'; resolve({ ok: true, value: MINDMAP_VALUE }); }, 120);
        });
      }
      if (outlineMode === 'hint') outlineMode = 'ok';
      return { ok: true, value: MINDMAP_VALUE };
    },
    analyze: (call) => ({ __sse: call.body && call.body.mode === 'ask' ? ASK_EVENTS : SUMMARY_EVENTS }),
    transcribe: () => ({ __sse: TRANSCRIBE_EVENTS }),
    translate: (call) => {
      if (call.method === 'GET') return { ok: true, value: translateCache };
      const lang = String((call.body && call.body.lang) || 'en');
      return { __sse: translateEvents(lang) };
    },
    storyboard: (call) => {
      if (call.method === 'GET') return { ok: true, value: null };
      return { __sse: storyboardMode === 'multi' ? SB_MULTI_EVENTS : STORYBOARD_EVENTS };
    },
    'storyboard/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    keyframes: (call) => {
      const docId = String((call.params && call.params.docId) || '');
      if (keyframesMode === 'notfound') return { ok: false, code: 'not-found', error: '这个视频还没有解析分镜。' };
      if (keyframesMode === 'empty') return { ok: true, value: { docId, duration: 754, items: [] } };
      return { ok: true, value: { docId, duration: 754, items: KEYFRAME_ITEMS } };
    },
    bookmarks: (call) => {
      const docId = String((call.params && call.params.docId) || '');
      if (docId.startsWith('youtube:')) {
        return { ok: true, value: { docId, url: '', title: '', updatedAt: now, items: [] } };
      }
      return {
        ok: true,
        value: { docId, url: BILI_DOC.url, title: BILI_DOC.title, updatedAt: now, items: bookmarkItems },
      };
    },
    'bookmarks/add': (call) => {
      const body = call.body || {};
      const start = Number(body.start);
      const duplicate = bookmarkItems.find((item) => Math.abs(Number(item.start) - start) <= 1.5);
      if (duplicate) return { ok: true, value: { item: duplicate, duplicate: true, count: bookmarkItems.length } };
      const item = {
        id: `bm-${bookmarkItems.length + 1}`,
        start, end: Number(body.end),
        text: String(body.text || ''), label: body.label || undefined,
        createdAt: now,
      };
      bookmarkItems.push(item);
      return { ok: true, value: { item, duplicate: false, count: bookmarkItems.length } };
    },
    'bookmarks/remove': (call) => {
      const id = String((call.body && call.body.id) || '');
      bookmarkItems = bookmarkItems.filter((item) => item.id !== id);
      return { ok: true, value: { docId: call.body && call.body.docId, items: bookmarkItems } };
    },
    'bookmarks/clear': (call) => {
      bookmarkItems = [];
      return { ok: true, value: { docId: call.body && call.body.docId, items: [] } };
    },
    'analysis/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    'analysis/chat/clear': (call) => ({ ok: true, value: { docId: call.body && call.body.docId } }),
    'analysis': (call) => {
      if (analysisMode === 'ok') return { ok: true, value: { docId: call.params.docId, doc: null, analysis: analysisValue } };
      return { ok: false, code: 'not-found', error: '没有缓存' };
    },
    jobs: (call) => {
      if (call.method === 'POST') {
        const body = call.body || {};
        jobsCreateCalls.push(body);
        if (jobsCreateMode === 'fail') return { ok: false, code: 'internal', error: '当前主机不支持后台任务' };
        const docId = String(body.docId || '');
        const existing = jobsState.jobs.find((job) => job.docId === docId && ['queued', 'running'].includes(job.status));
        if (existing) return { ok: true, value: { job: existing, created: false } };
        const job = {
          id: `job-${jobsState.jobs.length + 1}`, docId, url: '', title: '',
          status: 'running', stage: 'summary', stageLabel: '正在写总结…', percent: 42,
          error: '', warnings: [], updatedAt: now,
        };
        jobsState = {
          concurrency: 0,
          active: Number(jobsState.active || 0) + 1,
          running: Number(jobsState.running || 0) + 1,
          jobs: [job, ...jobsState.jobs],
        };
        return { ok: true, value: { job, created: true } };
      }
      return { ok: true, value: jobsState };
    },
    'jobs/cancel': (call) => {
      const docId = String((call.body && call.body.docId) || '');
      jobsCancelCalls.push(docId);
      jobsState = {
        ...jobsState,
        active: Math.max(0, Number(jobsState.active) - 1),
        jobs: jobsState.jobs.map((job) => (
          job.docId === docId ? { ...job, status: 'cancelled', stageLabel: '已取消', updatedAt: Date.now() } : job
        )),
      };
      return { ok: true, value: { cancelled: docId ? 1 : 0, jobs: jobsState.jobs } };
    },
    'jobs/all': (call) => {
      jobsAllCalls.push(call.body || {});
      return { ok: true, value: { started: 2, skipped: 3, jobs: jobsState.jobs } };
    },
    'jobs/clear': (call) => {
      jobsClearCalls.push(call.body || {});
      jobsState = { ...jobsState, jobs: jobsState.jobs.filter((job) => ['queued', 'running'].includes(job.status)) };
      return { ok: true, value: { cleared: 1, jobs: jobsState.jobs } };
    },
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
checkIncludes('首页副标题', nodeText(tree), '粘贴一条链接，30 秒看清一个视频值不值得看。');
check('首页有解析输入框', Boolean(byClass(tree, 'dvv-home-input')));
checkIncludes('输入框带示例占位', String((byClass(tree, 'dvv-home-input') || {}).props?.placeholder || ''), 'youtube.com');
check('首页有「解析」按钮', Boolean(buttonByText(tree, '解析')));
checkIncludes('未配置 Cookie 有 B 站提示', nodeText(tree), 'B 站 AI 字幕需要登录 Cookie');
checkIncludes('首页历史列表', nodeText(tree), '最近分析');
checkIncludes('首页历史条目标题', nodeText(tree), '用第一性原理理解 AI 编程');

// 首页「最近分析」星标（task-19）
let homeStars = allByClass(tree, 'dvv-fav');
check('首页最近分析有星标按钮', homeStars.length === 2);
check('首页星标默认空心', homeStars[0] && nodeText(homeStars[0]) === '☆');
click(homeStars[0]);
tree = await settle();
check('首页点星标 POST 收藏参数', callsOf('history/favorite').some((call) => call.body
  && call.body.docId === 'bilibili:BV1xx411c7mD' && call.body.favorite === true));
checkIncludes('首页收藏成功 toast', nodeText(tree), '已收藏');
homeStars = allByClass(tree, 'dvv-fav');
check('首页星标变实心', homeStars[0] && homeStars[0].props['data-on'] === 'true' && nodeText(homeStars[0]) === '★');
checkIncludes('首页最近分析显示上限提示', nodeText(tree), '最多保留 100 条');
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
const tabbarText = nodeText(byClass(tree, 'dvv-tabbar'));
checkIncludes('页签包含分镜', tabbarText, '分镜');
checkIncludes('页签包含思维导图', tabbarText, '思维导图');
check('页签不再包含片段与关键画面', !tabbarText.includes('片段') && !tabbarText.includes('关键画面'));
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

/* ---------------------------------------------------------------- 章节页（outline 驱动） */

clickText(tree, '章节');
tree = await settle(40);
const outlineCall = callsOf('outline').slice(-1)[0];
check('切到章节 GET /outline', Boolean(outlineCall) && outlineCall.method === 'GET'
  && outlineCall.params.docId === 'bilibili:BV1xx411c7mD');
checkIncludes('章节来源徽标', nodeText(tree), '按思维导图切分');
check('章节列表渲染两行', allByClass(tree, 'dvv-ch').length === 2);
checkIncludes('章节列表标题', nodeText(tree), '开场');
checkIncludes('章节列表时间戳', nodeText(tree), '[0:00]');
checkIncludes('章节显示 gist', nodeText(tree), '开场先讲今天要解决的问题。');

// 缩略图：/thumb w=160 + 懒加载 + 失败隐藏
const chThumbs = allByClass(tree, 'dvv-ch-thumb-img');
check('章节缩略图渲染两张', chThumbs.length === 2);
check('章节缩略图指向 /thumb w=160', Boolean(chThumbs[0])
  && String(chThumbs[0].props.src).includes('/dsh-video/api/thumb?docId=bilibili%3ABV1xx411c7mD&seconds=0&w=160'));
check('章节缩略图支持懒加载', Boolean(chThumbs[0]) && chThumbs[0].props.loading === 'lazy' && chThumbs[0].props.decoding === 'async');
if (chThumbs[0] && typeof chThumbs[0].props.onError === 'function') chThumbs[0].props.onError({});
tree = await settle();
check('章节缩略图失败后隐藏', allByClass(tree, 'dvv-ch-thumb-img').length === 1);
check('缩略图失败保留占位底色', allByClass(tree, 'dvv-ch-thumb').length === 2);

// 点击章节行 → seek
click(allByClass(tree, 'dvv-ch')[1]);
tree = await settle();
let chFrame = allByTag(tree, 'iframe')[0];
check('点击章节发送 seek 到外壳', Boolean(chFrame)
  && chFrame.contentWindow.messages.some((msg) => msg && msg.type === 'dsh-video:seek' && msg.seconds === 62));

// 当前章节高亮：跟随 dsh-video:time
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 30 } });
tree = await settle();
let chCurrent = allByClass(tree, 'dvv-ch').filter((node) => node.props['data-current'] === 'true');
check('章节高亮跟随播放（30s → 开场）', chCurrent.length === 1 && nodeText(chCurrent[0]).includes('开场'));
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 70 } });
tree = await settle();
chCurrent = allByClass(tree, 'dvv-ch').filter((node) => node.props['data-current'] === 'true');
check('章节高亮随播放切换（70s → 核心论点）', chCurrent.length === 1 && nodeText(chCurrent[0]).includes('核心论点'));
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 0 } });
tree = await settle();
check('seconds=0 时章节不高亮', allByClass(tree, 'dvv-ch').filter((node) => node.props['data-current'] === 'true').length === 0);
sandbox.dispatchEvent({ type: 'message', data: { type: 'dsh-video:time', seconds: 9999 } });
tree = await settle();
chCurrent = allByClass(tree, 'dvv-ch').filter((node) => node.props['data-current'] === 'true');
check('超出末章 start 时高亮最后一章', chCurrent.length === 1 && nodeText(chCurrent[0]).includes('核心论点'));

// 生成画面描述（POST /outline/visuals SSE）
const visualsBefore = callsOf('outline/visuals').length;
clickText(tree, '生成画面描述');
tree = await settle(80);
const visualsCall = callsOf('outline/visuals').slice(-1)[0];
check('生成描述 POST /outline/visuals', callsOf('outline/visuals').length > visualsBefore
  && Boolean(visualsCall) && visualsCall.body.docId === 'bilibili:BV1xx411c7mD');
checkIncludes('生成后显示画面描述', nodeText(tree), '白色地面上，一只脚走过。');
checkIncludes('生成后显示缓存标记', nodeText(tree), '已缓存');

// 列表 / 网格切换：共用同一份数据与 SSE 结果
const gridBtn = allByClass(tree, 'dvv-btn').find((node) => nodeText(node) === '网格');
check('章节页有列表/网格切换', Boolean(gridBtn));
const outlineCallsBefore = callsOf('outline').length;
click(gridBtn);
tree = await settle();
check('网格视图渲染两张卡片', allByClass(tree, 'dvv-kf-card').length === 2);
check('网格卡片时间徽标', allByClass(tree, 'dvv-kf-time').some((node) => nodeText(node) === '1:02'));
checkIncludes('网格卡片显示描述', nodeText(tree), '主持人站在黑板前写公式。');
check('两视图共用数据不重复请求', callsOf('outline').length === outlineCallsBefore);
const kfCard = allByClass(tree, 'dvv-kf-card').find((node) => nodeText(node).includes('1:02'));
check('网格卡片缩略图 w=320', Boolean(kfCard)
  && allByClass(kfCard, 'dvv-kf-img').some((node) => String(node.props.src).includes('seconds=62&w=320')));
check('点击网格卡片发送 seek', Boolean(kfCard) && click(kfCard));
tree = await settle();
chFrame = allByTag(tree, 'iframe')[0];
check('网格卡片 seek(62)', Boolean(chFrame) && chFrame.contentWindow.messages.some((msg) => msg && msg.seconds === 62));
const listBtn = allByClass(tree, 'dvv-btn').find((node) => nodeText(node) === '列表');
click(listBtn);
tree = await settle();
check('切回列表视图', allByClass(tree, 'dvv-ch').length === 2 && allByClass(tree, 'dvv-kf-card').length === 0);

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

// 导图节点时间徽标（task-16）
const mmBadges = allByClass(tree, 'dvv-mm-t');
check('导图渲染带 t 的节点时间徽标', mmBadges.length === 3);
checkIncludes('导图时间徽标文本 0:33', JSON.stringify(mmBadges.map(nodeText)), '0:33');
const mmBadge33 = mmBadges.find((node) => nodeText(node) === '0:33');
check('点击 0:33 时间徽标跳到 33 秒', Boolean(mmBadge33) && click(mmBadge33));
tree = await settle();
check('导图时间徽标发送 seek(33)', allByTag(tree, 'iframe')[0].contentWindow.messages.some((msg) => msg && msg.type === 'dsh-video:seek' && msg.seconds === 33));
const mmBadge0 = allByClass(tree, 'dvv-mm-t').find((node) => nodeText(node) === '0:00');
check('点击父节点时间徽标不折叠', Boolean(mmBadge0) && click(mmBadge0));
tree = await settle();
checkIncludes('点击父节点徽标后子节点仍展开', nodeText(tree), '信息密度');
const mmNoTimeCard = findOne(tree, (node) => hasClass(node, 'dvv-mm2-node') && nodeText(node).includes('注意力经济'));
check('无 t 的节点不渲染时间徽标', Boolean(mmNoTimeCard) && allByClass(mmNoTimeCard, 'dvv-mm-t').length === 0);

/* ---------------------------------------------------------------- 分镜页 */

clickText(tree, '分镜');
tree = await settle();
check('切到分镜先读缓存 GET /storyboard', callsOf('storyboard').some((call) => call.method === 'GET'));
check('没有缓存时自动 POST 生成分镜', callsOf('storyboard').some((call) => call.method === 'POST'));
checkIncludes('分镜工具条帧数', nodeText(tree), '4 帧 · 1 张');
checkIncludes('分镜单张说明', nodeText(tree), '第 1/1 张 · 2×2 格');
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
check('设置里有 5 个复选框', checkboxes.length === 5);
const enabledLabel = findOne(settingsModal, (node) => node.__host === 'element' && node.tag === 'label'
  && (nodeText(node).includes('已开启') || nodeText(node).includes('已关闭')));
const enabledBox = enabledLabel ? allByTag(enabledLabel, 'input')[0] : null;
enabledBox && enabledBox.props.onChange && enabledBox.props.onChange({ target: { checked: true } });
tree = await settle();
check('开启转写 POST enabled=true', callsOf('asr/config').some((call) => call.body && call.body.enabled === true));
enabledBox && enabledBox.props.onChange && enabledBox.props.onChange({ target: { checked: false } });
tree = await settle();

/* 语音与画面并行分析（crossCheck，默认开） */
function crossCheckLabel() {
  return findOne(tree, (node) => node.__host === 'element' && node.tag === 'label'
    && nodeText(node).includes('语音与画面并行分析'));
}
const crossLabel = crossCheckLabel();
check('并行分析复选框存在', Boolean(crossLabel));
checkIncludes('并行分析说明文字', nodeText(tree), '两路结果互相印证');
const crossBox = crossLabel ? allByTag(crossLabel, 'input')[0] : null;
check('并行分析默认勾选', Boolean(crossBox && crossBox.props.checked === true));
crossBox && crossBox.props.onChange && crossBox.props.onChange({ target: { checked: false } });
tree = await settle();
check('取消并行分析 POST crossCheck=false', callsOf('asr/config').some((call) => call.body && call.body.crossCheck === false));
const crossCall = callsOf('asr/config').filter((call) => call.body && 'crossCheck' in call.body).pop();
check('crossCheck 只提交该字段', Boolean(crossCall && Object.keys(crossCall.body).length === 1));
const crossLabel2 = crossCheckLabel();
const crossBox2 = crossLabel2 ? allByTag(crossLabel2, 'input')[0] : null;
check('并行分析回显为未勾选', Boolean(crossBox2 && crossBox2.props.checked === false));
crossBox2 && crossBox2.props.onChange && crossBox2.props.onChange({ target: { checked: true } });
tree = await settle();
check('重新勾选 POST crossCheck=true', callsOf('asr/config').some((call) => call.body && call.body.crossCheck === true));
const crossLabel3 = crossCheckLabel();
const crossBox3 = crossLabel3 ? allByTag(crossLabel3, 'input')[0] : null;
check('并行分析回显为已勾选', Boolean(crossBox3 && crossBox3.props.checked === true));

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
checkIncludes('历史抽屉显示上限 100', nodeText(tree), '最多保留 100 条');

// 搜索框：标题 / 作者 / 无匹配（task-19）
let histSearch = inputByLabel(tree, '搜索历史记录');
check('历史抽屉有搜索框', Boolean(histSearch));
change(histSearch, 'youtube');
tree = await settle();
checkIncludes('搜索按标题过滤', nodeText(tree), '历史上的 YouTube 视频');
checkIncludes('搜索后条数为 1 / 2', nodeText(tree), '1 / 2');
change(inputByLabel(tree, '搜索历史记录'), '硬核拆解');
tree = await settle();
check('按作者搜索只剩 1 条', allByClass(tree, 'dvv-hist').length === 1);
change(inputByLabel(tree, '搜索历史记录'), 'zzz-no-match');
tree = await settle();
checkIncludes('无匹配历史提示', nodeText(tree), '没有匹配的历史记录');

// 清空搜索后切「已收藏」（BILI 已在首页被收藏）
change(inputByLabel(tree, '搜索历史记录'), '');
tree = await settle();
clickText(tree, '已收藏');
tree = await settle();
check('已收藏筛选只剩 1 条', allByClass(tree, 'dvv-hist').length === 1);
checkIncludes('已收藏筛选条数', nodeText(tree), '1 / 2');
clickText(tree, '全部');
tree = await settle();
check('全部筛选恢复 2 条', allByClass(tree, 'dvv-hist').length === 2);

// 抽屉星标切换：取消收藏 → 再收藏
const drawerStar = allByClass(tree, 'dvv-fav')[0];
check('历史行有星标按钮', Boolean(drawerStar) && nodeText(drawerStar) === '★');
click(drawerStar);
tree = await settle();
check('取消收藏 POST favorite=false', callsOf('history/favorite').some((call) => call.body
  && call.body.docId === 'bilibili:BV1xx411c7mD' && call.body.favorite === false));
checkIncludes('取消收藏 toast', nodeText(tree), '已取消收藏');
const drawerStar2 = allByClass(tree, 'dvv-fav')[0];
check('星标变回空心', drawerStar2 && drawerStar2.props['data-on'] === 'false' && nodeText(drawerStar2) === '☆');
click(drawerStar2);
tree = await settle();
check('再次收藏 POST favorite=true', callsOf('history/favorite').filter((call) => call.body
  && call.body.favorite === true).length >= 2);

// 搜索/筛选状态在关闭后保留
change(inputByLabel(tree, '搜索历史记录'), '硬核');
tree = await settle();
clickText(tree, '已收藏');
tree = await settle();
clickText(tree, '关闭');
tree = await settle();
clickText(tree, '历史');
tree = await settle();
const persistedSearch = inputByLabel(tree, '搜索历史记录');
check('抽屉重开后保留搜索词', Boolean(persistedSearch) && String(persistedSearch.props.value) === '硬核');
checkIncludes('抽屉重开后保留已收藏筛选', nodeText(tree), '1 / 2');
const favFilterBtn = allByClass(tree, 'dvv-btn-mini').find((node) => nodeText(node) === '已收藏');
check('已收藏筛选按钮保持 active', Boolean(favFilterBtn) && favFilterBtn.props['data-active'] === 'true');
change(inputByLabel(tree, '搜索历史记录'), '');
tree = await settle();
clickText(tree, '全部');
tree = await settle();
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

/* ---------------------------------------------------------------- 大纲错误与重试 */

outlineMode = 'notfound';
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);
clickText(tree, '章节');
tree = await settle(30);
checkIncludes('大纲 not-found 中文提示', nodeText(tree), '先重新解析');
check('大纲错误有重试按钮', Boolean(buttonByText(tree, '重试')));
outlineMode = 'ok';
clickText(tree, '重试');
tree = await settle(30);
check('大纲重试后恢复列表', allByClass(tree, 'dvv-ch').length === 2);
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);

/* ------------------------------------------------ 历史抽屉不置灰 + 多张分镜 */

// 历史抽屉：overlay 不压暗、抽屉自身阴影
clickText(tree, '历史');
tree = await settle();
const histOverlay = byClass(tree, 'dvv-overlay');
check('历史抽屉 overlay 带 data-quiet', Boolean(histOverlay && histOverlay.props['data-quiet'] === 'true'));
check('历史抽屉 overlay 样式透明', /\.dvv-overlay\[data-quiet="true"\]\{background:transparent\}/.test(styleTag.textContent));
check('历史抽屉自身有阴影', /\.dvv-drawer\{[^}]*box-shadow:-10px 0 32px/.test(styleTag.textContent));
clickText(tree, '关闭');
tree = await settle();

// 设置弹窗保持原样（overlay 仍然压暗）
clickText(tree, '设置');
tree = await settle();
const settingsOverlay = byClass(tree, 'dvv-overlay');
check('设置弹窗 overlay 不置 quiet', Boolean(settingsOverlay) && settingsOverlay.props['data-quiet'] === undefined);
clickText(tree, '关闭');
tree = await settle();

// 多张分镜：按 sheets 逐张渲染
storyboardMode = 'multi';
change(byClass(tree, 'dvv-input'), YT_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);
check('切视频后旧分镜已清空', allByClass(tree, 'dvv-sb-img').length === 0);
clickText(tree, '分镜');
tree = await settle(60);
const sbImgs = allByClass(tree, 'dvv-sb-img');
check('多张分镜渲染两张图', sbImgs.length === 2);
const sbSrc0 = String((sbImgs[0] || {}).props?.src || '');
const sbSrc1 = String((sbImgs[1] || {}).props?.src || '');
check('第一张 URL 带 sheet=0', sbSrc0.includes('&sheet=0'));
check('第二张 URL 带 sheet=1', sbSrc1.includes('&sheet=1'));
check('分镜按张分组容器', allByClass(tree, 'dvv-sb-sheet').length === 2);
checkIncludes('多张分镜工具条帧数', nodeText(tree), '6 帧 · 2 张');
checkIncludes('多张分镜每帧秒数', nodeText(tree), '每 20s 一帧');
checkIncludes('第一张说明', nodeText(tree), '第 1/2 张 · 3×2 格');
checkIncludes('第二张说明', nodeText(tree), '第 2/2 张 · 3×2 格');
const sbCellsAll = allByClass(tree, 'dvv-sb-cell');
const sheet0Cells = sbCellsAll.filter((node) => node.props['data-sheet'] === '0');
const sheet1Cells = sbCellsAll.filter((node) => node.props['data-sheet'] === '1');
check('徽标只渲染所属 sheet（第一张 4 格）', sheet0Cells.length === 4);
check('徽标只渲染所属 sheet（第二张 2 格）', sheet1Cells.length === 2);
check('第二张第一格带描述 title', (sheet1Cells[0] || {}).props?.title === '第二张第一格');
click(sheet1Cells[0]);
tree = await settle();
const sbFrame2 = allByTag(tree, 'iframe')[0];
check('点击第二张格子 seek 到 500s', Boolean(sbFrame2) && sbFrame2.contentWindow.messages.some((msg) => msg && msg.seconds === 500));

// 切回 B 站视频后恢复单张
storyboardMode = 'single';
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);
clickText(tree, '分镜');
tree = await settle(60);
check('切回视频后恢复单张分镜', allByClass(tree, 'dvv-sb-img').length === 1);

/* ------------------------------------------------ 章节兜底提示 + 一键生成标题 */

outlineMode = 'hint';
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);
clickText(tree, '章节');
tree = await settle(30);
checkIncludes('章节兜底提示条', nodeText(tree), '还没有章节标题');
checkIncludes('兜底章节标题为片段', nodeText(tree), '片段 1');
check('兜底提示条有生成按钮', Boolean(buttonByText(tree, '生成章节标题')));
check('兜底提示条有去思维导图', Boolean(buttonByText(tree, '去思维导图')));

clickText(tree, '网格');
tree = await settle();
check('网格视图也显示兜底提示', Boolean(byClass(tree, 'dvv-outline-hint')));
checkIncludes('网格卡占位画面描述', nodeText(tree), '还没有画面描述');

clickText(tree, '去思维导图');
tree = await settle();
check('去思维导图切换到导图页', Boolean(byClass(tree, 'dvv-mm2-scroll')) || nodeText(tree).includes('当前模型'));
clickText(tree, '章节');
tree = await settle(20);

const hintOutlineCallsBefore = callsOf('outline').length;
const mindmapCallsBefore = callsOf('mindmap').length;
outlineMode = 'hint-slow';
clickText(tree, '生成章节标题');
tree = await settle(2);
checkIncludes('生成标题按钮 loading 文案', nodeText(tree), '正在生成…');
const busyTitleBtn = buttonByText(tree, '正在生成…');
check('生成标题按钮 loading 时禁用', Boolean(busyTitleBtn && busyTitleBtn.props.disabled === true));
await new Promise((resolve) => setTimeout(resolve, 200));
tree = await settle(40);
check('生成标题调用 GET /mindmap', callsOf('mindmap').length > mindmapCallsBefore
  && callsOf('mindmap').slice(mindmapCallsBefore).every((call) => call.method === 'GET'));
check('生成后重新 GET /outline', callsOf('outline').length > hintOutlineCallsBefore);
check('生成后提示条消失', !byClass(tree, 'dvv-outline-hint'));
checkIncludes('生成后显示真实章节标题', nodeText(tree), '开场');

// 失败：toast 中文提示，提示条保留
outlineMode = 'hint-fail';
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);
clickText(tree, '章节');
tree = await settle(30);
check('失败用例先有提示条', Boolean(byClass(tree, 'dvv-outline-hint')));
clickText(tree, '生成章节标题');
tree = await settle(30);
checkIncludes('生成标题失败 toast', nodeText(tree), '生成思维导图失败：模型调用失败');
check('失败后提示条保留', Boolean(byClass(tree, 'dvv-outline-hint')));
outlineMode = 'ok';
change(byClass(tree, 'dvv-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-input'), 'Enter');
tree = await settle(60);

/* ---------------------------------------------------------------- 错误与返回 */

let input5 = byClass(tree, 'dvv-input');
change(input5, 'https://example.com/bad-url');
tree = await settle();
input5 = byClass(tree, 'dvv-input');
keydown(input5, 'Enter');
tree = await settle();
checkIncludes('错误显示中文横幅', nodeText(tree), '没认出这个链接');

// 返回按钮：先回插件首页，再回上层
// 先重新解析一个视频（bad-url 失败后停在首页），确保返回走 resetToHome 而不是回上层
let backInput = byClass(tree, 'dvv-home-input');
change(backInput, BILI_DOC.url);
tree = await settle();
backInput = byClass(tree, 'dvv-home-input');
keydown(backInput, 'Enter');
tree = await settle();
check('重新解析后回到视频视图', Boolean(byClass(tree, 'dvv-body') && byClass(tree, 'dvv-col-left')));
const seedItem = {
  docId: 'bilibili:extra0', url: 'https://www.bilibili.com/video/BVextra0', platform: 'bilibili',
  id: 'extra0', title: '额外记录 0', author: '测试作者', duration: 60, cover: '',
  hasTranscript: true, hasSummary: false, hasChapters: false, hasMindmap: false, chatCount: 0,
  favorite: false, analyzedAt: now - 60e3, action: 'analyze',
};
historyItems = Array.from({ length: 12 }, (_, index) => ({
  ...seedItem, docId: `bilibili:extra${index}`, id: `extra${index}`, title: `额外记录 ${index}`,
}));
tree = await settle();
const backBtn = buttonByText(tree, '返回');
click(backBtn);
tree = await settle();
check('返回按钮回到插件首页', Boolean(byClass(tree, 'dvv-home')));

// 首页最多展示 10 条 + 「打开历史查看全部」
tree = await settle();
check('首页最近分析只显示前 8 张卡片', allByClass(tree, 'dvv-vcard').length === 8);
checkIncludes('首页显示打开历史查看全部', nodeText(tree), '打开历史查看全部');
clickText(tree, '打开历史查看全部');
tree = await settle();
checkIncludes('查看全部打开抽屉', nodeText(tree), '历史记录 · 12');
clickText(tree, '关闭');
tree = await settle();
const backBtn2 = buttonByText(tree, '返回');
check('首页仍有返回按钮', Boolean(backBtn2));
click(backBtn2);
check('首页点返回调用 layout.selectPanel(null)', layoutCalls.includes(null));

/* ------------------------------------------------ 后台解析队列（v0.9.0） */
check('挂载后立即 GET /jobs', callsOf('jobs').length >= 1);
jobsState = {
  concurrency: 2, active: 2, running: 1,
  jobs: [
    { id: 'job-3', docId: 'bilibili:extra3', title: '额外记录 3', status: 'running', stage: 'summary', stageLabel: '正在写总结…', percent: 42, updatedAt: now },
    { id: 'job-5', docId: 'bilibili:extra5', title: '额外记录 5', status: 'queued', stage: 'transcript', stageLabel: '', percent: 0, updatedAt: now - 1000 },
    { id: 'job-7', docId: 'bilibili:extra7', title: '额外记录 7', status: 'failed', stage: 'resolve', stageLabel: '', percent: 12, error: 'B 站接口返回 -352', updatedAt: now - 2000 },
  ],
};
await sandbox.__jobsTick();
tree = await settle();
check('首页历史显示后台解析进度条', allByClass(tree, 'dvv-jobbar').length >= 2);
checkIncludes('首页历史显示阶段文案', nodeText(tree), '正在写总结…');
checkIncludes('首页历史显示排队中', nodeText(tree), '排队中…');
checkIncludes('失败任务显示「解析失败」', nodeText(tree), '解析失败');
const failedJobNode = findOne(tree, (node) => hasClass(node, 'dvv-job-failed'));
check('失败任务 title 带 error 信息', Boolean(failedJobNode) && String(failedJobNode.props.title || '').includes('-352'));
check('全部解析按钮显示「解析中 N」', Boolean(buttonByText(tree, '解析中 2')));

const jobCancelButtons = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && String(node.props.title || '') === '取消后台解析');
check('历史行有取消按钮', jobCancelButtons.length >= 2);
click(jobCancelButtons[0]);
tree = await settle();
check('取消后台解析 POST docId', jobsCancelCalls.includes('bilibili:extra3'));
checkIncludes('取消后台解析 toast', nodeText(tree), '已取消后台解析');

clickText(tree, '解析中');
tree = await settle();
checkIncludes('全部解析需要二次确认', nodeText(tree), '确认解析？');
clickText(tree, '确认解析？');
tree = await settle();
check('全部解析 POST /jobs/all', jobsAllCalls.length === 1 && Number(jobsAllCalls[0].limit) === 20 && jobsAllCalls[0].describe === true);
checkIncludes('全部解析 toast', nodeText(tree), '已开始 2 个，跳过 3 个');

// 详情页：解析 BILI 视频，工具条显示后台 chip
let jobsInput = byClass(tree, 'dvv-home-input');
change(jobsInput, BILI_DOC.url);
tree = await settle();
jobsInput = byClass(tree, 'dvv-home-input');
keydown(jobsInput, 'Enter');
tree = await settle(60);
check('详情页已解析', Boolean(byClass(tree, 'dvv-body')));
jobsState = {
  concurrency: 2, active: 1, running: 1,
  jobs: [{ id: 'job-bili', docId: BILI_DOC.docId, title: BILI_DOC.title, status: 'running', stage: 'summary', stageLabel: '正在写总结…', percent: 42, updatedAt: now }],
};
await sandbox.__jobsTick();
tree = await settle();
checkIncludes('详情工具条显示后台解析 chip', nodeText(tree), '后台解析 42% · 正在写总结…');
const chipCancel = findOne(tree, (node) => hasClass(node, 'dvv-job-chip-x'));
check('chip 有取消按钮', Boolean(chipCancel));
if (chipCancel) {
  chipCancel.props.onClick({ preventDefault() {}, stopPropagation() {} });
  tree = await settle();
}
check('chip 取消 POST docId', jobsCancelCalls.slice(-1)[0] === BILI_DOC.docId);

// 完成迁移：running → done 触发历史/大纲/分镜刷新 + toast
const historyCallsBeforeJob = callsOf('history').length;
const outlineCallsBeforeJob = callsOf('outline').length;
const storyboardCallsBeforeJob = callsOf('storyboard').length;
jobsState = {
  concurrency: 2, active: 0, running: 0,
  jobs: [{ id: 'job-bili', docId: BILI_DOC.docId, title: BILI_DOC.title, status: 'done', stage: 'done', stageLabel: '已完成', percent: 100, updatedAt: now + 1000 }],
};
await sandbox.__jobsTick();
tree = await settle(80);
checkIncludes('后台解析完成 toast', nodeText(tree), '后台解析完成');
check('完成后刷新历史', callsOf('history').length > historyCallsBeforeJob);
check('完成后刷新大纲', callsOf('outline').length > outlineCallsBeforeJob);
check('完成后刷新分镜', callsOf('storyboard').length > storyboardCallsBeforeJob);

/* ------------------------------------------------ task-25：解析即入队后台任务 */
jobsCreateMode = 'ok';
jobsState = { concurrency: 0, active: 0, running: 0, jobs: [] };
analysisMode = 'notfound';
// 首页历史里放一条当前视频，用来断言行内进度条
historyItems = [{
  docId: BILI_DOC.docId, url: BILI_DOC.url, platform: 'bilibili', id: 'BV1xx411c7mD',
  title: BILI_DOC.title, author: '硬核拆解', duration: 754, cover: '',
  hasTranscript: true, hasSummary: false, hasChapters: false, hasMindmap: false, chatCount: 0,
  favorite: false, analyzedAt: now, action: 'view',
}, ...historyItems];
if (buttonByText(tree, '返回')) { click(buttonByText(tree, '返回')); tree = await settle(); }
check('入队测试前回到首页', Boolean(byClass(tree, 'dvv-home-input')));
const analyzeBeforeEnqueue = callsOf('analyze').length;
change(byClass(tree, 'dvv-home-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(90);
const enqueueBody = jobsCreateCalls.slice(-1)[0] || {};
check('解析成功后 POST /jobs 入队', enqueueBody.docId === BILI_DOC.docId && enqueueBody.describe === true);
check('入队后不再内联跑总结', callsOf('analyze').length === analyzeBeforeEnqueue);
checkIncludes('总结页签显示后台解析占位', nodeText(tree), '后台解析中 42% · 正在写总结…');
check('后台占位时不显示「还没有生成总结」', !nodeText(tree).includes('还没有生成总结'));
checkIncludes('详情工具条显示后台 chip', nodeText(tree), '后台解析 42% · 正在写总结…');

click(buttonByText(tree, '返回'));
tree = await settle();
check('首页按钮显示解析中 1', Boolean(buttonByText(tree, '解析中 1')));
check('首页历史行显示后台解析进度条', allByClass(tree, 'dvv-jobbar').length >= 1);
checkIncludes('首页历史行显示阶段文案', nodeText(tree), '42% · 正在写总结…');

const enqueueCountBeforeReopen = jobsCreateCalls.length;
change(byClass(tree, 'dvv-home-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(90);
check('同一视频已在跑时不重复入队', jobsCreateCalls.length === enqueueCountBeforeReopen);
checkIncludes('复用已有任务的状态', nodeText(tree), '后台解析中 42% · 正在写总结…');

// job running → done：拉 /analysis 回填 + toast
analysisMode = 'ok';
analysisValue = {
  savedAt: now - 5e3,
  summary: { text: '## 后台总结\n- 后台第一条结论', generatedAt: now - 5e3 },
  chapters: { items: [{ start: 0, title: '后台章节', gist: '后台章节说明' }], source: 'llm', generatedAt: now - 5e3 },
  mindmap: { mindmap: { title: '后台导图', children: [{ title: '后台分支' }] }, generatedAt: now - 5e3 },
  chat: [],
};
jobsState = {
  concurrency: 0, active: 0, running: 0,
  jobs: [{ id: 'job-bili', docId: BILI_DOC.docId, title: BILI_DOC.title, status: 'done', stage: 'done', stageLabel: '已完成', percent: 100, updatedAt: now + 1000 }],
};
await sandbox.__jobsTick();
tree = await settle(100);
check('完成后 GET /analysis 回填', callsOf('analysis').some((call) => call.params.docId === BILI_DOC.docId));
checkIncludes('后台完成 toast', nodeText(tree), '后台解析完成');
checkIncludes('总结回填后台生成内容', nodeText(tree), '后台总结');
check('完成后不再显示后台解析占位', !nodeText(tree).includes('后台解析中'));

// /jobs 失败：回退原来的内联总结
jobsCreateMode = 'fail';
analysisMode = 'notfound';
click(buttonByText(tree, '返回'));
tree = await settle();
const analyzeBeforeFallback = callsOf('analyze').length;
change(byClass(tree, 'dvv-home-input'), YT_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(90);
check('/jobs 失败时回退内联总结', callsOf('analyze').length > analyzeBeforeFallback);
checkIncludes('回退内联总结有内容', nodeText(tree), '结论');
check('回退模式不显示后台占位', !nodeText(tree).includes('后台解析中'));


/* ---------------------------------------------- task-26：P0 UI/UX 改造（v0.10.0） */

// 首页：新副标题 + 旧文案兼容 + 示例 chips
const backHome = async () => { const b = buttonByText(tree, '返回'); if (b) click(b); tree = await settle(); };
await backHome();
checkIncludes('首页新副标题', nodeText(tree), '粘贴一条链接，30 秒看清一个视频值不值得看。');
check('首页不再有隐藏旧副标题节点', !byClass(tree, 'dvv-home-sub2'));
check('首页不再有示例 chips', allByClass(tree, 'dvv-home-chip').length === 0);

// 首页：最近分析卡片流
const cards = allByClass(tree, 'dvv-vcard');
check('首页最近分析是卡片网格', Boolean(byClass(tree, 'dvv-cards-grid')) && cards.length > 0);
check('首页卡片最多 8 张', cards.length === 8);
check('卡片带封面时长角标', allByClass(tree, 'dvv-vcard-dur').length >= 1);
checkIncludes('卡片带标题', nodeText(cards[0]), '第一性原理');
checkIncludes('卡片带状态徽标', nodeText(cards[0]), '字幕');
check('卡片 ⋯ 菜单出现', (() => { const b = byClass(cards[0], 'dvv-vcard-more'); return Boolean(b) && (click(b), true); })());
tree = await settle();
check('卡片菜单含重新解析/复制链接/收藏/删除', Boolean(buttonByText(tree, '重新解析'))
  && Boolean(buttonByText(tree, '复制链接')) && Boolean(buttonByText(tree, '删除')));
const clipBeforeCard = sandbox.__clipboardWrites.length;
clickText(tree, '复制链接');
tree = await settle();
check('卡片菜单复制链接写入剪贴板', sandbox.__clipboardWrites.length === clipBeforeCard + 1
  && String(sandbox.__clipboardWrites.slice(-1)[0] || '').indexOf('BV1xx411c7mD') >= 0);

const cards2 = allByClass(tree, 'dvv-vcard');
const favBeforeCard = callsOf('history/favorite').length;
click(byClass(cards2[0], 'dvv-vcard-more'));
tree = await settle();
clickText(tree, '收藏');
tree = await settle();
check('卡片菜单收藏 POST /history/favorite', callsOf('history/favorite').length === favBeforeCard + 1);
checkIncludes('卡片菜单收藏 toast', nodeText(tree), '已收藏');

const resolveBeforeCard = callsOf('resolve').length;
click(allByClass(tree, 'dvv-vcard')[0]);
tree = await settle(40);
check('点击卡片重新解析', callsOf('resolve').length === resolveBeforeCard + 1
  && String(callsOf('resolve').slice(-1)[0].params.url || '').indexOf('BV1xx411c7mD') >= 0);
await backHome();

// 全局任务条 + 任务抽屉
jobsState = {
  concurrency: 2, active: 3, running: 1,
  jobs: [
    { id: 'job-r1', docId: 'bilibili:extra0', title: '额外记录 0', status: 'running', stage: 'summary', stageLabel: '正在写总结…', percent: 42, updatedAt: now },
    { id: 'job-q1', docId: 'bilibili:extra1', title: '额外记录 1', status: 'queued', stage: 'transcript', stageLabel: '', percent: 0, updatedAt: now },
    { id: 'job-f1', docId: 'bilibili:extra2', title: '额外记录 2', status: 'failed', stage: 'resolve', stageLabel: '', percent: 12, error: 'boom', updatedAt: now },
  ],
};
await sandbox.__jobsTick();
tree = await settle();
const gbar = byClass(tree, 'dvv-jobbar-global');
check('全局任务条出现', Boolean(gbar));
checkIncludes('全局任务条显示队列', nodeText(gbar), '解析队列');
checkIncludes('全局任务条显示阶段', nodeText(gbar), '正在写总结');
clickText(tree, '展开');
tree = await settle();
check('任务抽屉打开', Boolean(byClass(tree, 'dvv-job-drawer')));
checkIncludes('任务抽屉分区运行中', nodeText(byClass(tree, 'dvv-job-drawer')), '运行中 · 1');
checkIncludes('任务抽屉分区排队中', nodeText(byClass(tree, 'dvv-job-drawer')), '排队中 · 1');
checkIncludes('任务抽屉分区最近完成', nodeText(byClass(tree, 'dvv-job-drawer')), '最近完成 · 1');
jobsCreateMode = 'ok';
const retryBefore = jobsCreateCalls.length;
clickText(tree, '重试');
tree = await settle(40);
check('任务抽屉重试 POST /jobs', jobsCreateCalls.length === retryBefore + 1
  && String(jobsCreateCalls.slice(-1)[0].docId || '') === 'bilibili:extra2');
const cancelBefore = jobsCancelCalls.length;
clickText(tree, '取消');
tree = await settle(40);
check('任务抽屉取消 POST /jobs/cancel', jobsCancelCalls.length === cancelBefore + 1);
const clearBefore = jobsClearCalls.length;
clickText(tree, '清除已完成');
tree = await settle(40);
check('清空已完成 POST /jobs/clear', jobsClearCalls.length === clearBefore + 1);
clickText(tree, '关闭');
tree = await settle();
check('关闭任务抽屉', !byClass(tree, 'dvv-job-drawer'));

// 工具栏两层 + 信息层折叠 + 下拉菜单
jobsCreateMode = 'fail';
change(byClass(tree, 'dvv-home-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(80);
check('工具栏分两层', Boolean(byClass(tree, 'dvv-toolbar-row')) && Boolean(byClass(tree, 'dvv-meta')));
checkIncludes('信息层含播放数', nodeText(byClass(tree, 'dvv-meta')), '播放');
clickText(tree, '收起视频信息');
tree = await settle();
check('收起信息层后折叠', byClass(tree, 'dvv-meta').props['data-collapsed'] === 'true'
  && sandbox.__store.get('dsh-video.meta.collapsed') === '1');
checkIncludes('折叠后出现展开入口', nodeText(tree), '展开视频信息');
clickText(tree, '展开视频信息');
tree = await settle();
check('展开信息层恢复', byClass(tree, 'dvv-meta').props['data-collapsed'] === 'false'
  && sandbox.__store.get('dsh-video.meta.collapsed') === '0');

// 页签状态点
const dots = allByClass(tree, 'dvv-tab-dot');
check('页签状态点 5 个', dots.length === 5);
check('页签状态点带状态值', dots.every((dot) => ['ready', 'loading', 'empty'].includes(String(dot.props['data-state']))));

// 总结卡片化 + 折叠区
check('总结渲染主卡', Boolean(byClass(tree, 'dvv-sum-big')));
checkIncludes('总结主卡标题', nodeText(byClass(tree, 'dvv-sum-big')), '结论');
checkIncludes('总结主卡保留列表', nodeText(byClass(tree, 'dvv-sum-big')), '要点一');
checkIncludes('总结主卡保留时间徽标', allByClass(byClass(tree, 'dvv-sum-big'), 'dvv-ts').map(nodeText).join('|'), '00:08');
check('总结无额外分段时不渲染折叠区', allByClass(tree, 'dvv-sum-fold').length === 0);

// 工具栏下拉：重新生成 / 导出
const mmBefore = callsOf('mindmap').length;
clickText(tree, '重新生成 ▾');
tree = await settle();
check('重新生成菜单包含总结/导图/分镜', Boolean(buttonByText(tree, '重新生成总结'))
  && Boolean(buttonByText(tree, '重新生成思维导图')) && Boolean(buttonByText(tree, '重新生成分镜')));
click(buttonByText(tree, '重新生成思维导图'));
tree = await settle(40);
check('菜单重新生成思维导图 GET /mindmap', callsOf('mindmap').length > mmBefore);
const clipBeforeExport = sandbox.__clipboardWrites.length;
clickText(tree, '导出 ▾');
tree = await settle();
check('导出菜单包含三项', Boolean(buttonByText(tree, '复制 Markdown'))
  && Boolean(buttonByText(tree, '下载 .md')) && Boolean(buttonByText(tree, '复制全文')));
click(buttonByText(tree, '复制全文'));
tree = await settle();
check('导出菜单复制全文写入剪贴板', sandbox.__clipboardWrites.length === clipBeforeExport + 1
  && String(sandbox.__clipboardWrites.slice(-1)[0] || '').indexOf('大家好') >= 0);

// parseSummarySections 纯函数
const pss = exports_.__test.parseSummarySections;
check('暴露 parseSummarySections', typeof pss === 'function');
const parsed = typeof pss === 'function' ? pss(SUMMARY_TEXT) : [];
check('parseSummarySections 按 ## 切段', parsed.length === 1 && parsed[0].title === '结论');
check('parseSummarySections 保留正文', String(parsed[0] && parsed[0].body || '').indexOf('要点一') >= 0 && String(parsed[0].body).indexOf('### 深入') >= 0);
check('parseSummarySections 无标题时回退整段', (() => {
  const plain = typeof pss === 'function' ? pss('没有标题的一段话') : [];
  return plain.length === 1 && String(plain[0].body).indexOf('没有标题') >= 0;
})());

// 统一状态组件：章节错误态（UnifiedState/ErrorState）
outlineMode = 'notfound';
clickText(tree, '返回');
tree = await settle();
change(byClass(tree, 'dvv-home-input'), YT_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(60);
clickText(tree, '章节');
tree = await settle(40);
check('章节错误用统一状态组件', Boolean(byClass(tree, 'dvv-state')));
checkIncludes('章节错误显示中文原因', nodeText(tree), '还没有这个视频的大纲');
check('章节错误有重试按钮', Boolean(buttonByText(tree, '重试')));
outlineMode = 'ok';



/* ---------------------------------------------------------------- 多语言 i18n */

// 回到首页 → 设置 → 语言区块
clickText(tree, '返回');
tree = await settle();
clickText(tree, '设置');
tree = await settle();
checkIncludes('设置里有语言区块', nodeText(tree), '语言 / Language');
check('语言选项有三个', Boolean(buttonByText(tree, 'English')) && Boolean(buttonByText(tree, '中文')) && Boolean(buttonByText(tree, '跟随 DSH')));

clickText(tree, 'English');
tree = await settle();
check('切换英文后首页标题', nodeText(tree).includes('Video Insights'));
check('语言写入 localStorage', sandbox.__store.get('dsh-video.lang') === 'en');

const closeOk = clickText(tree, 'Close');
tree = await settle();
check('英文首页按钮与文案', nodeText(tree).includes('Analyze') && nodeText(tree).includes('Video Insights'));
checkIncludes('英文输入框 placeholder', JSON.stringify(byClass(tree, 'dvv-home-input').props.placeholder), 'Paste a video link');

// 英文界面下重新解析：resolve / analyze / outline / mindmap / storyboard 都带 lang
change(byClass(tree, 'dvv-home-input'), BILI_DOC.url);
tree = await settle();
keydown(byClass(tree, 'dvv-home-input'), 'Enter');
tree = await settle(60);
const enResolve = callsOf('resolve').slice(-1)[0];
check('英文下 resolve 带 lang=en', Boolean(enResolve) && enResolve.params && enResolve.params.lang === 'en');
const enSummary = callsOf('analyze').filter((call) => call.body && call.body.mode === 'summary').slice(-1)[0];
check('英文下 analyze 带 lang=en', Boolean(enSummary) && enSummary.body.lang === 'en');

// 英文界面 + 中文小结标题：解析不到英文小节 → 回退纯 Markdown（不出现卡片）
check('英文界面下中文小节不卡片化', !byClass(tree, 'dvv-sum-big') && Boolean(byClass(tree, 'dvv-md')));
const pssEn = exports_.__test.parseSummarySections('## Key points\n- a\n\n## Outline\n- b');
check('英文小节标题按 en 解析', pssEn.length === 2 && pssEn[0].title === 'Key points');

// 英文总结：卡片化英文小节
const EN_SUMMARY_EVENTS = [
  { type: 'delta', text: '## One-sentence summary\n- 拆到最本质的问题\n\n## Key points\n- 第一点\n- 第二点\n\n## Outline\n- 开场\n- 结论' },
  { type: 'done', text: '## One-sentence summary\n- 拆到最本质的问题\n\n## Key points\n- 第一点\n- 第二点\n\n## Outline\n- 开场\n- 结论', usage: {}, suggestions: [] },
];
const prevAnalyzeRoute = routes.analyze;
routes.analyze = (call) => ({ __sse: call.body && call.body.mode === 'ask' ? ASK_EVENTS : EN_SUMMARY_EVENTS });
clickText(tree, 'Regenerate');
tree = await settle();
check('英文下拉里有重新生成总结', Boolean(buttonByText(tree, 'Regenerate summary')));
clickText(tree, 'Regenerate summary');
tree = await settle(60);
checkIncludes('英文总结渲染大卡', nodeText(tree), 'One-sentence summary');
check('英文总结渲染卡片类', Boolean(byClass(tree, 'dvv-sum-big')) && Boolean(byClass(tree, 'dvv-sum-cards')));
routes.analyze = prevAnalyzeRoute;

// 章节 / 导图 / 分镜请求都带 lang
clickText(tree, 'Chapters');
tree = await settle(40);
const enOutline = callsOf('outline').slice(-1)[0];
check('英文下 outline 带 lang=en', Boolean(enOutline) && enOutline.params && enOutline.params.lang === 'en');
clickText(tree, 'Mindmap');
tree = await settle(40);
const enMindmap = callsOf('mindmap').slice(-1)[0];
check('英文下 mindmap 带 lang=en', Boolean(enMindmap) && enMindmap.params && enMindmap.params.lang === 'en');
clickText(tree, 'Storyboard');
tree = await settle(60);
const enStoryboard = callsOf('storyboard').filter((call) => call.method === 'POST').slice(-1)[0];
check('英文下 storyboard 带 lang=en', Boolean(enStoryboard) && enStoryboard.body && enStoryboard.body.lang === 'en');

// 跟随 DSH（auto）：无 locale 服务时中文兜底
clickText(tree, 'Settings');
tree = await settle();
const followOk = clickText(tree, 'Follow DSH');
tree = await settle();
check('切回 auto 后语言设置持久化', sandbox.__store.get('dsh-video.lang') === 'auto');
if (!clickText(tree, 'Close')) clickText(tree, '关闭');
tree = await settle();
check('auto 且无 locale 时中文兜底', nodeText(tree).includes('重新生成') || nodeText(tree).includes('返回'));



/* ---------------------------------------------------------------- task-28：本机组件 / 模型下载 / 环境准备 */

const exactButton = (root, text) => findAll(root, (n) => n.__host === 'element' && n.tag === 'button' && nodeText(n) === text)[0];

// 打开设置：进入时拉取模型信息
clickText(tree, '设置');
tree = await settle(40);
check('task28 打开设置拉取模型信息', callsOf('asr/models').filter((call) => call.method === 'GET').length >= 1);

// 四个本机组件状态行 + 可编辑路径
check('task28 四个本机组件显示可用', ['ffmpeg', 'yt-dlp', 'whisper-cli', 'sherpa-onnx'].every((name) => nodeText(tree).includes(`${name} · 可用`)));
const toolRows = allByClass(tree, 'dvv-path-line');
check('task28 组件行带路径输入', toolRows.length >= 4 && Boolean(byClass(tree, 'dvv-path-input')));

// placeholder 用 host 默认路径
const ffInput = findAll(tree, (n) => n.__host === 'element' && n.tag === 'input' && n.props && n.props.placeholder === '/opt/homebrew/bin/ffmpeg')[0];
check('task28 路径 placeholder 为 host 默认路径', Boolean(ffInput));

// 保存路径 → POST /asr/config
change(ffInput, '/custom/ffmpeg');
tree = await settle();
const firstToolRow = allByClass(tree, 'dvv-path-line')[0];
const savePathBtn = exactButton(firstToolRow, '保存路径');
check('task28 组件行有保存路径按钮', Boolean(savePathBtn));
if (savePathBtn) click(savePathBtn);
tree = await settle(40);
const savedCfg = callsOf('asr/config').slice(-1)[0];
check('task28 保存路径提交 ffmpegPath', Boolean(savedCfg) && savedCfg.body && savedCfg.body.ffmpegPath === '/custom/ffmpeg');

// 重新检测（fresh=1）
clickText(tree, '重新检测');
tree = await settle(40);
const recheck = callsOf('asr/status').slice(-1)[0];
check('task28 重新检测带 fresh=1', Boolean(recheck) && recheck.params && recheck.params.fresh === '1');

// 模型卡片
check('task28 模型卡片渲染', nodeText(tree).includes('模型文件') && nodeText(tree).includes('Whisper large-v3-turbo') && nodeText(tree).includes('574 MB'));
const modelCards = allByClass(tree, 'dvv-model-card');
check('task28 Whisper/SenseVoice 两张卡片', modelCards.length === 2);
const modelPathInputs = findAll(tree, (n) => n.__host === 'element' && n.tag === 'input' && n.props && String(n.props.className || '').includes('dvv-path-input'));
check('task28 模型路径输入共 3 个（含 SenseVoice 词表）', modelPathInputs.length >= 7);

// 一键下载 Whisper
const dlBtn = modelCards[0] ? exactButton(modelCards[0], '下载') : null;
check('task28 模型卡有下载按钮', Boolean(dlBtn));
if (dlBtn) click(dlBtn);
tree = await settle(60);
const dlCall = callsOf('asr/models').filter((call) => call.method === 'POST').slice(-1)[0];
check('task28 下载请求体 id=whisper force=false', Boolean(dlCall) && dlCall.body && dlCall.body.id === 'whisper' && dlCall.body.force === false);
check('task28 下载完成 toast 并刷新状态', nodeText(tree).includes('模型已下载完成'));

// 慢速下载：进度条 + 取消
modelDownloadMode = 'slow';
const dlBtn2 = allByClass(tree, 'dvv-model-card')[0] ? exactButton(allByClass(tree, 'dvv-model-card')[0], '下载') : null;
if (dlBtn2) click(dlBtn2);
tree = await settle(12);
check('task28 下载中显示取消按钮', Boolean(buttonByText(tree, '取消下载')));
const progressNode = byClass(tree, 'dvv-progress');
check('task28 下载中进度条不确定态', Boolean(progressNode) && progressNode.props['data-indeterminate'] === 'true');
clickText(tree, '取消下载');
tree = await settle(30);
check('task28 取消下载提示', nodeText(tree).includes('已取消下载模型'));

// 下载失败文案
modelDownloadMode = 'error';
const dlBtn3 = allByClass(tree, 'dvv-model-card')[0] ? exactButton(allByClass(tree, 'dvv-model-card')[0], '下载') : null;
if (dlBtn3) click(dlBtn3);
tree = await settle(60);
check('task28 下载失败中文提示', nodeText(tree).includes('下载模型失败') && nodeText(tree).includes('HTTP 404'));
modelDownloadMode = 'ok';

// macOS 安装命令与复制
check('task28 macOS 安装命令', nodeText(tree).includes('brew install ffmpeg yt-dlp whisper.cpp'));
const cl = sandbox.__clipboardWrites.length;
const copyCmd = buttonByText(tree, '复制');
if (copyCmd) click(copyCmd);
tree = await settle();
check('task28 安装命令可复制', sandbox.__clipboardWrites.length === cl + 1 && String(sandbox.__clipboardWrites.slice(-1)[0]).includes('brew install ffmpeg yt-dlp whisper.cpp'));

// Windows 平台安装提示
asrStatusOverride = JSON.parse(JSON.stringify(ASR));
asrStatusOverride.tools.platform = 'win32';
clickText(tree, '重新检测');
tree = await settle(40);
check('task28 Windows 安装命令', nodeText(tree).includes('winget install Gyan.FFmpeg') && nodeText(tree).includes('winget install yt-dlp.yt-dlp') && nodeText(tree).includes('whisper-bin-x64.zip'));
asrStatusOverride = null;

// 关闭设置
if (!clickText(tree, '关闭')) clickText(tree, 'Close');
tree = await settle(30);

// 首页环境准备卡：asr.ready=false
asrStatusOverride = { ...JSON.parse(JSON.stringify(ASR)), ready: false };
clickText(tree, '设置');
tree = await settle(40);
if (!clickText(tree, '关闭')) clickText(tree, 'Close');
tree = await settle(30);
clickText(tree, '返回');
tree = await settle(40);
check('task28 首页环境准备卡显示', Boolean(byClass(tree, 'dvv-setup-card')) && nodeText(tree).includes('环境准备'));
const setupInstallBtn = buttonByText(tree, '一键安装缺失组件');
check('task30 首页环境准备卡有「一键安装缺失组件」', Boolean(setupInstallBtn));
if (setupInstallBtn) {
  click(setupInstallBtn);
  tree = await settle(20);
  check('task30 首页一键安装提交 all', (lastCallOf('install')?.body || {}).id === 'all');
  installMode = 'ok';
}
const setupClose = byClass(tree, 'dvv-setup-close');
if (setupClose) click(setupClose);
tree = await settle();
check('task28 关闭环境准备卡写入 localStorage', sandbox.__store.get('dsh-video.setupDismissed') === '1' && !byClass(tree, 'dvv-setup-card'));
asrStatusOverride = null;

// 英文文案
clickText(tree, '设置');
tree = await settle(40);
clickText(tree, 'English');
tree = await settle(40);
check('task28 英文组件/模型/安装文案', nodeText(tree).includes('Local tools') && nodeText(tree).includes('Model files') && nodeText(tree).includes('Re-check') && nodeText(tree).includes('Installation'));
clickText(tree, 'Follow DSH');
tree = await settle(40);
if (!clickText(tree, 'Close')) clickText(tree, '关闭');
tree = await settle(30);


/* ---------------- task-29: ASR 设置区块中英文本地化 ---------------- */

const asrBoxText = () => {
  const box = byClass(tree, 'dvv-asr-box');
  return box ? nodeText(box) : '';
};
const cjkChars = (text) => String(text || '').match(/[\u3400-\u9fff]/g) || [];
const recheckAsr = async () => {
  if (!clickText(tree, 'Re-check')) clickText(tree, '重新检测');
  tree = await settle(40);
};

// 切英文并打开设置
clickText(tree, '设置');
tree = await settle(40);
clickText(tree, 'English');
tree = await settle(40);
checkIncludes('task29 英文 ASR 标题', asrBoxText(), 'Local transcription');
checkIncludes('task29 英文并行分析文案', asrBoxText(), 'Run speech and vision analysis in parallel');
checkIncludes('task29 英文 OCR 抽帧标签', asrBoxText(), 'Frame interval (seconds)');
checkIncludes('task29 英文画面理解标题', asrBoxText(), 'Visual understanding (vision model)');
checkIncludes('task29 英文引擎当前使用', asrBoxText(), 'In use: Whisper (whisper.cpp)');
checkIncludes('task29 英文保留音频说明', asrBoxText(), 'Keep temporary audio');
check('task29 英文 ASR 区块无中文残留', cjkChars(asrBoxText()).length === 0);

// host 中文 hints：英文下不直接显示，改用通用英文提示
asrStatusOverride = { ...ASR, hints: ['当前环境没有可用的 yt-dlp，无法下载 B 站音频'] };
await recheckAsr();
checkIncludes('task29 英文下 hints 用通用英文提示', asrBoxText(), 'Some components are missing or not ready');
check('task29 英文下不显示 host 中文 hints', !asrBoxText().includes('无法下载 B 站音频') && cjkChars(asrBoxText()).length === 0);

// OCR 不可用 + 中文 reason → 英文兜底
asrStatusOverride = JSON.parse(JSON.stringify(ASR));
asrStatusOverride.ocr.available = false;
asrStatusOverride.ocr.reason = '当前平台不支持画面文字识别';
await recheckAsr();
checkIncludes('task29 英文 OCR 不可用文案', asrBoxText(), 'Recognize on-screen text when there is no speech (OCR): unavailable');
check('task29 OCR reason 中文被英文兜底', !asrBoxText().includes('当前平台不支持画面文字识别') && cjkChars(asrBoxText()).length === 0);

// 画面理解不可用 + 中文 reason → 英文兜底
asrStatusOverride = JSON.parse(JSON.stringify(ASR));
asrStatusOverride.vision.available = false;
asrStatusOverride.vision.reason = '没有可用的视觉模型';
await recheckAsr();
checkIncludes('task29 英文画面理解不可用文案', asrBoxText(), 'Visual understanding unavailable:');
check('task29 画面理解 reason 中文被英文兜底', !asrBoxText().includes('没有可用的视觉模型') && cjkChars(asrBoxText()).length === 0);

// 还原 host 状态并切回中文：zh 下 hints 仍按 host 文案展示
asrStatusOverride = { ...ASR, hints: ['提示样本：请安装 yt-dlp'] };
await recheckAsr();
if (!clickText(tree, 'Close')) clickText(tree, '关闭');
tree = await settle(30);
if (!clickText(tree, 'Settings')) clickText(tree, '设置');
tree = await settle(40);
if (!clickText(tree, 'Follow DSH')) clickText(tree, '跟随 DSH');
tree = await settle(40);
await recheckAsr();
checkIncludes('task29 中文界面 ASR 区块', asrBoxText(), '本地语音转写');
checkIncludes('task29 中文下显示 host hints', asrBoxText(), '提示样本：请安装 yt-dlp');
asrStatusOverride = null;
if (!clickText(tree, '关闭')) clickText(tree, 'Close');
tree = await settle(30);


/* ---------------------------------------------------------------- task-30：本机组件一键安装 */
asrStatusOverride = JSON.parse(JSON.stringify(ASR));
asrStatusOverride.ready = false;
asrStatusOverride.tools.ytdlp.available = false;
asrStatusOverride.tools.ytdlp.path = '';
asrStatusOverride.tools.whisper.available = false;
asrStatusOverride.tools.whisper.path = '';
installPlanValue = JSON.parse(JSON.stringify(INSTALL_PLAN));
installMode = 'ok';

clickText(tree, '设置');
tree = await settle(40);
await recheckAsr();
check('task30 打开设置拉取安装计划', callsOf('install/plan').length >= 1);
check('task30 本机组件区显示全部自动安装', Boolean(buttonByText(tree, '全部自动安装')));
const autoInstallBtns = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node) === '自动安装');
check('task30 未装组件显示自动安装', autoInstallBtns.length >= 1);
check('task30 brew 组件显示用 Homebrew 安装', Boolean(buttonByText(tree, '用 Homebrew 安装')));
checkIncludes('task30 brew 组件提示需要 Homebrew', asrBoxText(), '需要本机已安装 Homebrew');
checkIncludes('mac 上显示 whisper 后端说明（Homebrew 构建）', asrBoxText(), 'Homebrew 构建');
check('mac 上不显示 whisper 后端下拉', findAll(tree, (node) => node.__host === 'element' && node.tag === 'select' && String(node.props['aria-label'] || '').includes('whisper 后端')).length === 0);

// 存储管理
storageCleared = '';
checkIncludes('storage 设置里有存储管理', nodeText(tree), '存储管理');
checkIncludes('storage 列出低清视频', nodeText(tree), '低清视频与缩略图');
checkIncludes('storage 显示分镜体积', nodeText(tree), '17 MB');
const storageClearBtns = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node) === '清理');
check('storage 六类缓存各有清理按钮', storageClearBtns.length === 6);
click(storageClearBtns[1]);
tree = await settle(10);
const confirmStorage = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node) === '确认清理？');
check('storage 清理需要二次确认', confirmStorage.length === 1);
click(confirmStorage[0]);
tree = await settle(30);
check('storage 清理分镜提交 kind=storyboards', (lastCallOf('storage/clear')?.body || {}).kind === 'storyboards');
checkIncludes('storage 清理后分镜变 0 个文件', nodeText(tree), '0 个文件');
clickText(tree, '立即清理过期缓存');
tree = await settle(20);
check('storage 立即清理调用 prune', callsOf('storage/prune').length >= 1);

const planCallsBefore = callsOf('install/plan').length;
const asrCallsBefore = callsOf('asr/status').length;
click(autoInstallBtns[0]);
tree = await settle(20);
check('task30 点击自动安装提交 ytdlp', (lastCallOf('install')?.body || {}).id === 'ytdlp');
await settle(20);
checkIncludes('task30 安装完成 toast', nodeText(tree), '已安装 yt-dlp');
check('task30 安装后刷新安装计划', callsOf('install/plan').length > planCallsBefore);
check('task30 安装后刷新 ASR 状态', callsOf('asr/status').length > asrCallsBefore);

clickText(tree, '全部自动安装');
tree = await settle(20);
check('task30 全部自动安装提交 all', (lastCallOf('install')?.body || {}).id === 'all');
checkIncludes('task30 全部安装完成 toast', nodeText(tree), '已安装');

installMode = 'slow';
clickText(tree, '全部自动安装');
tree = await settle(20);
check('task30 安装中显示取消按钮', Boolean(buttonByText(tree, '取消')));
const installProgressNodes = allByClass(tree, 'dvv-progress');
check('task30 未知进度显示不确定态', installProgressNodes.length >= 1
  && installProgressNodes[installProgressNodes.length - 1].props['data-indeterminate'] === 'true');
const cancelInstallBtn = buttonByText(tree, '取消');
if (cancelInstallBtn) click(cancelInstallBtn);
tree = await settle(30);
checkIncludes('task30 取消安装 toast', nodeText(tree), '已取消安装');
check('task30 取消后安装按钮恢复可用',
  !buttonByText(tree, '全部自动安装') || buttonByText(tree, '全部自动安装').props.disabled !== true);

installMode = 'error';
const autoInstallBtns2 = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node) === '自动安装');
if (autoInstallBtns2.length) click(autoInstallBtns2[0]);
tree = await settle(30);
checkIncludes('task30 安装失败中文提示', nodeText(tree), '下载失败');
installMode = 'ok';

clickText(tree, 'English');
tree = await settle(40);
check('task30 英文安装区无中文残留', cjkChars(asrBoxText()).length === 0);
if (!clickText(tree, '中文')) clickText(tree, 'Chinese');
tree = await settle(40);
asrStatusOverride = null;
installPlanValue = null;
if (!clickText(tree, '关闭')) clickText(tree, 'Close');
tree = await settle(30);

/* -------------------------------------------- whisper 后端选择（Windows 显卡） */
asrStatusOverride = JSON.parse(JSON.stringify(ASR));
asrStatusOverride.tools.platform = 'win32-x64';
asrStatusOverride.tools.whisper.available = false;
asrStatusOverride.tools.whisper.path = '';
installPlanValue = {
  platform: 'win32-x64',
    gpus: ['NVIDIA GeForce RTX 4070'],
    suggested: 'cuda-12.4',
    plan: [
      { id: 'ffmpeg', label: 'ffmpeg', method: 'download', bytes: 29000000, platform: 'win32-x64', hint: '', installed: true, detectedPath: 'C:/tools/ffmpeg.exe' },
      { id: 'ffprobe', label: 'ffprobe', method: 'download', bytes: 29000000, platform: 'win32-x64', hint: '', installed: true, detectedPath: 'C:/tools/ffprobe.exe' },
      { id: 'ytdlp', label: 'yt-dlp', method: 'download', bytes: 37000000, platform: 'win32-x64', hint: '', installed: true, detectedPath: 'C:/tools/yt-dlp.exe' },
      {
        id: 'whisper', label: 'whisper-cli', method: 'download', bytes: 8000000, platform: 'win32-x64', hint: '',
        installed: false, detectedPath: '', backend: 'auto', activeBackend: 'cuda-12.4',
        variants: [
          { id: 'cpu', label: 'CPU（AVX2 / AVX512）', asset: 'whisper-bin-x64.zip', bytes: 8000000, note: '所有机器都能用，速度最慢' },
          { id: 'cuda-12.4', label: 'NVIDIA CUDA 12.4', asset: 'whisper-bin-win-cuda-12.4.0-x64.zip', bytes: 250000000, note: '需要 NVIDIA 显卡与 CUDA 12.4 运行库' },
          { id: 'cuda-11.8', label: 'NVIDIA CUDA 11.8', asset: 'whisper-bin-win-cuda-11.8.0-x64.zip', bytes: 250000000, note: '老驱动/老 CUDA 环境选这个' },
        ],
      },
    { id: 'sherpa', label: 'sherpa-onnx', method: 'download', bytes: 240000000, platform: 'win32-x64', hint: '', installed: true, detectedPath: 'C:/tools/sherpa-onnx-offline.exe' },
  ],
};
installMode = 'ok';
if (!clickText(tree, '设置')) clickText(tree, 'Settings');
tree = await settle(40);
await recheckAsr();
const backendSelect = findAll(tree, (node) => node.__host === 'element' && node.tag === 'select'
  && String(node.props['aria-label'] || '').includes('whisper 后端'))[0];
check('whisper 后端下拉存在', Boolean(backendSelect));
check('后端下拉包含 CUDA 选项', Boolean(backendSelect) && nodeText(backendSelect).includes('NVIDIA CUDA 12.4'));
checkIncludes('显示检测到的显卡', asrBoxText(), 'NVIDIA GeForce RTX 4070');
checkIncludes('显示推荐后端', asrBoxText(), '推荐后端');
change(backendSelect, 'cuda-12.4');
tree = await settle(30);
check('切换 whisper 后端写入配置', String((lastCallOf('asr/config')?.body || {}).whisperBackend) === 'cuda-12.4');
const winInstallBtns = findAll(tree, (node) => node.__host === 'element' && node.tag === 'button' && nodeText(node) === '自动安装');
check('Windows 只给未装的 whisper 显示自动安装', winInstallBtns.length === 1);
click(winInstallBtns[0]);
tree = await settle(30);
const winInstallBody = lastCallOf('install')?.body || {};
check('安装 whisper 时带上后端', winInstallBody.id === 'whisper' && winInstallBody.backend === 'cuda-12.4');
if (!clickText(tree, '关闭')) clickText(tree, 'Close');
tree = await settle(30);
asrStatusOverride = null;
installPlanValue = null;

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
