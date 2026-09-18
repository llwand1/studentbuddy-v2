/**
 * shared/coach — 复习督促小窗契约（v24，契约 `docs/COACH-SPEC.md`）。
 *
 * ★ 为什么放 shared：**「现在该不该催」必须前后端同一个答案**。胶囊上的数字、抽屉里的
 *   提醒卡、服务端决定要不要主动推一条 nudge，三处各算一份就会漂成「胶囊说欠 10 条、
 *   抽屉里一句提醒都没有」（本仓 `doc-rag.ts` 常量双写那次病的同款）。故本文件是唯一事实源，
 *   纯函数、零 IO——与 `ebbinghaus.ts` 同一条纪律。
 *
 * 形态（老板 2026-09-18 拍板 **B+C+E** 三合一，一个组件的两个状态 + 流的内容形态）：
 *   B 任务胶囊 —— **折叠态**：右下角一行数字（今日欠账 / 最久逾期 / 连续打卡），零打扰；
 *   C 侧边抽屉 —— **展开态**：右侧抽屉，对话 + 队列 + 曲线都装在这里；
 *   E 卡片流   —— 抽屉里的内容**是一张张卡**（AI 卡 / 我的卡 / 复习动作卡 / 提醒卡），
 *                 而不是一条条气泡：词条卡能翻牌，AI 的回复与「我刚复习了什么」同在一个流里。
 *
 * ★ 催不催的判据是**欠账**，不是时间：到点提醒（"该背单词了"）是闹钟干的活，
 *   本功能要干的是**把欠账摆到眼前**——所以 `due = 0`（今天不欠）时**绝不主动冒泡**，
 *   一天复习三遍也不会被念第二遍（冷却 2 小时）。
 */
/** 督促频道键：与聊天 `sessionId`、PK 的 `pk:` 前缀三者严格隔离（v1 串台教训） */
export function coachChannel(ownerId: string | null | undefined): string {
  return `coach:${ownerId ?? 'local'}`;
}

/** 主动提醒的最少逾期天数：欠 1~2 天属于正常节奏，不值得打断人 */
export const NUDGE_MIN_OVERDUE_DAYS = 3;
/** 主动提醒的最少堆积量：一条条都刚到期但堆到 10 条，也是一笔该还的账 */
export const NUDGE_MIN_BACKLOG = 10;
/** 同一用户两次主动提醒的最小间隔（ms）：2 小时内不重复念 */
export const NUDGE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** 进模型上下文的最近消息条数（督促是短对话，长历史既费钱又稀释上下文） */
export const COACH_HISTORY_TURNS = 12;
/** 督促回复上限（字）：小窗里长篇大论 = 没人看 */
export const COACH_MAX_REPLY_CHARS = 600;
/** 快照里带回的「最该复习」词条数（卡片流的待办组） */
export const COACH_TOP_TERMS = 5;

/** 提醒判定结果的原因码：前端据此决定胶囊配色与是否自动展开 */
export type CoachNudgeReason = 'none' | 'empty' | 'cooldown' | 'overdue' | 'backlog';

/** 督促快照：胶囊与抽屉共用的那份「欠账账本」 */
export interface CoachSnapshot {
  /** 词条总数 */
  total: number;
  /** 今天该复习（含逾期） */
  due: number;
  /** 其中逾期 */
  overdue: number;
  /** 从未复习过 */
  fresh: number;
  /** 今日已完成（按词条去重） */
  todayDone: number;
  /** 已入长期记忆 */
  mastered: number;
  /** 最久的一笔欠账（天） */
  maxOverdueDays: number;
  /** 连续复习天数（今天没复习则从昨天倒推） */
  streak: number;
  /** 最该复习的几个（逾期天数降序） */
  top: CoachTopTerm[];
}

/** 快照里的一个待复习词条（只带渲染卡片所需的字段，不含释义——释义翻牌时才给） */
export interface CoachTopTerm {
  id: string;
  term: string;
  domain: string;
  /** 距上次复习（或入库）过去的天数 */
  daysSince: number;
  /** 逾期天数（未逾期恒 0） */
  overdueDays: number;
  /** 记忆保持率 0..1 */
  retention: number;
}

export interface CoachNudge {
  should: boolean;
  reason: CoachNudgeReason;
  /** 该冒泡时说的那句话（未触发为空串，前端不渲染） */
  line: string;
}

export interface ShouldNudgeInput {
  /** 今天该复习总数（含逾期） */
  due: number;
  /** 其中逾期数 */
  overdue: number;
  /** 最久逾期天数 */
  maxOverdueDays: number;
  /** 上次主动提醒时间（SQLite 文本或 ISO 串）；从未提醒过传 null */
  lastNudgeAt: string | null;
  /** 注入「现在」便于测试；默认真实当前时间 */
  now?: Date;
}

/** 解析 SQLite `datetime('now')` 文本（UTC，无时区标记）→ Date；坏值返回 null */
export function parseCoachTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)),
  );
}

/**
 * 该不该主动提醒（**唯一判据**）。
 *
 * 顺序即优先级，每一条都有它要挡住的那个具体骚扰：
 *  1. `empty` —— 一条欠账都没有还去敲门，是纯骚扰（也是新用户第一眼的观感）；
 *  2. `cooldown` —— 两小时内念过就不再念（用户正在复习时会连续打卡，每次都弹会疯）；
 *  3. `overdue` —— 有账逾期 ≥3 天：这是**真欠账**，值得打断；
 *  4. `backlog` —— 单条都没逾期但堆到 10 条：量变引起质变，同样该看一眼。
 */
export function shouldNudge(input: ShouldNudgeInput): CoachNudge {
  const nothing: CoachNudge = { should: false, reason: 'none', line: '' };
  if (input.due <= 0) return { ...nothing, reason: 'empty' };
  const now = input.now ?? new Date();
  const last = parseCoachTime(input.lastNudgeAt);
  if (last && now.getTime() - last.getTime() < NUDGE_COOLDOWN_MS) {
    return { ...nothing, reason: 'cooldown' };
  }
  if (input.overdue > 0 && input.maxOverdueDays >= NUDGE_MIN_OVERDUE_DAYS) {
    return { should: true, reason: 'overdue', line: nudgeLine({ overdue: input.overdue, maxOverdueDays: input.maxOverdueDays, due: input.due }) };
  }
  if (input.due >= NUDGE_MIN_BACKLOG) {
    return { should: true, reason: 'backlog', line: nudgeLine({ overdue: input.overdue, maxOverdueDays: input.maxOverdueDays, due: input.due }) };
  }
  return nothing;
}

/** 提醒文案（UI 文案同源：改说法只改这里，前端不各写一套） */
export function nudgeLine(s: Pick<CoachSnapshot, 'due' | 'overdue' | 'maxOverdueDays'>): string {
  if (s.overdue > 0) {
    return `有 ${s.overdue} 个词条欠着没背，最久的已经 ${s.maxOverdueDays} 天没碰了，先还旧账。`;
  }
  return `今天 ${s.due} 个词条到期，趁热过一遍就清零。`;
}

/** 胶囊上的一行摘要（折叠态的全部信息量：欠多少 + 连续几天） */
export function capsuleLine(s: Pick<CoachSnapshot, 'due' | 'streak' | 'todayDone'>): string {
  if (s.due <= 0) return s.todayDone > 0 ? `今日已清 ${s.todayDone} 条` : '今日无欠账';
  return `欠 ${s.due} 条 · 连续 ${s.streak} 天`;
}

/**
 * 卡片流的一张卡（E 卡片流的**内容契约**）。
 * ★ 为什么用「卡」而不是「消息气泡」：流里混着三种性质完全不同的东西——
 *   AI 说的话、我说的话、**我做过的事**（复习打卡）。气泡会把「做过的动作」挤成一句
 *   没人看的灰色小字，而它恰恰是督促小窗最有价值的信息（"我今天到底干了什么"）。
 */
export type CoachCard =
  | { id: string; kind: 'ai'; text: string; at: string; streaming?: boolean }
  | { id: string; kind: 'me'; text: string; at: string }
  | { id: string; kind: 'nudge'; text: string; at: string }
  | {
      id: string;
      kind: 'review';
      at: string;
      termId: string;
      term: string;
      /** true=记得（推进一个节点）；false=忘了（归零重来） */
      remembered: boolean;
      /** 打卡后的新阶段 */
      stage: number;
      /** 打卡后的下次间隔天数 */
      intervalDays: number;
    };

export type CoachCardKind = CoachCard['kind'];

/** 小窗底部的快捷指令（点一下即发，省得在小窗里打字） */
export const COACH_QUICK_ACTIONS: Array<{ key: string; label: string; prompt: string }> = [
  { key: 'plan', label: '今天怎么排', prompt: '我今天的词条复习怎么安排？给我一个能马上开始的顺序。' },
  { key: 'why', label: '为什么是现在', prompt: '为什么这些词条是现在就该复习的？用遗忘曲线给我讲讲。' },
  { key: 'progress', label: '我进步了吗', prompt: '结合我最近的复习记录，说说我记牢了哪些、哪些老是忘。' },
];
