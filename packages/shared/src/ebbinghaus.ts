/**
 * shared/ebbinghaus — 艾宾浩斯遗忘曲线复习契约（2026-09-17 新建，契约 `docs/EBBINGHAUS-SPEC.md`）。
 *
 * ★ 为什么放 shared：**「一个词条现在该不该复习」必须前后端同一个答案**。前端要在列表里
 *   显示「3 天没复习了」，服务端要排出今天的复习队列——两边各算一份，就会出现「页面说
 *   该复习、队列里却没有它」（本仓 `doc-rag.ts` 常量双写那次病同款）。故本文件是唯一事实源，
 *   server（`learning/term-review.ts`）与 web（`features/terms/*`）都只调用、不重算。
 *
 * 口径三条（改码前必读）：
 *  1. **以天为最小单位**——不做小时级倒计时。理由是用户能看见的最小刻度就是「日期」，
 *     而小时级的"还剩 7 小时"会让同一天里反复弹复习提醒（体验上等于骚扰）。
 *     ⇒ 天数按**本地日历日**算（`localDayIndex`），不是「满 24 小时算一天」。
 *  2. **存储按 UTC 读、日历按本地判**：SQLite 的 `datetime('now')` 落的是 UTC 文本
 *     （`YYYY-MM-DD HH:MM:SS`，无时区标记），故解析时**显式补 Z 当 UTC**；
 *     取「哪一天」时再回到**本地日历日**（用户在 +8 区，晚上复习不该被算成前一天）。
 *     两者混用 = 差一天，而"差一天"在复习场景里就是"今天该不该背"这种可见错误。
 *  3. **到期 = 保持率掉到 70%**：间隔不是拍脑袋的常数，它与保持率曲线是同一件事的两面
 *     ——`REVIEW_INTERVALS_DAYS` 里的每个数字，正是「按本阶段强度，记忆掉到 70% 所需天数」。
 *     故 `retention = DUE_RETENTION ^ (经过天数 / 间隔天数)`，到期那一刻恰好 0.7。
 *
 * ★ **为什么只放纯函数、不碰 IO**：本仓既有约定（判定逻辑留在可单测的纯函数里，
 *   组件与路由只接线，先例 `chat/doc-name.ts`／`study-flow/flow-viewport.ts`）。
 */
/** 一天的毫秒数（仅用于日历日换算，不做倒计时） */
const DAY_MS = 86_400_000;

/**
 * 经典复习节点（天）：学完第 1 天、第 2 天、第 4 天、第 7 天、第 15 天、第 30 天、第 60 天。
 *
 * 为什么是这七个：艾宾浩斯原始曲线的复查点是 20 分钟／1 小时／9 小时／1 天／2 天／6 天／31 天，
 * 其中前三个是**当天内**的——本功能以天为最小单位（口径 1），当天内的三个点合并成「第 1 天」，
 * 后面的 2/6/31 取整为 2/7/30，再补 60 天作收尾档。**不改数值**，只做「天」这个粒度下的投影。
 * 数组下标即 `stage`：stage=0 表示还没复习过（下次间隔 1 天）。
 */
export const REVIEW_INTERVALS_DAYS: readonly number[] = [1, 2, 4, 7, 15, 30, 60];

/** 毕业档：stage 走到这里 = 走完全部七个节点，进入长期记忆（此后仍记天数，只是不再催） */
export const MAX_REVIEW_STAGE = REVIEW_INTERVALS_DAYS.length;

/** 到期阈值保持率：间隔天数即「保持率掉到这个值」所需天数（见头注口径 3） */
export const DUE_RETENTION = 0.7;

/** 保持率下限：曲线是指数衰减，理论永不归零，显示上钳一个底，免得出现「0%」这种吓人的数 */
const RETENTION_FLOOR = 0.05;

export type ReviewStatus = 'upcoming' | 'due' | 'overdue' | 'mastered';

/** 天数基准：从未复习过的词条只能拿「入库时间」当起算点（UI 据此改文案） */
export type ReviewBasis = 'review' | 'created';

export interface ReviewState {
  /** 当前阶段 0..MAX_REVIEW_STAGE */
  stage: number;
  /** 本阶段间隔天数（毕业档沿用最后一段） */
  intervalDays: number;
  /** 距上次复习（或入库）**过去了几天**——老板要的那个「真实可见的时间」 */
  daysSince: number;
  /** 距下次复习还有几天（负 = 已逾期） */
  dueInDays: number;
  /** 逾期天数（未逾期恒 0） */
  overdueDays: number;
  /** 记忆保持率估算 0..1（到期时 = DUE_RETENTION） */
  retention: number;
  status: ReviewStatus;
  /** 走完全部阶段（长期记忆） */
  mastered: boolean;
  basis: ReviewBasis;
  /** 下次复习日（`YYYY-MM-DD`，本地日历日） */
  nextDueDay: string;
}

/** 把 SQLite 的 `datetime('now')` 文本（UTC，无时区标记）解析成 Date。坏值返回 null。 */
export function parseSqliteDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)));
}

/** 本地日历日序号（整数天；跨时区/DST 也只取「年月日」，不受小时偏移影响） */
export function localDayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** 本地日历日的 `YYYY-MM-DD` 键（与 SQLite 的 `date()` 同形，可直接比较排序） */
export function localDayKey(d: Date): string {
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** `YYYY-MM-DD` → Date（UTC 午夜；只用于加天数后取回键，不参与跨时区比较） */
function dayKeyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map((x) => Number(x));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** 日期键加 N 天（N 可为负） */
export function addDays(key: string, days: number): string {
  const d = dayKeyToDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${`${d.getUTCMonth() + 1}`.padStart(2, '0')}-${`${d.getUTCDate()}`.padStart(2, '0')}`;
}

/** 本阶段间隔天数（越界钳制：负数/超界都不会返回 undefined，免得调用方到处判空） */
export function reviewIntervalDays(stage: number): number {
  const i = Math.min(Math.max(Math.trunc(stage) || 0, 0), REVIEW_INTERVALS_DAYS.length - 1);
  return REVIEW_INTERVALS_DAYS[i] ?? 1;
}

/** 记忆保持率：到期那一刻恰好 `DUE_RETENTION`，之后继续按同强度指数衰减 */
export function retentionAt(daysSince: number, intervalDays: number): number {
  const t = Math.max(daysSince, 0);
  const span = Math.max(intervalDays, 1);
  return Math.max(Math.pow(DUE_RETENTION, t / span), RETENTION_FLOOR);
}

/**
 * 复习一次后的新阶段。
 * ★ **忘了就归零**（经典重来）。刻意不做「退一级」这类折中：折中会让「下次什么时候来」
 *   变得不可预期，而本功能全部价值就在**可预期**；归零是用户听得懂的一句话。
 */
export function nextStage(stage: number, remembered: boolean): number {
  if (!remembered) return 0;
  return Math.min((Math.trunc(stage) || 0) + 1, MAX_REVIEW_STAGE);
}

export interface ReviewStateInput {
  /** 上次复习时间（SQLite 文本）；为空则退到 createdAt */
  lastReviewedAt?: string | null;
  /** 入库时间（无复习记录时的起算点） */
  createdAt?: string | null;
  stage?: number | null;
  /** 注入「现在」便于测试；默认真实当前时间 */
  now?: Date;
}

/** 计算一个词条的复习状态（前后端唯一的判定入口）。 */
export function computeReviewState(input: ReviewStateInput): ReviewState {
  const now = input.now ?? new Date();
  const stage = Math.min(Math.max(Math.trunc(input.stage ?? 0) || 0, 0), MAX_REVIEW_STAGE);
  const reviewed = parseSqliteDate(input.lastReviewedAt);
  const created = parseSqliteDate(input.createdAt);
  const basis: ReviewBasis = reviewed ? 'review' : 'created';
  const base = reviewed ?? created ?? now;
  const daysSince = localDayIndex(now) - localDayIndex(base);
  const intervalDays = reviewIntervalDays(stage);
  const baseDay = localDayKey(base);
  const nextDueDay = addDays(baseDay, intervalDays);
  const dueInDays = intervalDays - daysSince;
  const overdueDays = Math.max(-dueInDays, 0);
  const mastered = stage >= MAX_REVIEW_STAGE;
  // 毕业档不再催（status='mastered'），但天数照实算——用户仍该看见"多久没碰了"
  const status: ReviewStatus = mastered
    ? 'mastered'
    : daysSince >= intervalDays
      ? overdueDays > 0
        ? 'overdue'
        : 'due'
      : 'upcoming';
  return {
    stage,
    intervalDays,
    daysSince,
    dueInDays,
    overdueDays,
    retention: retentionAt(daysSince, intervalDays),
    status,
    mastered,
    basis,
    nextDueDay,
  };
}

/** 复习状态的中文短语（UI 文案同源：前端不再各写一套，改文案只改这里） */
export function reviewStateLabel(s: ReviewState): string {
  if (s.mastered) return `已入长期记忆 · ${s.daysSince} 天前复习`;
  if (s.status === 'overdue') return `逾期 ${s.overdueDays} 天 · ${s.daysSince} 天没复习`;
  if (s.status === 'due') return `今天该复习 · ${s.daysSince} 天没复习`;
  return `${s.daysSince} 天没复习 · 还有 ${s.dueInDays} 天到期`;
}
