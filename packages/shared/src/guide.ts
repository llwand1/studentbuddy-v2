/**
 * shared/guide — 「下一步引导（引路灯）」的**纯口径**（契约 `docs/GUIDE-SPEC.md`）。
 *
 * 场景：用户不知道下一步该干什么——第一次打开、聊完一段、做完一组题、或者只是迷了路。
 * 左上角的提灯把「此刻最合适的 2–4 个下一步」摆出来，由 AI 现挑并写文案，点一下就执行。
 *
 * ★ 分工（本文件的全部意义）：**「现在处在哪个时刻」「哪些动作此刻能选」由代码判，「挑哪几个、怎么说、聊什么话题」由 AI 定。**
 *   前者确定、可测；后者灵活、可能出错——所以模型的输出必须过 `normalizeGuideReply` 才能上屏，
 *   而且必备项（第一次＝随机话题、聊完＝出题、做完题＝一键解析）缺了由代码补，不靠模型自觉。
 * ★ 为什么放 shared：服务端用它校验模型输出、兜底出规则推荐；前端用它在等 AI 的那几百毫秒里**立刻**摆出规则推荐，
 *   两边必须是同一份阶段口径与同一份文案，否则「先看到一份、AI 回来又换一份」会让人觉得界面在抖。
 * ★ 动作是闭集（`GUIDE_KINDS`）：模型只能从白名单里挑，白名单外的 kind 一律丢弃；
 *   只有 `chat.topic` / `chat.ask` 带一句自由文本，且那句话会**以用户身份发出去**——界面必须在点之前让人看见它。
 * ★ 纯函数、零 IO、不读时钟：随机只来自调用方传的 `seed`，测试可复现。
 */

import type { PomodoroFocus } from './pomodoro.js';

export type GuideLang = 'zh' | 'en';

/** 一条文案的两种语言（与 web 侧 `Bi` 同形，shared 不依赖 web，故在此重述） */
export interface GuideText {
  zh: string;
  en: string;
}

/** 提灯挂在应用壳里，能感知的四个视图（与 web `View` 同名同序；卡牌已并入词条页，不再是独立视图） */
export const GUIDE_VIEWS = ['chat', 'terms', 'continent', 'settings'] as const;
export type GuideView = (typeof GUIDE_VIEWS)[number];

/** 动作白名单（闭集）。新增一种动作＝这里加一行 + 目录补文案 + 某个组件注册处理器 */
export const GUIDE_KINDS = [
  'chat.topic',
  'chat.ask',
  'chat.remember',
  'chat.videos',
  'session.new',
  'quiz.start',
  'quiz.scenario',
  'quiz.explain',
  'quiz.retry',
  'nav.terms',
  'nav.continent',
  'nav.pk',
  'nav.settings',
] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];

export function isGuideKind(v: unknown): v is GuideKind {
  return typeof v === 'string' && (GUIDE_KINDS as readonly string[]).includes(v);
}

/** 带自由文本的动作（文本会以用户身份发出去） */
export const GUIDE_TEXT_KINDS: readonly GuideKind[] = ['chat.topic', 'chat.ask'];

/** 阶段：`guideStage` 的输出 */
export type GuideStage = 'nomodel' | 'tour' | 'busy' | 'quizzed' | 'fresh' | 'chatted';

// ── 尺寸口径（校验器与界面共用） ─────────────────────────────────────────────
export const GUIDE_MAX_ITEMS = 4;
export const GUIDE_LABEL_MIN = 2;
/**
 * 三类短文案的字符上限，**按语言分开**：同一句话英文天然比中文长两三倍，共用一个上限会把英文标签硬截成
 * 「Chat about somethi」。中文那一档是界面的真实空间（弹层一行放得下）；英文一档按同等视觉宽度放宽。
 */
export const GUIDE_LIMITS: Record<GuideLang, { label: number; hint: number; headline: number }> = {
  zh: { label: 18, hint: 60, headline: 40 },
  en: { label: 32, hint: 100, headline: 80 },
};
export const GUIDE_TEXT_MIN = 4;
export const GUIDE_TEXT_MAX = 120;
/** 请求里 `can` 的条数上限（白名单只有 13 种，留点余量给以后加） */
export const GUIDE_CAN_MAX = 20;
/** 同一种带文本动作最多出现几条（话题 / 追问各给用户两个选择就够，再多是噪音） */
export const GUIDE_TEXT_KIND_QUOTA = 2;

// ── 目录：每种动作的默认文案 ───────────────────────────────────────────────
export type GuideGroup = 'chat' | 'quiz' | 'go';

export const GUIDE_GROUPS: Record<GuideGroup, GuideText> = {
  chat: { zh: '对话', en: 'Chat' },
  quiz: { zh: '练习', en: 'Practice' },
  go: { zh: '去哪儿', en: 'Go to' },
};

export interface GuideKindInfo {
  group: GuideGroup;
  label: GuideText;
  hint: GuideText;
  /** 此刻做不了时的一句「怎么解锁」（「全部功能」里灰着的那几行） */
  need: GuideText;
  /** 带文本动作的兜底文本（模型没给 / 给得不合格时用） */
  text?: GuideText;
}

export const GUIDE_CATALOG: Record<GuideKind, GuideKindInfo> = {
  'chat.topic': {
    group: 'chat',
    label: { zh: '随机聊个话题', en: 'Chat about something random' },
    hint: { zh: '让 AI 现想一个有意思的话题，点了直接开聊', en: 'AI picks a fun topic and starts talking right away' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'chat.ask': {
    group: 'chat',
    label: { zh: '追问一下', en: 'Ask a follow-up' },
    hint: { zh: '顺着刚才的内容再深挖一层', en: 'Dig one level deeper into what we just covered' },
    need: { zh: '先和 AI 聊一轮再来', en: 'Chat with AI for a round first' },
    text: { zh: '再用一个生活里的例子，把刚才的内容讲一遍', en: 'Explain what we just covered again with an everyday example' },
  },
  'chat.remember': {
    group: 'chat',
    label: { zh: '存入记忆', en: 'Save to memory' },
    hint: { zh: '把刚才的重要术语收进词条库，以后会来复习', en: 'Keep the key terms in your library for later review' },
    need: { zh: '先聊一轮再来', en: 'Chat for a round first' },
  },
  'chat.videos': {
    group: 'chat',
    label: { zh: '找讲解视频', en: 'Find videos' },
    hint: { zh: '去 B站 / 抖音搜这个知识点的讲解', en: 'Search Bilibili / Douyin for explainers on this' },
    need: { zh: '先让 AI 回答一次', en: 'Let AI answer once first' },
  },
  'session.new': {
    group: 'chat',
    label: { zh: '开一场新对话', en: 'Start a new chat' },
    hint: { zh: '换个话题，从头聊', en: 'New topic, clean slate' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'quiz.start': {
    group: 'quiz',
    label: { zh: '来一套题', en: 'Quiz me' },
    hint: { zh: '基于刚才的对话出题，当场判分', en: 'Questions from this chat, graded on the spot' },
    need: { zh: '先聊一轮，题才有得出', en: 'Chat for a round so there is something to quiz on' },
  },
  'quiz.scenario': {
    group: 'quiz',
    label: { zh: '出道情景题', en: 'Try a scenario task' },
    hint: { zh: '在可交互的小场景里动手做', en: 'Hands-on in an interactive mini-scenario' },
    need: { zh: '先聊一轮，题才有得出', en: 'Chat for a round so there is something to quiz on' },
  },
  'quiz.explain': {
    group: 'quiz',
    label: { zh: '一键解析', en: 'Explain my answers' },
    hint: { zh: '结合你的作答，图文讲清每道题', en: 'Illustrated walk-through based on your answers' },
    // ★ 灰着有三种原因：没做完 / 正在生成 / 已经生成（生成后这一项就撤销了，讲解留在那组题下方）。
    //   所以这句不能只写「先做完」——对做完了、也看过讲解的人是误导；两半都得说清：怎么解锁 + 之后去哪看。
    need: { zh: '做完一组题后可用；讲解生成后留在这组题下方', en: 'Available once a set is finished; the walkthrough then stays below that set' },
  },
  'quiz.retry': {
    group: 'quiz',
    label: { zh: '再练一遍', en: 'Practice again' },
    hint: { zh: '清空作答，重做这一组', en: 'Reset answers and redo this set' },
    need: { zh: '先把一组题做完', en: 'Finish a question set first' },
  },
  'nav.terms': {
    group: 'go',
    label: { zh: '翻翻词条库', en: 'Open your terms' },
    hint: { zh: 'AI 在对话里替你记下的术语都在这', en: 'Every term AI saved for you lives here' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.continent': {
    group: 'go',
    label: { zh: '去知识大陆', en: 'Visit the Continent' },
    hint: { zh: '到期的词条是怪物，复习就是收复', en: 'Due terms are monsters; reviewing wins the land back' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.pk': {
    group: 'go',
    label: { zh: '去对战', en: 'Battle arena' },
    hint: { zh: '和 AI 或朋友在答题擂台上 PK', en: 'Quiz duel against AI or a friend' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.settings': {
    group: 'go',
    label: { zh: '去设置', en: 'Open settings' },
    hint: { zh: '绑定模型、调回答方式与出题偏好', en: 'Bind a model, tune answer style and quiz mix' },
    need: { zh: '随时可用', en: 'Always available' },
  },
};

/** 各阶段提灯开口那一句（弹层标题下那行；规则推荐用它，AI 推荐会自己写一句） */
export const GUIDE_HEADLINES: Record<GuideStage | 'nomodelHere', GuideText> = {
  nomodel: { zh: '还没有可用的模型，先去设置绑一个', en: 'No model yet — bind one in Settings first' },
  nomodelHere: { zh: '在这页绑一个模型（或点「一键默认设置」），我就能指路了', en: 'Bind a model on this page (or use one-click defaults) and I can help' },
  tour: { zh: '想换个地方逛逛，还是回去聊点什么？', en: 'Look around, or head back to chat?' },
  busy: { zh: 'AI 正在回答，答完我再给你指路', en: "AI is answering — I'll point the way once it's done" },
  quizzed: { zh: '这组做完了，把原理看明白吧', en: "Set finished — let's make sure it really clicks" },
  fresh: { zh: '不知道从哪开始？我帮你起个头', en: "Not sure where to start? I'll get you going" },
  chatted: { zh: '聊得差不多了，来检验一下？', en: 'Nice chat — want to test what stuck?' },
};

/** 亮灯时冒在图标下的短提示（宽屏才显示；很短，宽度只有提灯下方那一小块） */
export const GUIDE_TEASERS: Partial<Record<GuideStage, GuideText>> = {
  nomodel: { zh: '先绑个模型', en: 'Bind a model' },
  fresh: { zh: '不知聊啥？点我', en: 'Need a topic?' },
  chatted: { zh: '来套题检验下？', en: 'Quiz time?' },
  quizzed: { zh: '做完了，看解析', en: 'See the walkthrough' },
};

export function guideTeaser(stage: GuideStage, lang: GuideLang): string | null {
  return GUIDE_TEASERS[stage]?.[lang] ?? null;
}

/** 内置的随机话题（规则推荐用；AI 推荐时由模型现想一个）。每条本身就是一句能直接发出去的话 */
export const GUIDE_TOPICS: readonly GuideText[] = [
  { zh: '用一个生活里的例子，讲讲什么是「复利」', en: 'Use an everyday example to explain compound interest' },
  { zh: '为什么天空是蓝色的？用最直白的话讲给我听', en: 'Why is the sky blue? Explain it in plain words' },
  { zh: '教我一个五分钟就能学会的学习方法', en: 'Teach me a study technique I can learn in five minutes' },
  { zh: '讲一个你觉得最反直觉的科学事实，并解释为什么', en: "Tell me the most counter-intuitive science fact you know, and why it's true" },
  { zh: '什么是费曼学习法？怎么用它学一个新概念？', en: 'What is the Feynman technique, and how do I use it on a new concept?' },
  { zh: '随便挑一个计算机基础概念，用比喻讲给我听', en: 'Pick a basic computer-science idea and explain it with a metaphor' },
  { zh: '挑一个改变了世界的小发明，讲讲它的故事', en: 'Pick one small invention that changed the world and tell its story' },
  { zh: '为什么我们会遗忘？有什么办法记得更牢？', en: 'Why do we forget, and how can I remember better?' },
  { zh: '讲讲黑洞：从零开始，不用公式', en: 'Explain black holes from scratch, no formulas' },
  { zh: '帮我理解「概率」：抛硬币为什么不能预测下一次？', en: "Help me understand probability: why can't a coin flip be predicted?" },
  { zh: '挑一个有趣的心理学效应，讲讲它怎么影响日常决定', en: 'Pick an interesting psychology effect and show how it shapes daily choices' },
  { zh: '如果只能记住一条写作技巧，你会教我哪一条？', en: 'If I could remember only one writing tip, which would you teach me?' },
];

// ── 现场与阶段 ─────────────────────────────────────────────────────────────
export interface GuideChatFacts {
  /** 用户提问条数（题卡登记行不算） */
  rounds: number;
  /** 末一问 / 末一答节选（服务端已压空白、截断；客户端本地推荐时留空串） */
  lastUser: string;
  lastAssistant: string;
  /** 本会话出过几组题（含情景题） */
  quizzes: number;
}

export interface GuideFacts {
  lang: GuideLang;
  view: GuideView;
  /** 客户端此刻真能执行的动作（各组件注册的能力）——推荐只会落在这里面 */
  can: readonly GuideKind[];
  /** AI 正在回答 / 正在开会话 */
  busy: boolean;
  /** 讲解角色有没有可用的模型 */
  hasModel: boolean;
  /** 当前会话；不在对话页或还没选会话 ⇒ null */
  chat: GuideChatFacts | null;
  terms: { total: number; due: number; overdue: number; streak: number };
  /** 这个人一共有几场会话（首次使用判定的旁证） */
  sessions: number;
  /** 番茄钟当前方向（契约 POMODORO-SPEC §5）：工作段才有；没开钟 / 休息段 ⇒ null 或缺省 */
  focus?: PomodoroFocus | null;
  /**
   * 应试模式的范围前提一句话（契约 EXAM-MODE-SPEC §11）：开着且有范围时才有内容。
   * ★ 缺省/空串 ⇒ 提示词与没这个功能时逐字一致（同 `focus` 的处理方式）。
   */
  examLine?: string;
}

export interface GuideItem {
  kind: GuideKind;
  label: string;
  hint: string;
  /** 仅 `chat.topic` / `chat.ask`：会以用户身份发出去的一句话 */
  text?: string;
}

export interface GuideResult {
  stage: GuideStage;
  headline: string;
  items: GuideItem[];
}

export type GuideMode = 'ai' | 'rules';

/**
 * 规则推荐的原因（仅「想用 AI 却没用成」才有；本来就该走规则的阶段——忙态——不带）。
 * ★ 是机器码而不是一句中文：服务端消息不做双语，界面按用户的语言把它翻成人话（`features/guide/guide-copy.ts`）。
 */
export type GuideReason = 'no-model' | 'timeout' | 'aborted' | 'upstream' | 'parse';

export interface GuideNextRequest {
  lang: GuideLang;
  view: GuideView;
  sessionId?: string | null;
  can: GuideKind[];
  busy?: boolean;
}

export interface GuideNextResponse extends GuideResult {
  mode: GuideMode;
  /** 仅 `rules`：为什么没用 AI（如实说，界面会显示） */
  reason?: GuideReason;
}

/**
 * 阶段判定：自上而下第一条命中的为准（契约 §5）。
 * `quizzed` 看的是 `can`——「一键解析 / 再练一遍」只有在题卡真的答完时才会被 QuizReview 注册，
 * 所以这里不需要（也不应该）自己再去数「答了几题」。
 */
export function guideStage(f: GuideFacts): GuideStage {
  if (!f.hasModel) return 'nomodel';
  if (f.view !== 'chat') return 'tour';
  if (f.busy) return 'busy';
  if (f.can.includes('quiz.explain') || f.can.includes('quiz.retry')) return 'quizzed';
  if (!f.chat || f.chat.rounds === 0) return 'fresh';
  return 'chatted';
}

/** 各阶段可选动作（按默认优先级）。最终还要与 `can` 取交集、去掉「当前页」自己 */
const STAGE_KINDS: Record<GuideStage, readonly GuideKind[]> = {
  nomodel: ['nav.settings', 'nav.terms', 'nav.continent'],
  tour: ['chat.topic', 'session.new', 'nav.continent', 'nav.terms', 'nav.pk', 'nav.settings'],
  busy: [],
  quizzed: ['quiz.explain', 'quiz.retry', 'chat.remember', 'chat.topic', 'session.new', 'nav.continent'],
  fresh: ['chat.topic', 'nav.continent', 'nav.terms', 'nav.pk', 'nav.settings'],
  chatted: ['quiz.start', 'quiz.scenario', 'chat.ask', 'chat.remember', 'chat.videos', 'session.new', 'nav.continent', 'nav.terms'],
};

export function eligibleKinds(f: GuideFacts, stage: GuideStage = guideStage(f)): GuideKind[] {
  const can = new Set<string>(f.can);
  return STAGE_KINDS[stage].filter((k) => can.has(k) && k !== `nav.${f.view}`);
}

/**
 * 必备项（契约 §2）：每组「任一」即满足；组内没有一个可选的就整组不要求。
 * 这是用户点名的三个时刻——第一次＝随机话题、聊完＝出题、做完题＝一键解析。
 */
const MUST: Partial<Record<GuideStage, readonly (readonly GuideKind[])[]>> = {
  fresh: [['chat.topic']],
  chatted: [['quiz.start', 'quiz.scenario']],
  quizzed: [['quiz.explain']],
};

function requiredGroups(stage: GuideStage, eligible: readonly GuideKind[]): GuideKind[][] {
  return (MUST[stage] ?? []).map((g) => g.filter((k) => eligible.includes(k))).filter((g) => g.length > 0);
}

// ── 文本小工具 ─────────────────────────────────────────────────────────────
/** 去控制字符与换行、压空白、按**字符**（不拆代理对）截断 */
export function cleanGuideLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- 这里就是要剔除控制字符
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join('') : flat;
}

/** 预览用短串：超长加省略号 */
export function shortGuideText(v: string, max: number): string {
  const flat = cleanGuideLine(v, 10_000);
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

const topicAt = (seed: number, lang: GuideLang): string => {
  const n = GUIDE_TOPICS.length;
  const i = ((Math.trunc(seed) % n) + n) % n;
  return GUIDE_TOPICS[i]?.[lang] ?? GUIDE_TOPICS[0]?.[lang] ?? '';
};

/** 文本动作的兜底文本 */
export function defaultGuideText(kind: GuideKind, lang: GuideLang, seed = 0): string | undefined {
  if (kind === 'chat.topic') return topicAt(seed, lang);
  return GUIDE_CATALOG[kind].text?.[lang];
}

/** 番茄钟进行中（契约 POMODORO-SPEC §5）：随机话题换成方向里的开场白——「方向」比「有趣」优先 */
const FOCUS_TOPICS: readonly ((subject: string) => GuideText)[] = [
  (x) => ({ zh: `「${x}」里最容易混淆的两个概念是什么？帮我分清楚。`, en: `What are the two most confusable ideas in "${x}"? Help me tell them apart.` }),
  (x) => ({ zh: `用一个生活里的例子讲清「${x}」的一个核心概念。`, en: `Explain one core idea of "${x}" with an everyday example.` }),
  (x) => ({ zh: `「${x}」考试里最常考的点是什么？从最基础的讲起。`, en: `What gets tested most in "${x}"? Start from the basics.` }),
];

/** 带方向的兜底文本：`chat.topic` / `chat.ask` 都围绕方向；没方向退 `defaultGuideText` */
export function focusGuideText(kind: GuideKind, f: Pick<GuideFacts, 'lang' | 'focus'>, seed = 0): string | undefined {
  const subject = f.focus?.subject;
  if (!subject || !GUIDE_TEXT_KINDS.includes(kind)) return defaultGuideText(kind, f.lang, seed);
  if (kind === 'chat.ask') {
    return f.lang === 'zh' ? `刚才这段和「${subject}」有什么关系？帮我接回主线。` : `How does this connect back to "${subject}"? Tie it to the main thread.`;
  }
  const n = FOCUS_TOPICS.length;
  const i = ((Math.trunc(seed) % n) + n) % n;
  return (FOCUS_TOPICS[i] ?? FOCUS_TOPICS[0]!)(subject)[f.lang];
}

/** 带现场数据的副行（规则推荐用）；没有可写的数据就返回 null，由目录默认文案顶上 */
function dynamicHint(kind: GuideKind, f: GuideFacts, text?: string): string | null {
  const zh = f.lang === 'zh';
  switch (kind) {
    case 'chat.topic':
      return text ? (zh ? `开聊：「${shortGuideText(text, 22)}」` : `Start with: "${shortGuideText(text, 34)}"`) : null;
    case 'chat.ask':
      return text ? (zh ? `会问：「${shortGuideText(text, 22)}」` : `Will ask: "${shortGuideText(text, 34)}"`) : null;
    case 'nav.continent':
      if (f.terms.due <= 0) return null;
      return zh
        ? `有 ${f.terms.due} 条词条到期${f.terms.overdue > 0 ? `（${f.terms.overdue} 条已逾期）` : ''}，变成了怪物，去收复`
        : `${f.terms.due} term${f.terms.due > 1 ? 's are' : ' is'} due${f.terms.overdue > 0 ? ` (${f.terms.overdue} overdue)` : ''} — go win them back`;
    case 'nav.terms':
      if (f.terms.total <= 0) return null;
      return zh ? `库里已有 ${f.terms.total} 条，点进去翻翻、搜搜` : `${f.terms.total} saved — browse and search them`;
    case 'quiz.start': {
      if (f.focus) return zh ? `围绕「${f.focus.subject}」出题，当场判分` : `Questions on "${f.focus.subject}", graded on the spot`;
      const t = f.chat?.lastUser ? shortGuideText(f.chat.lastUser, 14) : '';
      if (!t) return null;
      return zh ? `基于「${t}」出题，当场判分` : `Questions on "${t}", graded on the spot`;
    }
    default:
      return null;
  }
}

function defaultItem(kind: GuideKind, f: GuideFacts, seed: number): GuideItem {
  const info = GUIDE_CATALOG[kind];
  const text = GUIDE_TEXT_KINDS.includes(kind) ? focusGuideText(kind, f, seed) : undefined;
  const item: GuideItem = {
    kind,
    label: info.label[f.lang],
    hint: dynamicHint(kind, f, text) ?? info.hint[f.lang],
  };
  if (text) item.text = text;
  return item;
}

function headlineOf(stage: GuideStage, f: GuideFacts): string {
  if (stage === 'nomodel' && f.view === 'settings') return GUIDE_HEADLINES.nomodelHere[f.lang];
  return GUIDE_HEADLINES[stage][f.lang];
}

/** 有欠账时把「去知识大陆」提前一位（话题是必备项，保持第一） */
function ranked(kinds: GuideKind[], f: GuideFacts, stage: GuideStage): GuideKind[] {
  if (f.terms.due <= 0 || (stage !== 'fresh' && stage !== 'tour') || !kinds.includes('nav.continent')) return kinds;
  const rest = kinds.filter((k) => k !== 'nav.continent');
  const at = rest[0] === 'chat.topic' ? 1 : 0;
  return [...rest.slice(0, at), 'nav.continent', ...rest.slice(at)];
}

/**
 * 规则推荐：没绑模型 / 模型失手 / 客户端等 AI 的那几百毫秒里用。
 * 它不是降级的残次品，而是一个诚实的默认值——界面标「常用建议」，不冒充 AI。
 */
export function ruleGuide(f: GuideFacts, seed = 0): GuideResult {
  const stage = guideStage(f);
  const kinds = ranked(eligibleKinds(f, stage), f, stage).slice(0, GUIDE_MAX_ITEMS);
  return { stage, headline: headlineOf(stage, f), items: kinds.map((k) => defaultItem(k, f, seed)) };
}

// ── 模型输出校验 ───────────────────────────────────────────────────────────
function pickText(kind: GuideKind, raw: unknown, f: GuideFacts, seed: number): string | undefined {
  if (!GUIDE_TEXT_KINDS.includes(kind)) return undefined;
  const t = cleanGuideLine(raw, GUIDE_TEXT_MAX);
  return Array.from(t).length >= GUIDE_TEXT_MIN ? t : focusGuideText(kind, f, seed);
}

/**
 * 模型输出 → 可上屏的推荐。形状不对、一条合格的都没有 ⇒ null（交给网关的「修复一次」，再不行走规则推荐）。
 * 逐条：kind 必须在**此刻可选**集合里；同 kind 去重（带文本的各最多 2 条）；label / hint 不合格就换默认文案
 * （不因为文案差而丢掉一个好动作）；带文本的动作 text 不合格就换兜底文本；最后补齐必备项。
 */
export function normalizeGuideReply(raw: unknown, f: GuideFacts, seed = 0): GuideResult | null {
  const stage = guideStage(f);
  const eligible = eligibleKinds(f, stage);
  if (eligible.length === 0) return null;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { headline?: unknown; items?: unknown };
  if (!Array.isArray(o.items)) return null;

  const limits = GUIDE_LIMITS[f.lang];
  const items: GuideItem[] = [];
  const seen = new Map<GuideKind, number>();
  for (const entry of o.items) {
    if (items.length >= GUIDE_MAX_ITEMS) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { kind?: unknown; label?: unknown; hint?: unknown; text?: unknown };
    if (!isGuideKind(e.kind) || !eligible.includes(e.kind)) continue;
    const kind = e.kind;
    const quota = GUIDE_TEXT_KINDS.includes(kind) ? GUIDE_TEXT_KIND_QUOTA : 1;
    if ((seen.get(kind) ?? 0) >= quota) continue;
    const info = GUIDE_CATALOG[kind];
    const text = pickText(kind, e.text, f, seed + items.length);
    const label = cleanGuideLine(e.label, limits.label);
    const hint = cleanGuideLine(e.hint, limits.hint);
    const item: GuideItem = {
      kind,
      label: Array.from(label).length >= GUIDE_LABEL_MIN ? label : info.label[f.lang],
      hint: hint || dynamicHint(kind, f, text) || info.hint[f.lang],
    };
    if (text) item.text = text;
    // 同种带文本动作不许发出同一句话两次
    if (text && items.some((x) => x.kind === kind && x.text === text)) continue;
    items.push(item);
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
  }
  if (items.length === 0) return null;

  // 必备项：缺就插到第一位（若已满 4 条，顶掉末尾一条——必备项比第 4 个推荐重要）
  for (const group of requiredGroups(stage, eligible).reverse()) {
    if (items.some((it) => group.includes(it.kind))) continue;
    const first = group[0];
    if (!first) continue;
    if (items.length >= GUIDE_MAX_ITEMS) items.pop();
    items.unshift(defaultItem(first, f, seed));
  }

  const headline = cleanGuideLine(o.headline, limits.headline) || headlineOf(stage, f);
  return { stage, headline, items };
}

// ── 请求解析 ───────────────────────────────────────────────────────────────
/** 请求体 → 形状合法的请求；不合法返回 null（路由据此回 400）。未知字段忽略 */
export function parseGuideRequest(body: unknown): GuideNextRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { lang?: unknown; view?: unknown; sessionId?: unknown; can?: unknown; busy?: unknown };
  const lang = b.lang === undefined ? 'zh' : b.lang;
  if (lang !== 'zh' && lang !== 'en') return null;
  if (typeof b.view !== 'string' || !(GUIDE_VIEWS as readonly string[]).includes(b.view)) return null;
  if (!Array.isArray(b.can) || b.can.length > GUIDE_CAN_MAX) return null;
  const can: GuideKind[] = [];
  for (const k of b.can) {
    if (!isGuideKind(k)) return null;
    if (!can.includes(k)) can.push(k);
  }
  const sessionId = typeof b.sessionId === 'string' && b.sessionId.length > 0 && b.sessionId.length <= 80 ? b.sessionId : null;
  return { lang, view: b.view as GuideView, sessionId, can, busy: b.busy === true };
}
