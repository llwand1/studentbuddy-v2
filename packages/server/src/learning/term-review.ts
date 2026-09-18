/**
 * learning/term-review — 词条复习（艾宾浩斯遗忘曲线，v23，契约 `docs/EBBINGHAUS-SPEC.md`）。
 *
 * 职责四件：**概览统计**（今天欠多少）/ **复习队列**（先还哪笔旧账）/ **打卡**（记住了还是忘了）
 * / **复习范围**（谁该复习、谁不复习，v28 §9）。
 * ★ **判定一律走 `shared/ebbinghaus.ts`**，本文件不重算天数、不自己定义间隔序列
 *   （双份口径的后果是「页面说该复习、队列里没有它」，本仓在 doc-rag 常量上已付过学费）。
 * ★ **库里只存 `review_stage` + `last_reviewed_at` 两个真值**，「下次什么时候复习」每次现算
 *   （见迁移 v23 注释：派生值落库 ⇒ 将来调间隔就得洗全表）。
 *
 * ★ 排序口径：**先还旧账**。队列按 `overdueDays` 降序（欠得越久越靠前），同欠账按重要度降序
 *   ——「逾期 7 天的重要词条」优先于「今天刚到期的不重要词条」，这与用户催自己复习的直觉一致；
 *   若按到期时间排，用户会永远在刷今天的新账，老账越滚越多（那就是没做这个功能）。
 *
 * ★ **复习范围（v28）的唯一口径**：`COALESCE(t.review_enabled, d.review_enabled, 0)`
 *   —— 词条覆盖位优先，为空则跟随领域开关，孤儿域（登记册里没有的域）落到 0（= 不复习）。
 *   本文件把它收成常量 `IN_SCOPE`，**全仓只有这一处写这个表达式**（连 `domainStats` 的
 *   范围内计数也 import 它，见 `domains.ts`）：范围判定一旦有两份，就会出现
 *   「概览说欠 3 条、队列里 0 条」这种自打脸，而这类 bug 只在"恰好有人反选过词条"时复现。
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

/**
 * 有效复习范围的**取值**（0/1）：词条覆盖位优先，为空跟随领域开关，孤儿域落到 0。
 * ★ `domains.ts` 的「本域已纳入几条」用它做 `SUM`（谓词形式在 WHERE 里不适用）——
 *   故取值与谓词共用同一段表达式，改一处两处一起变。
 */
export const SCOPE_FLAG = 'COALESCE(t.review_enabled, d.review_enabled, 0)';

/**
 * 有效复习范围的 SQL 谓词（**全仓唯一实现**，v28）。
 * 表别名固定为 `t`（term_library）/ `d`（term_domain）——`domains.ts` 复用时必须用同名别名。
 */
export const IN_SCOPE = `${SCOPE_FLAG} = 1`;

/**
 * 「词条 → 领域」的连接（要求 `t` 已在 FROM/JOIN 中出现）。
 * ★ 单拆出来是因为**流水表**也要判范围（`term_review_log l JOIN term_library t ON ...`），
 *   那种写法没法直接套 `SCOPE_FROM`（`ON` 子句的位置不同）——把连接条件抽出来，
 *   范围谓词与连接条件仍各自只有一份。
 */
export const SCOPE_JOIN = 'LEFT JOIN term_domain d ON d.name = t.domain';

/** 范围查询的 FROM（词条左连领域登记册；孤儿域的 `d.*` 为 NULL，`COALESCE` 落到 0） */
export const SCOPE_FROM = `term_library t ${SCOPE_JOIN}`;

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
  /** 词条总数（**只数在复习范围内的**——范围外的词条不进任何统计，否则"欠账"会被娱乐词条顶高） */
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

/** ⚠️ 列名一律带 `t.` 前缀：`term_domain` 也有 `created_at`/`updated_at`，JOIN 后不加前缀会 ambiguous */
const SELECT_REVIEW_COLS = `t.id, t.term, t.definition, t.domain, t.importance, t.usage_count,
  t.created_at, t.updated_at, t.review_stage, t.last_reviewed_at`;

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

/**
 * 取**在复习范围内**的词条行（可选按领域过滤）。
 * ★ 范围谓词写死在这一个出口：概览与队列都从它取数，故两者不可能对"哪些词条算数"有分歧。
 */
function rowsAll(domain?: string): TermReviewRow[] {
  const db = getDb();
  if (domain && domain !== 'all') {
    return db
      .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE ${IN_SCOPE} AND t.domain = ?`)
      .all(domain) as TermReviewRow[];
  }
  return db.prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE ${IN_SCOPE}`).all() as TermReviewRow[];
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
  // ★ 流水统计也要 JOIN 回词条判范围（v28）：否则"移出复习范围"的词条其历史打卡仍被计入
  //   「今日已复习 / 近 7 天柱状」，而它已经不在这批词条里了——数字与上方统计不同源。
  const scopeJoin = `FROM term_review_log l JOIN term_library t ON t.id = l.term_id ${SCOPE_JOIN} WHERE ${IN_SCOPE}`;
  const todayRow = db
    .prepare(`SELECT COUNT(DISTINCT l.term_id) AS c ${scopeJoin} AND l.reviewed_day = ?`)
    .get(today) as { c: number };
  const recentRaw = db
    .prepare(
      `SELECT l.reviewed_day AS day, COUNT(*) AS done, SUM(l.remembered) AS remembered
         ${scopeJoin} AND l.reviewed_day >= ? GROUP BY l.reviewed_day`,
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

/** 单条词条的复习状态（词条不存在返回 null）。**不判范围**——范围另走 `termScope`。 */
export function termReviewState(id: string): ReviewTerm | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ?`)
    .get(id) as TermReviewRow | undefined;
  return row ? toReviewTerm(row, new Date()) : null;
}

// ── 复习范围（v28，契约 §9）─────────────────────────────────────────────────────

/** 一条词条的有效复习范围；`null` = 词条不存在（路由据此区分 404 与 409） */
export function termScope(id: string): { inScope: boolean } | null {
  const row = getDb()
    .prepare(`SELECT ${IN_SCOPE} AS in_scope FROM ${SCOPE_FROM} WHERE t.id = ?`)
    .get(id) as { in_scope: number } | undefined;
  return row ? { inScope: row.in_scope === 1 } : null;
}

/**
 * 清零重来（老板 2026-09-18 拍板）：**由"不在范围"变为"在范围"时**，把 `review_stage` 与
 * `last_reviewed_at` 打回原形。
 * ★ 只在**由关变开**这一个方向触发：反向（移出范围）不清零——那只是"暂时不催"，
 *   而再纳入时反正会清零，两个方向都清等于把"移出"变成了隐形的破坏性操作。
 * ★ **不动 `term_review_log`**：流水是历史事实（"你那天确实复习过"），抹掉它等于篡改曲线图
 *   的横坐标；清零清的是**进度**，不是**历史**。代价是「刚复习完→移出→再纳入」之后
 *   `todayDone` 仍会记着那次打卡——这是如实反映，不是 bug（契约 §9.4 已登记）。
 */
function resetProgress(where: string, args: unknown[]): number {
  const info = getDb()
    .prepare(`UPDATE term_library SET review_stage = 0, last_reviewed_at = NULL WHERE ${where}`)
    .run(...args);
  return info.changes;
}

/**
 * 设**领域**复习开关（点领域 = 该领域**整体**进/出复习范围）。
 *
 * ★ 语义 = **一键全开 / 一键全关**：除了设开关，还**清掉该域内所有词条的覆盖位**。
 *   老板原话是「点击领域，领域内的词条都一键开启复习」——若只切开关而保留覆盖位，
 *   被反选过的词条不会跟着开，那"一键开启"就名不副实（用户会以为按钮坏了）。
 *   清覆盖位后该域回到"全部跟随领域"的干净态，与按钮文案逐字对应。
 * ★ 领域开关本身**仍然必要**（不是为了这一下点击，而是为了**新词条**）：
 *   覆盖位被清成 NULL 后，AI 后续抽进该域的新词条自然跟随开关 ⇒ 自动纳入复习池。
 *   这是"只做词条级批量写"做不到的（那种做法下新词条永远默认关闭且用户不会察觉）。
 * ★ 只有**原本有效值为 0** 的词条会被清零：`COALESCE(t.review_enabled, 旧领域值) = 0`
 *   把"显式开着"的词条排除在外（它们本来就在范围里，进度不该被别人的开关波及）。
 */
export function setDomainReviewScope(
  rawDomain: string,
  enabled: boolean,
): { domain: string; enabled: boolean; resetCount: number } | null {
  const db = getDb();
  const domain = rawDomain.trim().toLowerCase().slice(0, 30);
  const row = db.prepare('SELECT review_enabled FROM term_domain WHERE name = ?').get(domain) as
    | { review_enabled: number }
    | undefined;
  // 领域不存在 ⇒ 返回 null 让路由给 404。**不 import `domains.ts` 的 `DomainError`**：
  // 本文件已被 `domains.ts` 反向 import（要 `SCOPE_FLAG`），再 import 回去就成环
  // （本仓既有规矩是断环，见 `web/src/lib/api-request.ts` 抽出时的注释）。
  if (!row) return null;
  const before = row.review_enabled === 1;
  if (before === enabled && countOverrides(domain) === 0) return { domain, enabled, resetCount: 0 };
  return db.transaction(() => {
    // ⚠️ 顺序：**先按旧开关算清零，再清覆盖位，最后改开关**。
    //    反过来（先清覆盖位）会让 `COALESCE(review_enabled, 旧值)` 里的旧值不再代表
    //    "原来的有效范围"，把"本来就在范围里"的词条一起清零——进度被无声抹掉。
    const resetCount = enabled
      ? resetProgress(`domain = ? AND COALESCE(review_enabled, ?) = 0`, [domain, before ? 1 : 0])
      : 0;
    db.prepare('UPDATE term_library SET review_enabled = NULL WHERE domain = ?').run(domain);
    db.prepare(`UPDATE term_domain SET review_enabled = ?, updated_at = datetime('now') WHERE name = ?`).run(
      enabled ? 1 : 0,
      domain,
    );
    return { domain, enabled, resetCount };
  })();
}

/** 该域下还有几条词条带显式覆盖位（决定"开关没变但覆盖位在"时是否仍需跑一次事务） */
function countOverrides(domain: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM term_library WHERE domain = ? AND review_enabled IS NOT NULL')
      .get(domain) as { c: number }
  ).c;
}

/**
 * 设**单条词条**的复习范围（`enabled` = 目标**有效**值，不是列里要写的值）。
 *
 * ★ **写 NULL 的规则**：目标值与领域开关**一致**时写 `NULL`（= 回归继承），不一致才写显式 0/1。
 *   为什么不无脑写显式值：那样用户每碰一次就固化一条，领域开关从此对它永久失效
 *   （包括将来领域改开关、以及"新词条跟随领域"这条链路的语义一致性），
 *   且库里的显式值会越积越多、分不清哪些是用户真的反选过、哪些只是点了一下。
 *   这条规则保证：**显式值只在"用户确实要偏离领域默认"时存在**。
 */
export function setTermReviewScope(id: string, enabled: boolean): { id: string; enabled: boolean; resetCount: number } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${IN_SCOPE} AS in_scope, d.review_enabled AS domain_enabled FROM ${SCOPE_FROM} WHERE t.id = ?`)
    .get(id) as { in_scope: number; domain_enabled: number | null } | undefined;
  if (!row) return null;
  const before = row.in_scope === 1;
  const domainEnabled = row.domain_enabled === 1;
  const value = enabled === domainEnabled ? null : enabled ? 1 : 0;
  const resetCount = db.transaction(() => {
    db.prepare(`UPDATE term_library SET review_enabled = ? WHERE id = ?`).run(value, id);
    return !before && enabled ? resetProgress('id = ?', [id]) : 0;
  })();
  return { id, enabled, resetCount };
}

/**
 * 复习打卡：写流水 → 推进/重置阶段 → 回读新状态。
 * ★ **流水记的是「复习前的阶段」**（`stage` 列），不是复习后的——否则看流水永远算不出
 *   「这次复习是从哪个间隔来的」，曲线图就没了横坐标的语义。
 * ★ `reviewed_day` 由应用层按**本地日历日**填（与 `computeReviewState` 同口径），
 *   不靠 SQL 的 `date('now')`（UTC 日，+8 区晚上会记到前一天）。
 * ★ **不判范围**：范围由路由先用 `termScope` 挡（404 / 409 两种不同回应），
 *   这里再判一次只会多一条永不触发的分支。
 */
export function markReviewed(id: string, remembered: boolean): ReviewTerm | null {
  const db = getDb();
  const now = new Date();
  const row = db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ?`)
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
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ?`)
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
 * ★ v28 起 JOIN 回词条判范围：范围外的打卡不算"今天复习过"，否则用户把娱乐域移出后
 *   连续天数还挂着——那数字会被读成"我今天已经复习过了"。
 */
export function reviewStreak(now: Date = new Date()): number {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT l.reviewed_day AS day FROM term_review_log l
         JOIN term_library t ON t.id = l.term_id ${SCOPE_JOIN}
        WHERE ${IN_SCOPE} ORDER BY day DESC LIMIT 400`,
    )
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
