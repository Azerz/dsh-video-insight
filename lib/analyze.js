/**
 * dsh-video host 半 · 分析流水线
 *
 * 面板只负责展示，真正「像 BibiGPT 一样」的总结、章节、追问都在这里：
 * 用 profile 里已经配好的默认模型（agentDefaultModel）走 `ctx.llm.stream()`，
 * 不需要用户再填一个 API key。
 */

import {
  VideoError,
  formatClock,
  renderTimestamped,
  sampleSegments,
} from './util.js';
import { citationsOf, formatRetrieval, searchChunks } from './rag.js';

const MAX_TRANSCRIPT_CHARS = 48000;

/**
 * 面板分析用的会话路由键。opencode-go 这类 provider 要求 `x-opencode-session`
 * 头，缺了直接 400 MissingSessionID；这里没有真实对话 Session，就固定一个键。
 */
const PANEL_SESSION = 'dsh-video-panel';

/** 模型写出的固定小标题，面板按它切段落做锚点导航。 */
export const SUMMARY_SECTIONS = [
  '一句话总结',
  '核心观点',
  '内容脉络',
  '关键要点',
  '值得记住的说法',
  '适合谁看',
];

export const SUMMARY_SYSTEM = [
  '你是一位视频内容分析师。用户会给你一个视频的元信息与字幕（可能带 [mm:ss] 时间戳）。',
  '你的任务是写一份中文（简体）的结构化总结，像给朋友做「看之前的 3 分钟预读」：准确、具体、不注水。',
  '',
  '硬性要求：',
  '1. 只依据给出的标题、简介和字幕，绝不补充其中没有出现的事实、数字、人名。',
  '2. 字幕里没有的内容（比如画面、演示）不要编造。信息不足时直接写明「字幕中未提及」。',
  '3. 引用时间戳时必须来自字幕里的 [mm:ss]，不要自己算。',
  '4. 不要复述整段字幕，用你自己的话提炼。',
  '5. 输出 Markdown，严格使用下面七个小标题，顺序不变，不要加一级标题、不要加代码块：',
  '',
  '## 一句话总结',
  '（一句话讲清这期视频到底在说什么，不超过 60 字）',
  '## 核心观点',
  '（3-5 条，每条一行，短句开头加「-」）',
  '## 内容脉络',
  '（按时间顺序 4-8 条，每条格式：`- [mm:ss] 这段讲了什么`）',
  '## 关键要点',
  '（4-6 条可以带走的结论、方法或数据，每条用「1.」编号）',
  '## 值得记住的说法',
  '（1-3 句原话，带 [mm:ss]；没有值得摘录的原话就写「字幕中没有特别出彩的原句」）',
  '## 适合谁看',
  '（1-2 句：什么人值得看，什么情况下可以直接跳过）',
  '## 继续追问',
  '（3 条用户看完这期视频后最可能追问的问题，每条一行、以「- 」开头，每条不超过 30 字；必须是只针对本期内容才成立的具体问题，不要「还有其他要点吗」这类放到任何视频都成立的泛问）',
  '',
  '全文 600-1000 字，不要写「本期视频」「up主」之外的套话。',
].join('\n');

const ASK_SYSTEM = [
  '你是一位视频内容助手，正在陪用户看一个视频。系统会先从字幕里检索出与问题最相关的段落给你（每条带 [mm:ss] 起止时间），',
  '再附上视频标题、简介和之前的对话。',
  '',
  '回答规则：',
  '1. 优先依据「检索到的字幕段落」回答；只依据这些段落与简介，不要用你自己的知识补充视频里没讲的内容。',
  '2. 每个关键结论后面用 [mm:ss] 标注它出自哪段，方便用户跳回去看；同一个点别重复标注。',
  '3. 检索到的段落不足以回答时，直接说「视频里没有提到」，并指出最接近的相关段落；不要硬编。',
  '4. 中文（简体），先给结论再展开，3-8 句为宜；需要对比或步骤时才用列表。',
  '5. 回答里不要复述问题，也不要解释「我是怎么检索的」。',
].join('\n');

const CHAPTERS_SYSTEM = [
  '你是一位视频内容编辑，任务是把视频字幕切成分段章节。',
  '只输出一个 JSON 数组，不要 Markdown、不要代码块、不要解释。',
  '数组每一项：{"start": 秒数(整数), "title": "章节名(不超过 18 字)", "gist": "一句话讲这节说了什么(不超过 40 字)"}。',
  '要求：按时间升序；第一项 start 为 0；6-12 项；start 必须落在视频时长范围内；章节名要具体，不要「第一部分」这种废话。',
].join('\n');

/* -------------------------------- 选模型 --------------------------------- */

/** 行配置里的固定模型优先，否则跟用户当前的默认模型走。 */
export function currentRoute(ctx, config) {
  const provider = String(config?.provider ?? '').trim();
  const model = String(config?.model ?? '').trim();
  if (provider && model) return { provider, model };
  try {
    const selection = ctx?.agentDefaultModel?.currentSelection?.();
    if (selection?.provider && selection?.model) {
      return { provider: String(selection.provider), model: String(selection.model) };
    }
  } catch {
    // 服务缺席或选择为空：交给调用方报错。
  }
  return null;
}

/* -------------------------------- 拼 prompt ------------------------------- */

function metaBlock(doc) {
  const lines = [
    `标题：${doc.title || '(无标题)'}`,
    `作者：${doc.author || '(未知)'}`,
    `平台：${doc.platform === 'youtube' ? 'YouTube' : '哔哩哔哩'}`,
    doc.duration ? `时长：${formatClock(doc.duration)}` : '',
    doc.stats?.views ? `播放量：${doc.stats.views}` : '',
    doc.publishedAt ? `发布日期：${doc.publishedAt.slice(0, 10)}` : '',
  ].filter(Boolean);

  const description = String(doc.description ?? '').trim();
  if (description) lines.push('', '【视频简介】', description.slice(0, 2000));

  const pageTitles = (doc.pages ?? []).map((page) => page.title).filter(Boolean);
  if (pageTitles.length > 1) {
    lines.push('', '【分P标题】', pageTitles.slice(0, 40).map((title, index) => `P${index + 1}: ${title}`).join('\n'));
  }

  const official = doc.officialSummary;
  if (official?.summary) {
    lines.push('', '【B 站官方 AI 摘要（仅供参考）】', official.summary.slice(0, 1200));
    for (const item of (official.outline ?? []).slice(0, 12)) {
      lines.push(`- ${formatClock(item.start ?? 0)} ${item.title}`);
    }
  }

  const chapters = (doc.officialChapters ?? []);
  if (chapters.length > 0 && !official?.outline?.length) {
    lines.push('', '【作者标注的章节】', chapters.slice(0, 40).map((item) => `- ${formatClock(item.start ?? 0)} ${item.title}`).join('\n'));
  }

  return lines.join('\n');
}

function transcriptBlock(doc, budget = MAX_TRANSCRIPT_CHARS) {
  const transcript = doc.transcript;
  if (!transcript?.available || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    return [
      '【字幕】',
      '（这个视频没有可用字幕。只能基于上面的标题、简介与章节信息总结，',
      '并在总结里明确提示「内容依据不足，建议以原视频为准」；不要编造视频里的具体说法。）',
    ].join('\n');
  }
  const segments = sampleSegments(transcript.segments, budget);
  return [
    `【字幕】来源：${transcript.source}，语言：${transcript.lang || '未知'}，共 ${transcript.chars} 字`,
    renderTimestamped(segments, { budget }),
  ].join('\n');
}

/** 总结用 prompt：元信息 + 字幕（超长自动采样）。 */
export function buildSummaryPrompt(doc, config) {
  const budget = Math.min(
    Math.max(Number(config?.transcriptLimitChars) || 60000, 4000),
    MAX_TRANSCRIPT_CHARS,
  );
  return [
    metaBlock(doc),
    '',
    transcriptBlock(doc, budget),
    '',
    '请按系统提示里的六个小标题，写这份中文总结。',
  ].join('\n');
}

/** 追问用 prompt：历史对话拼成文本（不依赖多轮消息，避免 message id 约束）。 */
export function buildAskPrompt(doc, question, history, config, retrieved = []) {
  const budget = Math.min(
    Math.max(Number(config?.transcriptLimitChars) || 60000, 4000),
    MAX_TRANSCRIPT_CHARS,
  );
  const turns = Array.isArray(history) ? history.slice(-6) : [];
  const historyText = turns
    .filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim())
    .map((turn) => `${turn.role === 'assistant' ? '助手' : '用户'}：${turn.text.trim().slice(0, 1200)}`)
    .join('\n');

  const passages = formatRetrieval(retrieved);
  const parts = [metaBlock(doc), ''];
  if (passages) {
    parts.push('【从字幕中检索到的相关段落】', passages, '');
  } else if (doc.transcript?.available) {
    const chars = Number(doc.transcript.chars) || 0;
    if (chars <= 16000) {
      parts.push(transcriptBlock(doc, budget), '');
    } else {
      parts.push(
        '【检索结果】没有从字幕里检索到与问题直接相关的段落。请只依据标题与简介做概括性回答，',
        '并明确告诉用户「视频里没有明显提到这个问题」。',
        '',
      );
    }
  } else {
    parts.push(transcriptBlock(doc, budget), '');
  }
  if (historyText) parts.push('【之前的对话】', historyText, '');
  parts.push('【用户的问题】', String(question ?? '').trim() || '（空）');
  return parts.join('\n');
}

/** 检索用的查询词：短追问（「那后来呢？」）把上一轮问题拼进来，避免指代丢失。 */
function buildRetrievalQuery(question, history) {
  const current = String(question ?? '').trim();
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== 'user') continue;
    const previous = String(turn.text ?? '').trim();
    if (current.length >= 10 || !previous) return current;
    return `${previous} ${current}`.trim();
  }
  return current;
}

/** 章节用 prompt：不喂全文，给「等距抽样 + 官方章节」，省 token。 */
export function buildChaptersPrompt(doc) {
  const duration = Number(doc.duration) || 0;
  const segments = doc.transcript?.available ? sampleSegments(doc.transcript.segments, 16000) : [];
  const chapters = (doc.officialChapters ?? []).length > 0
    ? doc.officialChapters
    : (doc.officialSummary?.outline ?? []);
  const parts = [
    metaBlock(doc),
    '',
    `【视频时长】${duration ? formatClock(duration) : '未知'}（${duration} 秒）`,
  ];
  if (chapters.length > 0) {
    parts.push('', '【已有的章节切分（可参考、可改写）】', chapters.map((item) => `- ${formatClock(item.start ?? 0)} ${item.title}`).join('\n'));
  }
  if (segments.length > 0) {
    parts.push('', '【字幕节选（按时间顺序抽样）】', renderTimestamped(segments, { budget: 16000 }));
  } else {
    parts.push('', '【注意】没有字幕，请只依据标题、简介与已有章节，给出粗粒度的时间划段。');
  }
  parts.push('', '请输出 JSON 章节数组。');
  return parts.join('\n');
}

/* -------------------------------- 调用模型 ------------------------------- */

/**
 * 流式调用一次模型，边收边交给 onDelta。
 * @returns {Promise<{text:string, usage:object|null, finish:object|null}>}
 */
export async function streamCompletion(ctx, route, { system, prompt, maxTokens = 2000, signal, onDelta }) {
  if (!route?.provider || !route?.model) {
    throw new VideoError('no-model', '还没有可用的默认模型：请先在设置里选一个模型，再回来分析。');
  }
  if (!ctx?.llm?.stream) {
    throw new VideoError('no-model', '当前 profile 没有挂载 LLM 服务，无法分析。');
  }

  let text = '';
  let usage = null;
  let finish = null;

  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    // 有些 provider（例如 opencode-go）要求每个请求带会话路由键，否则 400
    // `MissingSessionID`。面板分析没有真实的对话 session，就固定用这个键：
    // 同一插件实例的所有总结/追问共享一条 affinity，缓存命中率更好。
    sessionId: route.sessionId || PANEL_SESSION,
    ...(signal ? { signal } : {}),
  };

  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk?.type === 'text-delta') {
        text += chunk.text;
        if (chunk.text) onDelta?.(chunk.text);
      } else if (chunk?.type === 'usage') {
        usage = chunk.usage ?? usage;
      } else if (chunk?.type === 'finish') {
        finish = chunk.reason ?? null;
      }
    }
  } catch (error) {
    throw new VideoError('llm-failed', `模型调用失败：${error?.message ?? error}`);
  }

  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure ?? {};
    throw new VideoError(
      finish.kind === 'aborted' ? 'aborted' : 'llm-failed',
      `模型调用失败：${failure.message ?? '未知错误'}${failure.code ? `（${failure.code}）` : ''}`,
    );
  }
  if (!text.trim()) {
    throw new VideoError('llm-empty', '模型没有返回任何内容，稍后再试一次。');
  }
  return { text, usage, finish };
}

const SUGGEST_HEADING = /^#{1,6}\s*(继续追问|值得追问|建议追问)\s*$/;

/**
 * 把总结末尾的「继续追问」小节拆出来。
 * 面板把这三条渲染成可点的建议问题，所以正文里不再保留这一节；
 * 模型没按要求写这一节时，suggestions 为空数组，界面只用固定示例兜底。
 * @returns {{text:string, suggestions:string[]}}
 */
export function splitSummarySuggestions(markdown) {
  const raw = String(markdown ?? '');
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => SUGGEST_HEADING.test(line.trim()));
  if (start < 0) return { text: raw.trim(), suggestions: [] };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s*\S/.test(lines[index].trim())) { end = index; break; }
  }
  const suggestions = [];
  for (const line of lines.slice(start + 1, end)) {
    const item = line.replace(/^\s*(?:[-*+]|\d+[.、)])\s*/, '').trim();
    if (!item) continue;
    const question = item.replace(/^["「]|["」]$/g, '').trim();
    if (question.length < 4 || question.length > 60) continue;
    if (suggestions.includes(question)) continue;
    suggestions.push(question);
    if (suggestions.length >= 3) break;
  }
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: rest || raw.trim(), suggestions };
}

/** 总结：返回完整 Markdown（已去掉「继续追问」小节）+ 三条建议追问。 */
export async function runSummary(ctx, config, doc, { signal, onDelta } = {}) {
  const route = currentRoute(ctx, config);
  const result = await streamCompletion(ctx, route, {
    system: SUMMARY_SYSTEM,
    prompt: buildSummaryPrompt(doc, config),
    maxTokens: 2400,
    signal,
    onDelta,
  });
  const { text, suggestions } = splitSummarySuggestions(result.text);
  return { ...result, text, suggestions };
}

/**
 * 追问（RAG：检索增强生成）。
 * 先从转写稿里召回相关段落，只把这几段连同元信息喂给模型，
 * 再把召回段落作为 `citations` 返回给面板做「依据」跳转。
 */
export async function runAsk(ctx, config, doc, { question, history, signal, onDelta } = {}) {
  const route = currentRoute(ctx, config);
  const retrieved = searchChunks(doc, buildRetrievalQuery(question, history), { limit: 8 });
  const result = await streamCompletion(ctx, route, {
    system: ASK_SYSTEM,
    prompt: buildAskPrompt(doc, question, history, config, retrieved),
    maxTokens: 1600,
    signal,
    onDelta,
  });
  return { ...result, citations: citationsOf(retrieved) };
}

/** 把模型返回的章节 JSON 解析成结构化数组；解析失败给空数组，由面板决定降级。 */
export function parseChapters(rawText, duration) {
  const text = String(rawText ?? '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const limit = Number(duration) > 0 ? Number(duration) : Number.MAX_SAFE_INTEGER;
  const chapters = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const startSeconds = Number(item.start);
    const title = String(item.title ?? '').trim();
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !title) continue;
    chapters.push({
      start: Math.min(Math.round(startSeconds), Math.floor(limit)),
      title: title.slice(0, 40),
      gist: String(item.gist ?? '').trim().slice(0, 120),
    });
  }
  const seen = new Set();
  return chapters
    .sort((a, b) => a.start - b.start)
    .filter((chapter) => {
      const key = `${chapter.start}:${chapter.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16);
}

/** 章节：调用模型并用 parseChapters 收敛。 */
export async function runChapters(ctx, config, doc, { signal } = {}) {
  const route = currentRoute(ctx, config);
  const { text } = await streamCompletion(ctx, route, {
    system: CHAPTERS_SYSTEM,
    prompt: buildChaptersPrompt(doc),
    maxTokens: 1100,
    signal,
  });
  return { chapters: parseChapters(text, doc.duration), raw: text };
}
