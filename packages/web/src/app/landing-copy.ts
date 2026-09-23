/**
 * landing-copy — 落地页**行内文案**的双语收编点（2026-09-22 中英切换批）。
 *
 * ★ 为什么单独这一个文件：列表类文案（动线/工程/隐私/词条去向）早在 09-22 重排批就进了
 *   `landing-data.ts`；剩下的散件（hero 标题、页脚、步骤、体验按钮、品牌副标、演示窗 chrome）
 *   此前写死在各组件体里。本批把它们全部搬来与 `Bi`（{zh,en}）配对——
 *   **组件里不再留任何中文字面量**，否则「漏掉一句」这种错没有任何东西会报。
 *   列表类留在 `landing-data.ts`（那里带逐条依据注释），这里只放散件，两边不重复。
 *
 * ★ `demo` 组是 §2.10 契约的落点：共享池警示语必须**两种语言都读得到**——
 *   警示对看不懂中文的英文访客失效，等于没警示。
 */
import type { Bi } from './landing-lang';
import { BRAND_TAGLINE as BRAND_TAGLINE_ZH } from '../lib/brand';

/**
 * 品牌副标：中文侧**仍是 `lib/brand` 那一个常量**（与产品侧栏逐字一致，单一事实源不动）；
 * EN 是落地页修辞，不进产品——登录后侧栏还是中文那句（范围决策，见 landing-lang 头注）。
 */
export const BRAND_TAGLINE: Bi = { zh: BRAND_TAGLINE_ZH, en: 'Your personal study copilot' };

export const TOP: { langTip: Bi; login: Bi; ghLogin: Bi } = {
  langTip: { zh: '切换语言', en: 'Switch language' },
  login: { zh: '登录', en: 'Sign in' },
  ghLogin: { zh: 'GitHub 登录', en: 'Sign in with GitHub' },
};

/** hero 标题拆三段（accent 那一截是 <span>，整句给不出高亮位置） */
export const HERO: {
  titlePre: Bi;
  titleAccent: Bi;
  sub: Bi;
  cta: Bi;
  ctaNote: Bi;
  statsAria: Bi;
} = {
  titlePre: { zh: '学过的词，会', en: 'What you learn' },
  titleAccent: { zh: '自己留下来', en: 'stays on its own' },
  sub: {
    zh: '自托管的 AI 学习助手。用你自己的模型 Key，数据在你自己的服务器。',
    en: 'A self-hosted AI study copilot. Bring your own model key — your data lives on your own server.',
  },
  cta: { zh: '开始使用', en: 'Get started' },
  ctaNote: { zh: '邮箱注册，一分钟开始', en: 'Email sign-up, about a minute' },
  statsAria: { zh: '项目数据', en: 'Project stats' },
};

/** ★ 数字与 `tools/metrics.mjs` 实测对账的纪律不变，两种语言同一组数（模板串按语言给） */
export const STATS: Array<{ n: string; label: Bi }> = [
  { n: '2600+', label: { zh: '自动化测试', en: 'automated tests' } },
  { n: '6', label: { zh: '个运行时依赖', en: 'runtime deps' } },
  { n: '150', label: { zh: '个 REST 接口', en: 'REST endpoints' } },
  { n: '0', label: { zh: '个第三方 UI 库', en: 'third-party UI libs' } },
];

export const AUTH: { or: Bi; ghBtn: Bi; ghHint: Bi } = {
  or: { zh: '或', en: 'or' },
  ghBtn: { zh: '使用 GitHub 登录', en: 'Continue with GitHub' },
  ghHint: {
    zh: 'GitHub 登录会新建独立账号，与你用邮箱注册的账号互不相通',
    en: 'GitHub sign-in creates a separate account, not linked to your email account',
  },
};

/** 公用体验入口（契约 §2.10）：警示语两语都在 ⇒ 对英文访客同样读得到 */
export const DEMO_BTN: { enter: Bi; busy: Bi; failed: Bi; warn: Bi } = {
  enter: { zh: '免注册，直接体验', en: 'Try it now — no sign-up' },
  busy: { zh: '进入中…', en: 'Entering…' },
  failed: { zh: '进入体验失败，请稍后重试', en: 'Failed to enter the demo — please try again later' },
  warn: {
    zh: '公用体验账号：内容全站共享、访客彼此可见，请勿输入个人信息',
    en: 'Shared demo account: everything here is visible to other visitors — please don’t enter personal info',
  },
};

export const INTRO: {
  eyebrowWhat: Bi;
  h2Pre: Bi;
  h2Mid: Bi;
  h2Tail: Bi;
  def: Bi;
  eyebrowCore: Bi;
  h3TermAria: Bi;
  h3Pre: Bi;
  h3Strong: Bi;
  h3Tail: Bi;
  lead: Bi;
} = {
  eyebrowWhat: { zh: '它是什么', en: 'What it is' },
  h2Pre: { zh: '一个', en: 'A ' },
  h2Mid: { zh: '自托管', en: 'self-hosted' },
  h2Tail: { zh: '的 AI 学习助手', en: ' AI study copilot' },
  def: {
    zh: '它把「学 → 练 → 析 → 忆 → 反馈」做成一条自动运转的闭环：你只管提问，讲解、出题、判分、复习排期、每日总结自己往下走。用你自己的模型 Key，数据在你自己的服务器。',
    en: 'It runs the loop for you — learn → practice → analyze → remember → feedback. Just ask questions; explaining, quiz-making, grading, review scheduling and daily summaries keep going on their own. Bring your own model key; your data stays on your server.',
  },
  eyebrowCore: { zh: '核心机制', en: 'Core mechanic' },
  h3TermAria: { zh: '词条是主体', en: 'Terms take center stage' },
  h3Pre: { zh: '一切都以', en: 'Everything is built around ' },
  h3Strong: { zh: '词条', en: 'terms' },
  h3Tail: { zh: '为主体', en: '' },
  lead: {
    zh: '上面那条闭环靠什么转起来？靠一份你自己的词条库——对话里学到的概念自动入库。一个词进了库，下面五件事会自己转起来：',
    en: 'What drives that loop? Your own term library — concepts learned in chat are filed automatically. Once a term is in, these five things start moving:',
  },
};

export const FEATURES: { aria: Bi; h2Pre: Bi; h2Mid: Bi; h2Tail: Bi; sub: Bi; boards: Bi; engAria: Bi; engH2Pre: Bi; engH2Mid: Bi; engSub: Bi } = {
  aria: { zh: '功能介绍', en: 'Features' },
  h2Pre: { zh: '它是', en: 'How it ' },
  h2Mid: { zh: '怎么运转', en: 'actually runs' },
  h2Tail: { zh: '的', en: '' },
  sub: {
    zh: '到这里你已经知道它是什么了。这一节按你上手后真实的先后顺序，一步一步走一遍——每一步底下挂的，是这一步里的一级功能入口。',
    en: 'Now you know what it is. This section walks it through in the real order you’ll meet it — each step lists the top-level features that live in it.',
  },
  boards: { zh: '动线是骨架，下面两屏是它跑起来的样子 ——', en: 'The route is the skeleton — below are two screens of it actually running —' },
  engAria: { zh: '工程品质', en: 'Engineering quality' },
  engH2Pre: { zh: '工程上', en: 'Where we sweat the ' },
  engH2Mid: { zh: '较真', en: 'engineering' },
  engSub: {
    zh: '差别不在于有没有接大模型，而在于闭环完整度、AI 输出可靠性、工程质量三层是否同时做实',
    en: 'The difference isn’t whether an LLM is wired in — it’s whether the loop is complete, AI output is dependable, and the engineering holds up. All three, at once.',
  },
};

export const GITHUB_BAND: { aria: Bi; title: Bi; notePre: Bi; noteMid: Bi; noteTail: Bi } = {
  aria: { zh: '开源仓库与本地版', en: 'Open-source repo and local edition' },
  title: { zh: '本项目完全开源', en: 'This project is fully open source' },
  notePre: { zh: '更加完整的体验在', en: 'The fuller experience is in the ' },
  noteMid: { zh: '本地安装包版', en: 'local install edition' },
  noteTail: { zh: '，欢迎体验 →', en: ' — try it →' },
};

export const PRIVACY: { aria: Bi; h2Pre: Bi; h2Mid: Bi; ctaTitle: Bi; cta: Bi } = {
  aria: { zh: '隐私与数据', en: 'Privacy & data' },
  h2Pre: { zh: '隐私与', en: 'Privacy & ' },
  h2Mid: { zh: '数据自持', en: 'own your data' },
  ctaTitle: { zh: '一分钟开始', en: 'Start in a minute' },
  cta: { zh: '免费注册', en: 'Sign up free' },
};

export const STEPS: { aria: Bi; items: Bi[] } = {
  aria: { zh: '开始步骤', en: 'Getting started' },
  items: [
    { zh: '邮箱注册账号', en: 'Sign up with email' },
    { zh: '设置页绑定自己的模型 Key', en: 'Bind your own model key in Settings' },
    { zh: '提问、出题、复习，闭环开始转', en: 'Ask, get quizzed, review — the loop starts turning' },
  ],
};

export const FOOT: Bi = { zh: '本地优先 · 数据自持 · © 2026 studentbuddy', en: 'Local-first · Own your data · © 2026 studentbuddy' };

/**
 * 页脚的公开词条入口（构建期静态页，地址从 `seo/term-corpus` 的 CATALOG_PATH 来）。
 * ★ 英文侧写明 Chinese only：词条页目前只有中文一套（SEO-SPEC §6 的未做项），
 *   英文标签配中文页面等于承诺了一个不存在的东西。
 */
export const FOOT_TERMS: Bi = { zh: '学习科学词条', en: 'Glossary (Chinese only)' };

/** 演示窗外壳 chrome（帧内容各自在 registry / demo 数据文件里双语） */
export const DEMO_WINDOW: { replay: Bi } = { replay: { zh: '重播', en: 'Replay' } };

/** 落地状态角标：与 README 的标注口径一致，两节旅程（词条 / 对战）共用同一份措辞 */
export const LAND_TAG: { shipped: Bi; partial: Bi } = {
  shipped: { zh: '已落地', en: 'Shipped' },
  partial: { zh: '部分落地', en: 'Partly shipped' },
};
