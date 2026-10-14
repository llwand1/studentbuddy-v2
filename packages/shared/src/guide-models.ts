/** guide-models: split domain module; compatible exports remain at guide.ts. */
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
