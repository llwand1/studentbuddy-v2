/**
 * landing-copy — 落地页**行内文案**的双语收编点（2026-09-22 中英切换）。
 *
 * ★ 为什么单独这一个文件：列表类文案（动线/工程/隐私/词条去向）早在 09-22 重排时就进了
 *   `landing-data.ts`；剩下的散件（hero 标题、页脚、步骤、体验按钮、品牌副标、演示窗 chrome）
 *   此前写死在各组件体里。本次把它们全部搬来与 `Bi`（{zh,en}）配对——
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
export const BRAND_TAGLINE: Bi = { zh: BRAND_TAGLINE_ZH, en: 'A gamified knowledge learning agent' };

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
  titlePre: { zh: '把词条化为力量，', en: 'Turn knowledge into power. ' },
  titleAccent: { zh: '向遗忘的怪物宣战', en: 'Face the monsters of forgetting.' },
  sub: {
    zh: '一个游戏化知识学习 Agent。你是能把知识词条化为力量的勇者：和 AI 把问题聊明白，词条就成了你的武器；遗忘化作怪物侵占大陆，用理解击败它们、收复地块、收集卡牌。',
    en: 'A gamified knowledge learning agent. You are a hero who turns terms into power: work through questions with AI and every term becomes a weapon; when forgetting spawns monsters on the continent, defeat them with understanding, reclaim land and collect cards.',
  },
  cta: { zh: '开始使用', en: 'Get started' },
  ctaNote: { zh: '从你感兴趣的一个问题开始', en: 'Bring a question you care about' },
  statsAria: { zh: '探索方式', en: 'Ways to explore' },
};

/** 首屏用玩法标签说明体验，工程指标留在仓库的自动对账页。 */
export const HERO_TAGS: Bi[] = [
  { zh: '词条即武器', en: 'Terms as weapons' },
  { zh: '知识大陆', en: 'Knowledge continent' },
  { zh: '暗黑像素', en: 'Dark pixel art' },
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
  h2Mid: { zh: '游戏化知识学习', en: 'gamified knowledge learning' },
  h2Tail: { zh: ' Agent', en: ' agent' },
  def: {
    zh: '好奇心是起点，知识大陆是你反复回来的地方。AI 帮你查资料、讲原理、出练习；你在像素世界里探索、复习，把一次次理解留下来。可以在线体验，也可以自带模型 Key，在本地或自己的服务器运行。',
    en: 'Curiosity is the starting point; your knowledge continent is a place to return to. AI helps research, explain and create practice. Explore and revisit ideas in a pixel world. Try it online, or bring your own model key and run it locally or on your server.',
  },
  eyebrowCore: { zh: '核心机制', en: 'Core mechanic' },
  h3TermAria: { zh: '词条是主体', en: 'Terms take center stage' },
  h3Pre: { zh: '一切都以', en: 'Everything is built around ' },
  h3Strong: { zh: '词条', en: 'terms' },
  h3Tail: { zh: '为主体', en: '' },
  lead: {
    zh: '大陆上的知识来自你的学习。对话中留下的概念成为词条，词条再连接地块、复习与对战。探索有了内容，答题也有了来处。',
    en: 'Your learning supplies the world. Concepts from conversations become terms that connect map tiles, review and battles. Exploration has substance, and every challenge has a starting point.',
  },
};

export const FEATURES: { aria: Bi; h2Pre: Bi; h2Mid: Bi; h2Tail: Bi; sub: Bi; boards: Bi; engAria: Bi; engH2Pre: Bi; engH2Mid: Bi; engSub: Bi } = {
  aria: { zh: '功能介绍', en: 'Features' },
  h2Pre: { zh: '它是', en: 'How it ' },
  h2Mid: { zh: '怎么运转', en: 'actually runs' },
  h2Tail: { zh: '的', en: '' },
  sub: {
    zh: '提一个问题，弄懂一个概念，再到大陆上检验理解。对话、练习、词条和对战，围绕同一份知识接着往下走。',
    en: 'Ask a question, understand an idea, then test it on the continent. Chat, practice, terms and battles build on the same knowledge.',
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

/**
 * 页脚的公开更新记录入口（构建期静态页，地址从 `seo/paths` 的 `CHANGELOG_PATH` 来）。
 * ★ 与上面那条同一口径：更新页目前只有中文一套，英文标签如实写明，不许诺不存在的语言。
 */
export const FOOT_CHANGELOG: Bi = { zh: '更新记录', en: 'Changelog (Chinese only)' };

/** 演示窗外壳 chrome（帧内容各自在 registry / demo 数据文件里双语） */
export const DEMO_WINDOW: { replay: Bi } = { replay: { zh: '重播', en: 'Replay' } };

/** 落地状态角标：与 README 的标注口径一致，两节旅程（词条 / 对战）共用同一份措辞 */
export const LAND_TAG: { shipped: Bi; partial: Bi } = {
  shipped: { zh: '已落地', en: 'Shipped' },
  partial: { zh: '部分落地', en: 'Partly shipped' },
};
