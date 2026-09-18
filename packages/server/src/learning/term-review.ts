/**
 * learning/term-review — 词条复习（艾宾浩斯遗忘曲线，v23，契约 `docs/EBBINGHAUS-SPEC.md`）。
 *
 * 职责三件：**概览统计**（今天欠多少）/ **复习队列**（先还哪笔旧账）/ **打卡**（记住了还是忘了）。
 * ★ **判定一律走 `shared/ebbinghaus.ts`**，本文件不重算天数、不自己定义间隔序列
 *   （双份口径的后果是「页面说该复习、队列里没有它」，本仓在 doc-rag 常量上已付过学费）。
 * ★ **库里只存 `review_stage` + `last_reviewed_at` 两个真值**，「下次什么时候复习」每次现算
 *   （见迁移 v23 注释：派生值落库 ⇒ 将来调间隔就得洗全表）。
 *
 * ★ 排序口径：**先还旧账**。队列按 `overdueDays` 降序（欠得越久越靠前），同欠账按重要度降序
 *   ——「逾期 7 天的重要词条」优先于「今天刚到期的不重要词条」，这与用户催自己复习的直觉一致；
 *   若按到期时间排，用户会永远在刷今天的新账，老账越滚越多（那就是没做这个功能）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import {
  computeReviewState,
  localDayKey,
  addDays,
  nextStage,
  MAX_REVIEW_STAGE,
  type ReviewState,
} from '@sb/shared';

/** 队列默认条数与上限（与 `pk/history.ts` 同手法：归一在域层，路由不自己钳） */
export const REVIEW_QUEUE_DEFAULT = 20;
export const REVIEW_QUEUE_MAX = 100;

/** 近 N 天复习量（概览里的柱状输入） */
export const REVIEW_RECENT_DAYS = 7;

/** 队列/概览里的一条词条：复习相关字段 + 现算的复习状态 */
export interface ReviewTerm {
  id: string;
  term: string;
  definition: string;
  domain: string;
  importance: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  review_stage: number;
  last_reviewed_at: string | null;
  review: ReviewState;
}

export interface ReviewOverview {
  /** 词条总数 */
  total: number;
  /** 今天该复习（含逾期） */
  due: number;
  /** 其中逾期 */
  overdue: number;
  /** 从未复习过（欠的是「第一次」这笔账） */
  fresh: number;
  /** 今日已完成复习的词条数（按词条去重，一天复习三次只算一个） */
  todayDone: number;
  /** 已走完七个节点 */
  mastered: number;
  /** 最久的一笔欠账（天） */
  maxOverdueDays: number;
  /** 各阶段词条数（含毕业档），下标即 stage */
  stages: Array<{ stage: number; count: number }>;
  /** 近 7 天每日复习量（缺的天补 0，前端直接画，不必自己对齐日期） */
  recent: Array<{ day: string; done: number; remembered: number }>;
}

interface TermReviewRow {
  id: string;
  term: string;
  definition: string;
  domain: string;
  importance: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  review_stage: number;
  last_reviewed_at: string | null;
}

const SELECT_REVIEW_COLS = `id, term, definition, domain, importance, usage_count,
  created_at, updated_at, review_stage, last_reviewed_at`;

/** 行 → 契约对象（**唯一**的状态计算落点；其它函数都调它，保证同一次请求内口径一致） */
function toReviewTerm(row: TermReviewRow, now: Date): ReviewTerm {
  const { review_stage, last_reviewed_at, ...rest } = row;
  return {
    ...rest,
    review_stage,
    last_reviewed_at,
    review: computeReviewState({ lastReviewedAt: last_reviewed_at, createdAt: row.created_at, stage: review_stage, now }),
  };
}

function rowsAll(domain?: string): TermReviewRow[] {
  const db = getDb();
  if (domain && domain !== 'all') {
    return db
      .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM term_library WHERE domain = ?`)
      .all(domain) as TermReviewRow[];
  }
  return db.prepare(`SELECT ${SELECT_REVIEW_COLS} FROM term_library`).all() as TermReviewRow[];
}

/** 概览：一次扫全表现算（词条量级 ≤500，见 `listTerms` 的 LIMIT，全表扫描比维护计数表更不容易错）。 */
export function reviewOverview(domain?: string): ReviewOverview {
  const now = new Date();
  const items = rowsAll(domain).map((r) => toReviewTerm(r, now));
  const stages = Array.from({ length: MAX_REVIEW_STAGE + 1 }, (_, stage) => ({ stage, count: 0 }));
  let due = 0;
  let overdue = 0;
  let fresh = 0;
  let mastered = 0;
  let maxOverdueDays = 0;
  for (const it of items) {
    const idx = Math.min(it.review.stage, MAX_REVIEW_STAGE);
    stages[idx] = { stage: idx, count: (stages[idx]?.count ?? 0) + 1 };
    if (it.review.basis === 'created') fresh += 1;
    if (it.review.mastered) mastered += 1;
    if (it.review.status === 'due' || it.review.status === 'overdue') due += 1;
    if (it.review.status === 'overdue') {
      overdue += 1;
      maxOverdueDays = Math.max(maxOverdueDays, it.review.overdueDays);
    }
  }
  const today = localDayKey(now);
  const db = getDb();
  const todayRow = db
    .prepare('SELECT COUNT(DISTINCT term_id) AS c FROM term_review_log WHERE reviewed_day = ?')
    .get(today) as { c: number };
  const recentRaw = db
    .prepare(
      `SELECT reviewed_day AS day, COUNT(*) AS done, SUM(remembered) AS remembered
         FROM term_review_log WHERE reviewed_day >= ? GROUP BY reviewed_day`,
    )
    .all(addDays(today, -(REVIEW_RECENT_DAYS - 1))) as Array<{ day: string; done: number; remembered: number }>;
  const byDay = new Map(recentRaw.map((r) => [r.day, r]));
  const recent = Array.from({ length: REVIEW_RECENT_DAYS }, (_, i) => {
    const day = addDays(today, -(REVIEW_RECENT_DAYS - 1 - i));
    const hit = byDay.get(day);
    return { day, done: hit?.done ?? 0, remembered: hit?.remembered ?? 0 };
  });
  return {
    total: items.length,
    due,
    overdue,
    fresh,
    todayDone: todayRow?.c ?? 0,
    mastered,
    maxOverdueDays,
    stages,
    recent,
  };
}

/**
 * 今日复习队列：`status ∈ {due, overdue}`，按逾期天数降序、同欠账按重要度降序。
 * 毕业档（`mastered`）**不进队列**——它的语义就是不再催，塞回队列等于让毕业失效。
 */
export function listReviewQueue(limit = REVIEW_QUEUE_DEFAULT, domain?: string): ReviewTerm[] {
  const now = new Date();
  const n = Math.min(Math.max(Math.trunc(limit) || REVIEW_QUEUE_DEFAULT, 1), REVIEW_QUEUE_MAX);
  return rowsAll(domain)
    .map((r) => toReviewTerm(r, now))
    .filter((it) => it.review.status === 'due' || it.review.status === 'overdue')
    .sort((a, b) => b.review.overdueDays - a.review.overdueDays || b.importance - a.importance)
    .slice(0, n);
}

/** 单条词条的复习状态（词条不存在返回 null）。 */
export function termReviewState(id: string): ReviewTerm | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM term_library WHERE id = ?`)
    .get(id) as TermReviewRow | undefined;
  return row ? toReviewTerm(row, new Date()) : null;
}

/**
 * 复习打卡：写流水 → 推进/重置阶段 → 回读新状态。
 * ★ **流水记的是「复习前的阶段」**（`stage` 列），不是复习后的——否则看流水永远算不出
 *   「这次复习是从哪个间隔来的」，曲线图就没了横坐标的语义。
 * ★ `reviewed_day` 由应用层按**本地日历日**填（与 `computeReviewState` 同口径），
 *   不靠 SQL 的 `date('now')`（UTC 日，+8 区晚上会记到前一天）。
 */
export function markReviewed(id: string, remembered: boolean): ReviewTerm | null {
  const db = getDb();
  const now = new Date();
  const row = db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM term_library WHERE id = ?`)
    .get(id) as TermReviewRow | undefined;
  if (!row) return null;
  const before = row.review_stage ?? 0;
  const after = nextStage(before, remembered);
  const insertLog = db.prepare(
    `INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_at, reviewed_day)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  );
  const updateTerm = db.prepare(
    `UPDATE term_library SET review_stage = ?, last_reviewed_at = datetime('now') WHERE id = ?`,
  );
  db.transaction(() => {
    insertLog.run(randomUUID(), id, before, remembered ? 1 : 0, localDayKey(now));
    updateTerm.run(after, id);
  })();
  // ★ **回读库行再算状态**（不拿内存里的 row 拼）：本仓已在 auth 的 `createdAt` 上为
  //   「两个事实源」付过一次学费，库行是唯一事实源。
  const freshRow = db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM term_library WHERE id = ?`)
    .get(id) as TermReviewRow | undefined;
  return freshRow ? toReviewTerm(freshRow, now) : null;
}

/**
 * 连续复习天数（督促小窗的「连续 N 天」）。
 *
 * ★ 口径：**今天复习了就从今天起算；今天还没复习则从昨天起算**。若严格只认「今天也复习了」，
 *   用户一早打开小窗看到连续天数归零会以为是 bug（他昨晚刚背完）——而这数字的作用是
 *   **给正反馈**，不是记账，让它更早归零只会反向激励。真断了（昨天也没复习）才归 0。
 * ★ 用 `reviewed_day`（本地日历日）而不是 `reviewed_at` 时间戳：与 `computeReviewState`
 *   同口径（本功能的全部时间判断都以天为最小单位，跨时区/凌晨复习不该算成断签）。
 * ★ LIMIT 400：足够覆盖任何现实的连续天数，避免把全表流水拉进内存。
 */
export function reviewStreak(now: Date = new Date()): number {
  const rows = getDb()
    .prepare('SELECT DISTINCT reviewed_day AS day FROM term_review_log ORDER BY day DESC LIMIT 400')
    .all() as Array<{ day: string }>;
  const days = new Set(rows.map((r) => r.day));
  let cursor = localDayKey(now);
  if (!days.has(cursor)) {
    cursor = addDays(cursor, -1);
    if (!days.has(cursor)) return 0;
  }
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
}
