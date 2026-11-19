/**
 * dsh-video host 半 · 多语言
 *
 * 面板的语言（中文 / English，或跟随 DSH 的任意 locale）会作为 `lang`
 * 参数随请求带上来；这一层负责把它规范化、拼成给模型的「用某种语言回答」
 * 指令，以及给出总结小节标题的对照表（面板按标题切卡片，必须两侧一致）。
 *
 * 约定：
 * - `zh` / `en` 是两种「完整支持」的语言：提示词模板、小节标题、面板文案都有；
 * - 其它语言（ja/es/fr/de/ru/pt…）沿用英文模板 + 明确的语言指令，模型会用
 *   目标语言输出；面板对这类语言退回纯 Markdown 渲染，不解析小节卡片。
 */

/** 支持的语言：DSH 内置 locale 全收，另外常见几门也认。 */
export const SUPPORTED_LANGS = [
  'zh',
  'en',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'ru',
  'pt',
  'it',
  'ar',
  'hi',
  'th',
  'vi',
  'id',
  'tr',
];

/** 语言自称（写进提示词，比语言代码更稳）。 */
export const LANG_NAMES = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
  it: 'Italiano',
  ar: 'العربية',
  hi: 'हिन्दी',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  tr: 'Türkçe',
};

/** 默认语言（请求没带 lang 时按中文，和历史行为一致）。 */
export const DEFAULT_LANG = 'zh';

/** `zh-CN` / `EN_us` / `ja-JP` → `zh` / `en` / `ja`；不认识的回落到 fallback。 */
export function normalizeLang(value, fallback = DEFAULT_LANG) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!raw) return fallback;
  const base = raw.split('-')[0];
  if (SUPPORTED_LANGS.includes(base)) return base;
  return fallback;
}

/** 语言的显示名。 */
export function langName(lang) {
  return LANG_NAMES[normalizeLang(lang)] ?? LANG_NAMES.en;
}

/** 给模型的「用某语言输出」指令（中文 / 英文两套说法，其它语言用英文句式）。 */
export function langInstruction(lang) {
  const id = normalizeLang(lang);
  if (id === 'zh') return '请用简体中文输出。';
  if (id === 'en') return 'Respond in English.';
  return `Respond entirely in ${langName(id)} (language code: ${id}).`;
}

/** 总结六个小节的标题；面板按它们切卡片，所以两边必须用同一张表。 */
export const SUMMARY_SECTION_TITLES = {
  zh: ['一句话总结', '核心观点', '内容脉络', '关键要点', '值得记住的说法', '适合谁看'],
  en: ['One-sentence summary', 'Key points', 'Outline', 'Key takeaways', 'Memorable quotes', 'Who should watch'],
};

/** 「继续追问」小节标题（模型输出后由 host 拆出来，不进入正文）。 */
export const FOLLOWUP_TITLE = {
  zh: '继续追问',
  en: 'Follow-up questions',
};

/** 是否属于「完整支持」的语言（有本地文案与小节标题）。 */
export function isFullLang(lang) {
  const id = normalizeLang(lang);
  return id === 'zh' || id === 'en';
}

/** 某个语言的小节标题（不支持的语言回落到英文，仅用于拼提示词）。 */
export function summarySections(lang) {
  return SUMMARY_SECTION_TITLES[normalizeLang(lang)] ?? SUMMARY_SECTION_TITLES.en;
}

/** 某个语言的「继续追问」标题。 */
export function followupTitle(lang) {
  return FOLLOWUP_TITLE[normalizeLang(lang)] ?? FOLLOWUP_TITLE.en;
}

/**
 * 语言相关的「结构提示」：用目标语言给出六节标题 + 继续追问标题。
 * 非中文语言模板是英文的，这里把它换成目标语言的标题（模型会照做）。
 */
export function outlineTitlesHint(lang) {
  const id = normalizeLang(lang);
  if (id === 'zh') return '';
  const titles = summarySections(id);
  return [
    `Use these section headings, translated into ${langName(id)}:`,
    titles.map((title, index) => `${index + 1}. ${title}`).join(' '),
    `and a final section "${FOLLOWUP_TITLE.en}" translated into ${langName(id)} holding 3 follow-up questions.`,
  ].join('\n');
}
