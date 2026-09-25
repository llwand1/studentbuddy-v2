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
 *
 * ── M2d-2（v31，2026-09-18）：复习体系归主 ──────────────────────────────────────
 *
 * ★★ **`SCOPE_JOIN` 必须带 `AND d.owner_id = t.owner_id`**（本批最隐蔽的一处泄露）：
 *   `term_domain` 归主后**领域名不再全局唯一**（A、B 各可有一个 `math`）。若连接只写
 *   `d.name = t.domain`，A 的词条会连到 **B 的同名领域行** ⇒ `COALESCE(t.review_enabled,
 *   d.review_enabled, 0)` 读到的是**别人点出来的复习开关**：B 开了 `math` 的复习，
 *   A 那边没勾过任何东西的词条就突然进复习队列（反向也成立：B 一关，A 的词条全消失）。
 *   ★ 这条**不会报任何错**，且只在"两个人恰好有同名领域"时复现——正是最难查的那类。
 *
 * ★ 归属值一律经 `ownerForWrite(ownerId)`（`null` ⇒ `''` = 无主行），读写同口径：
 *   本文件的读形状是**成批行**与**聚合**（`COUNT(DISTINCT ...)`），按 M2d-1 判据不能用
 *   `ownerFilter` 的「`null` 就不加条件」（那会把全站复习量并成一个数）。
 *
 * ★ `term_review_log` **不加 owner 列**：它是流水的历史事实，归属由 `term_id → term_library`
 *   的连接带出来（所有读它的查询本来就 JOIN 回词条判范围，v28 起如此）。加一列会带来
 *   「流水说 A、词条说 B」的分叉，而连接式没有这个自由度——**归属只有一处可表达**。
 *
 * ★ **复习「范围」的写侧已拆到 `term-review-scope.ts`**（2026-09-18 M2d-2：加归属后本文件
 *   触 400 行红线，照仓规拆文件不压注释）。接缝＝「**读**（概览/队列/连续天数/打卡）」vs
 *   「**写**（范围开关 + 清零重来）」。★ 那里**刻意不做 re-export**（会成环）⇒ 调用方要改
 *   import 路径：`termScope` / `setDomainReviewScope` / `setTermReviewScope` 三个符号
 *   现在从 `./term-review-scope.js` 取。本文件保留 `SCOPE_FLAG` / `IN_SCOPE` / `SCOPE_FROM`
 *   三个**唯一口径常量**（`domains.ts` 仍从这里取 `SCOPE_FLAG`）。
 *
 * ── v1.2（2026-09-21）：自定义复习目标 ────────────────────────────────────────
 *
 * ★ **队列的构建已拆到 `review-queue.ts`**（三段补位，契约 §10.3）：本文件只保留
 *   「**取数 + 判定**」，队列的**排序与拼接**归那边。故 `rowsAll` / `toReviewTerm` 在本文件
 *   **导出**——那边必须复用同一份取数口径（范围谓词 + 归属），否则会出现「概览说欠 3 条、
 *   队列里 0 条」这种自打脸。★ `REVIEW_QUEUE_DEFAULT` / `REVIEW_QUEUE_MAX` 随队列一起搬走，
 *   本文件不再保留（一个常量两处定义就是漂移的起点）。
 *
 * ★★ **`markReviewed` 加了「同日只推进一次」的闸门**（§10.5，本节的 P0）：加日目标之后，
 *   用户一天内把同一条词条刷 7 遍就能从 stage 0 直接毕业——**曲线变成内置作弊器**。
 *   故当天首次打卡照常推进，同一天内第二次及以后：`remembered=true` 只记流水不动曲线，
 *   `remembered=false` **仍然归零**（"忘了"是硬事实，不能因为今天已经推进过就装作没忘）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { ownerForWrite } from '../auth/ownership.js';
import {
  computeReviewState,
  localDayKey,
  addDays,
  nextStage,
  MAX_REVIEW_STAGE,
  type ReviewState,
} from '@sb/shared';

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
 * ★★ **`AND d.owner_id = t.owner_id` 是 v31 加的，删不得**（见文件头）：领域名归主后不再
 *   全局唯一，只按 name 连会把 A 的词条连到 B 的同名领域行，读错别人的复习开关。
 */
export const SCOPE_JOIN = 'LEFT JOIN term_domain d ON d.name = t.domain AND d.owner_id = t.owner_id';

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
  /**
   * 今日已完成复习的**张数**（含重复打卡）——日目标进度的分子（契约 §10.6）。
   * ★ 与 `todayDone` **并列保留、不合并**：合并会二选一地失真——只留去重则刷了 30 张显示 5
   *   （进度条永远不满，目标形同虚设）；只留含重复则"今日已复习 N"在刷重复时虚高，
   *   且与 `recent.done`（本来就是 `COUNT(*)`）口径不一致。
   */
  todayCards: number;
  /** 已走完七个节点 */
  mastered: number;
  /** 最久的一笔欠账（天） */
  maxOverdueDays: number;
  /** 各阶段词条数（含毕业档），下标即 stage */
  stages: Array<{ stage: number; count: number }>;
  /** 近 7 天每日复习量（缺的天补 0，前端直接画，不必自己对齐日期） */
  recent: Array<{ day: string; done: number; remembered: number }>;
}

/**
 * 词条行（复习相关列）。
 * ★ v1.2 起**导出**：`review-queue.ts` 复用 `rowsAll` / `toReviewTerm` 时必须能命名这个类型
 *   （它只做队列的排序与拼接，取数口径一律回到本文件）。
 */
export interface TermReviewRow {
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

/**
 * 行 → 契约对象（**唯一**的状态计算落点；其它函数都调它，保证同一次请求内口径一致）。
 * ★ v1.2 起**导出**（`review-queue.ts` 复用）：队列的每一段都必须是同一个 `review` 状态对象，
 *   那边若自己拼一份，就会出现"队列说今天到期、列表徽标说还有 3 天"。
 */
export function toReviewTerm(row: TermReviewRow, now: Date): ReviewTerm {
  const { review_stage, last_reviewed_at, ...rest } = row;
  return {
    ...rest,
    review_stage,
    last_reviewed_at,
    review: computeReviewState({ lastReviewedAt: last_reviewed_at, createdAt: row.created_at, stage: review_stage, now }),
  };
}

/**
 * 取**在复习范围内**的**本用户**词条行（可选按领域过滤）。
 * ★ 范围谓词写死在这一个出口：概览与队列都从它取数，故两者不可能对"哪些词条算数"有分歧。
 * ★ 归属也写死在这一个出口：两个读口都从它取数，故不可能一处带了归属另一处漏了。
 * ★ v1.2 起**导出**：`review-queue.ts` 的三段补位也从这里取数（它只负责排序与拼接）。
 *   队列若自己写一份 SELECT，范围谓词或归属就可能只改一处——那类 bug 只在"恰好有人
 *   反选过词条"或"两个人有同名领域"时复现。
 */
export function rowsAll(domain: string | undefined, ownerId: string | null): TermReviewRow[] {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  if (domain && domain !== 'all') {
    return db
      .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE ${IN_SCOPE} AND t.domain = ? AND t.owner_id = ?`)
      .all(domain, owner) as TermReviewRow[];
  }
  return db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE ${IN_SCOPE} AND t.owner_id = ?`)
    .all(owner) as TermReviewRow[];
}

/**
 * 今日复习计数：**张数**（`COUNT(*)`，含重复打卡）与**词条数**（`COUNT(DISTINCT term_id)`）。
 *
 * ★ 两个数出自**同一次查询**，因为它们必须一起说同一件事：`cards` 是日目标进度的分子
 *   （§10.6），`terms` 是"今天碰过几个词条"。分两次查就可能出现"进度说 30 张、词条数也是 30"
 *   这种把重复打卡当新词条的读数。
 * ★ 必须 JOIN 回词条判范围（v28）：否则"移出复习范围"的词条其历史打卡仍被计入。
 * ★ 归属由这次连接带出来（`term_review_log` 没有 owner 列，见文件头）。
 */
export function todayReviewCounts(ownerId: string | null, day: string): { cards: number; terms: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cards, COUNT(DISTINCT l.term_id) AS terms
         FROM term_review_log l JOIN term_library t ON t.id = l.term_id ${SCOPE_JOIN}
        WHERE ${IN_SCOPE} AND t.owner_id = ? AND l.reviewed_day = ?`,
    )
    .get(ownerForWrite(ownerId), day) as { cards: number; terms: number } | undefined;
  return { cards: row?.cards ?? 0, terms: row?.terms ?? 0 };
}

/** 概览：一次扫全表现算（词条量级 ≤500，见 `listTerms` 的 LIMIT，全表扫描比维护计数表更不容易错）。 */
export function reviewOverview(domain: string | undefined, ownerId: string | null): ReviewOverview {
  const now = new Date();
  const items = rowsAll(domain, ownerId).map((r) => toReviewTerm(r, now));
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
  // ★ 再带 `t.owner_id`（v31）：流水表本身没有 owner 列，归属完全由这次连接带出来
  //   （见文件头「`term_review_log` 不加 owner 列」）。
  const scopeJoin = `FROM term_review_log l JOIN term_library t ON t.id = l.term_id ${SCOPE_JOIN} WHERE ${IN_SCOPE} AND t.owner_id = ?`;
  const owner = ownerForWrite(ownerId);
  // ★ v1.2：今日计数收进 `todayReviewCounts`（张数 + 词条数**同一次查询**），队列响应也调它
  //   ——两处各写一份 SQL 就会出现"概览说今天 5 条、队列进度说 8 条"。
  const todayCounts = todayReviewCounts(ownerId, today);
  const recentRaw = db
    .prepare(
      `SELECT l.reviewed_day AS day, COUNT(*) AS done, SUM(l.remembered) AS remembered
         ${scopeJoin} AND l.reviewed_day >= ? GROUP BY l.reviewed_day`,
    )
    .all(owner, addDays(today, -(REVIEW_RECENT_DAYS - 1))) as Array<{ day: string; done: number; remembered: number }>;
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
    todayDone: todayCounts.terms,
    todayCards: todayCounts.cards,
    mastered,
    maxOverdueDays,
    stages,
    recent,
  };
}

// ★ v1.2：`listReviewQueue` 已搬到 `review-queue.ts`——队列不再是"只取真账再排序"，
//   而是三段补位（契约 §10.3）。需要"只真账"的调用方（督促小窗）用那边的 `listDueQueue`。

/** 单条词条的复习状态（词条不存在返回 null）。**不判范围**——范围另走 `termScope`。 */
export function termReviewState(id: string, ownerId: string | null): ReviewTerm | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ? AND t.owner_id = ?`)
    .get(id, ownerForWrite(ownerId)) as TermReviewRow | undefined;
  return row ? toReviewTerm(row, new Date()) : null;
}

/**
 * 复习打卡：写流水 → 推进/重置阶段 → 回读新状态。
 * ★ **流水记的是「复习前的阶段」**（`stage` 列），不是复习后的——否则看流水永远算不出
 *   「这次复习是从哪个间隔来的」，曲线图就没了横坐标的语义。
 * ★ `reviewed_day` 由应用层按**本地日历日**填（与 `computeReviewState` 同口径），
 *   不靠 SQL 的 `date('now')`（UTC 日，+8 区晚上会记到前一天）。
 * ★ **不判范围**：范围由路由先用 `termScope` 挡（404 / 409 两种不同回应），
 *   这里再判一次只会多一条永不触发的分支。
 * ★ `term_review_log` 没有 owner 列 ⇒ 归属靠**入口校验**（`SELECT` 带 owner，查不到就
 *   返回 null 不写流水）+ **回读也带 owner**。流水行的归属此后由 `term_id` 连接表达。
 *
 * ★★ **v1.2 的「同日只推进一次」闸门**（契约 §10.5，本节 P0）：加了日目标之后，
 *   用户一天内把同一条词条刷 7 遍就能从 stage 0 直接毕业——**曲线变成内置作弊器**。
 *   故：当天首次打卡照常推进；同一天内第二次及以后，`remembered=true` **只记流水、
 *   不动 stage、也不刷新 `last_reviewed_at`**（纯巩固）；`remembered=false` **仍然归零**
 *   ——"忘了"是硬事实，不能因为今天已经推进过就装作没忘。
 *   ★ 判据是「该词条**今天有没有流水**」（查 `term_review_log`），不是内存标记、
 *   也不是 `last_reviewed_at` 的日期：后者在"首次打卡 23:59、重复打卡次日 00:01"
 *   这类边界上会把跨日的两次误判成同日（那会让第二天的那次白刷）。
 * ★ `opts.silent` 只给**体验号首屏种子**用（`auth/demo-seed.ts` 的「诚实红线」）：种子走的是真实
 *   领域函数，但它不是「有人今天学习了」——发事件就会点亮 XP／连签，等于往公共池里灌假活跃。
 */
export function markReviewed(
  id: string,
  remembered: boolean,
  ownerId: string | null,
  opts: { silent?: boolean } = {},
): ReviewTerm | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const now = new Date();
  const today = localDayKey(now);
  const row = db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ? AND t.owner_id = ?`)
    .get(id, owner) as TermReviewRow | undefined;
  if (!row) return null;
  const before = row.review_stage ?? 0;
  const reviewedToday =
    (
      db.prepare('SELECT COUNT(*) AS c FROM term_review_log WHERE term_id = ? AND reviewed_day = ?').get(id, today) as {
        c: number;
      }
    ).c > 0;
  // 三条分支合成一行：记住 + 今天首次 ⇒ 推进；记住 + 今天已推进过 ⇒ 原地不动；忘了 ⇒ 归零
  const advance = remembered && !reviewedToday;
  const after = remembered ? (advance ? nextStage(before, true) : before) : 0;
  const insertLog = db.prepare(
    `INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_at, reviewed_day)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  );
  const updateTerm = db.prepare(
    `UPDATE term_library SET review_stage = ?, last_reviewed_at = datetime('now') WHERE id = ? AND owner_id = ?`,
  );
  db.transaction(() => {
    insertLog.run(randomUUID(), id, before, remembered ? 1 : 0, today);
    // ★ 同日重复且记住 ⇒ **跳过整条 UPDATE**（不只是跳过 stage）：`last_reviewed_at` 一并保持不动，
    //   否则曲线图的时间轴会多出一个"由重复打卡造成、但对曲线零贡献"的基准点。
    if (advance || !remembered) updateTerm.run(after, id, owner);
  })();
  // ★ 事务**之后**才发事件（契约 `GAMIFIED-AGENT-SPEC` §8.1）：订阅方 `learning/activity.ts` 要在
  //   `daily_activity` 上写一行，而同步发布意味着「订阅者抛错」会顺着调用栈打回打卡这条路——
  //   放在事务外，配合 ADR-4（订阅者失败只记日志），最坏是这一笔没记进连签，不会连带动摇复习曲线。
  // ⚠️ 口径变化如实记：这里**不看词条在不在复习范围内**（老 `reviewStreak` 用范围 JOIN 筛过）——
  //   范围外的词条被手动打卡同样算「今天学了」。契约 §8.3 已登记该取舍：连签数的是学习行为，不是队列归属。
  if (!opts.silent) publishEvent({ type: 'review_completed', termId: id, ownerId });
  // ★ **回读库行再算状态**（不拿内存里的 row 拼）：本仓已在 auth 的 `createdAt` 上为
  //   「两个事实源」付过一次学费，库行是唯一事实源。
  const freshRow = db
    .prepare(`SELECT ${SELECT_REVIEW_COLS} FROM ${SCOPE_FROM} WHERE t.id = ? AND t.owner_id = ?`)
    .get(id, owner) as TermReviewRow | undefined;
  return freshRow ? toReviewTerm(freshRow, now) : null;
}
