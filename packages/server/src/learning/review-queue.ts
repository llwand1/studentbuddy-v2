/**
 * learning/review-queue — 今日复习队列的构建（契约 `docs/EBBINGHAUS-SPEC.md` §10.3，2026-09-21 新建）。
 *
 * ★ 为什么单开文件而不并进 `learning/term-review.ts`：后者本批落地时实测 **328/400 行**，
 *   按 AGENTS.md「再加逻辑前必须先开新文件」处理（同 `quiz-image.ts` / `quiz-search.ts` /
 *   `quiz-weak.ts` / `quiz-record.ts` / `quiz-source-mix.ts` 五次先例）。
 *
 * ★★ **三段补位**（本节的核心）：队列不再"只放到期"，而是按
 *   **① 真账（到期/逾期）→ ② 提前背（未到期）→ ③ 重复巩固（今日已打过卡）** 顺序拼接，
 *   截断到用户设定的日目标条数。这是「没达标就把复习过的再复习一次」这一诉求的落地形态，
 *   但多出 ② 这一层：**提前背未到期的收益高于重复已背过的**——重复巩固的是"刚背过的"，
 *   而提前背把"明天才到期"的记忆节点前移，那才是"提高频率"的正解。
 *
 * ★★ **① 段一字不改，且领域优先不作用于它**（契约 §10.4）：`overdueDays ↓` 就是 §5 的
 *   「先还旧账」——按到期时间排会让用户永远在刷今天的新账、老账越滚越多。若让"优先领域的新账"
 *   插到"其他领域的老账"前面，这条口径就被稀释了（勾了 `cs` 之后，`math` 里逾期 20 天的词条
 *   会被 `cs` 里今天刚到期的挤下去）。故 `domains` 只决定 ②③ 两段的**段内排序**。
 *
 * ★ **"优先"是排序语义、不是过滤**：指定领域的词条不够时其他领域照常补位——否则勾了 `cs`
 *   而 `cs` 只有 3 条时，队列就只有 3 条，目标形同虚设。
 *
 * ★ **去重放在拼接之后**：①/② 天然互斥（status 不可能同时是 `due` 与 `upcoming`），
 *   ③ 与它们的交集是"今天打过卡、现在又到期了"——只在跨日瞬间出现。去重**不能靠"三段天然互斥"**，
 *   那是把正确性押在"没有跨日竞态"上。
 *
 * ★ **凑不满目标就如实短**：库里就没有那么多条。**不能复制同一条词条充数**——同一条在队列里
 *   出现两次，用户只会以为 UI 坏了。`poolSize` 如实回报，前端据此说明"可补的只有 N 条"。
 *
 * ★ **轮次（刷完一轮仍未达标）不在这里**：服务端每次返回"当前最优的一批"，前端本地维护
 *   「本轮已刷」集合、过滤后为空则清空重开。服务端算轮次需要 `doneCards % poolSize`，
 *   而用户中途改目标/改范围会让这个数错位——那是把一个**呈现细节**做成了有状态的服务端逻辑。
 *   这个分工能成立的关键是：**池子 ≤ 目标数时服务端返回全量**，故第二轮的候选一定都在手上。
 */
import { localDayKey, type ReviewGoal } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import {
  IN_SCOPE,
  SCOPE_JOIN,
  rowsAll,
  toReviewTerm,
  todayReviewCounts,
  type ReviewTerm,
} from './term-review.js';
import { loadReviewGoal } from './review-goal.js';

/** 队列默认条数与上限（**未设目标时**才用得上；设了目标就以 `goal.count` 为准） */
export const REVIEW_QUEUE_DEFAULT = 20;
export const REVIEW_QUEUE_MAX = 100;

/** 该条来自哪一段（UI 据此标注「真账 / 提前背 / 重复巩固」，让用户看懂它为什么出现在队列里） */
export type QueueSegment = 'due' | 'extra' | 'repeat';

/** 队列里的一条 = 词条 + 它所属的段 */
export interface ReviewQueueItem extends ReviewTerm {
  segment: QueueSegment;
}

/** 队列响应（契约 §10.7）：`items` 之外必须带目标与进度，否则前端得再打一次概览才知道达标没有 */
export interface ReviewQueueResult {
  items: ReviewQueueItem[];
  goal: ReviewGoal;
  /** 今日**张数**（含重复打卡）——日目标进度的分子（§10.6） */
  doneCards: number;
  /** 今日**词条数**（去重）——与 `reviewOverview.todayDone` 同源同口径 */
  doneTerms: number;
  /** 可进队列的池子大小（在范围内 **且未毕业**）——前端据此说明"库里只有 N 条可补" */
  poolSize: number;
}

/** `limit` 归一（1..`REVIEW_QUEUE_MAX`）。域层归一，路由不自己钳（同 `pk/history.ts` 手法） */
export function clampQueueLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? NaN) || REVIEW_QUEUE_DEFAULT, 1), REVIEW_QUEUE_MAX);
}

/**
 * 只取真账（到期 + 逾期），按 §5 口径排序。
 * ★ 单独抽出来是因为**督促小窗要的是"你还欠多少"，与"今天想背多少"是两件事**：
 *   用户设了日目标不该让教练去催"提前背"的词条（那等于把提醒变成任务）。
 *   故 `coach.ts` 用 `listDueQueue`，本批它的行为与改动前**逐字相同**。
 */
function dueOnly(rows: readonly ReviewTerm[], n: number): ReviewTerm[] {
  return rows
    .filter((t) => t.review.status === 'due' || t.review.status === 'overdue')
    .sort((a, b) => b.review.overdueDays - a.review.overdueDays || b.importance - a.importance)
    .slice(0, n);
}

/** 今日队列（只真账）——督促小窗用，不受用户日目标影响 */
export function listDueQueue(limit: number | undefined, domain: string | undefined, ownerId: string | null): ReviewTerm[] {
  const now = new Date();
  return dueOnly(
    rowsAll(domain, ownerId).map((r) => toReviewTerm(r, now)),
    clampQueueLimit(limit),
  );
}

/** 优先领域判定：**空列表 = 不设优先**（不是"全部优先"），否则空配置会退化成"按名字排" */
function preferredRank(domain: string, preferred: readonly string[]): number {
  return preferred.length > 0 && preferred.includes(domain) ? 0 : 1;
}

/**
 * 三段补位（**纯函数**，不碰 DB：本仓既有约定，判定逻辑留在可单测的纯函数里）。
 *
 * @param items          在复习范围内的词条（已带现算的 `review` 状态）
 * @param todayLastReview 词条 id → **今日最后一次**打卡时间；用来识别 ③ 段与它内部的轮转顺序
 * @param goal           目标（`count` 是截断数；`domains` 只作用于 ②③）
 * @param count          截断条数
 */
export function buildReviewQueue(
  items: readonly ReviewTerm[],
  todayLastReview: ReadonlyMap<string, string>,
  goal: ReviewGoal,
  count: number,
): ReviewQueueItem[] {
  // ★ `count <= 0` 直接返空：**不能靠循环里的 `out.length >= count` 兜底**——那是「先 push 再判」，
  //   要 0 条时会先塞进第一条才返回（"要 0 条却给了 1 条"）。本仓测试当场逮到过这一条。
  if (count <= 0) return [];

  // ★ 毕业档（stage=7）**不进队列**：它的语义就是不再催，塞回队列等于让毕业失效（§5）。
  //   故"池子"一律排除它——这也会让 `poolSize` 小于在范围内的词条总数，那是如实反映。
  const pool = items.filter((t) => !t.review.mastered);

  const due: ReviewTerm[] = [];
  const extra: ReviewTerm[] = [];
  const repeat: ReviewTerm[] = [];
  for (const t of pool) {
    const st = t.review.status;
    if (st === 'due' || st === 'overdue') due.push(t);
    else if (todayLastReview.has(t.id)) repeat.push(t);
    else extra.push(t);
  }

  // ① 真账：**§5 口径原样**，不看优先领域（见文件头）
  due.sort((a, b) => b.review.overdueDays - a.review.overdueDays || b.importance - a.importance);

  // ② 提前背：优先领域靠前 → 越接近到期越靠前 → 同距按重要度
  extra.sort(
    (a, b) =>
      preferredRank(a.domain, goal.domains) - preferredRank(b.domain, goal.domains) ||
      a.review.dueInDays - b.review.dueInDays ||
      b.importance - a.importance,
  );

  // ③ 重复巩固：优先领域靠前 → **今日最后一次打卡时间升序**（先背过的先回来）。
  //    刻意不用重要度：那会让最重要的那几条在每一轮都排最前、被反复刷到，其余永远轮不上。
  repeat.sort(
    (a, b) =>
      preferredRank(a.domain, goal.domains) - preferredRank(b.domain, goal.domains) ||
      (todayLastReview.get(a.id) ?? '').localeCompare(todayLastReview.get(b.id) ?? ''),
  );

  const seen = new Set<string>();
  const out: ReviewQueueItem[] = [];
  const segments: Array<[QueueSegment, ReviewTerm[]]> = [
    ['due', due],
    ['extra', extra],
    ['repeat', repeat],
  ];
  for (const [segment, list] of segments) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ ...t, segment });
      if (out.length >= count) return out;
    }
  }
  return out;
}

/**
 * 词条 id → **今日最后一次**打卡时间（`YYYY-MM-DD HH:MM:SS`，可直接字典序比较）。
 * ★ JOIN 回词条判范围（与 `reviewOverview` 的流水统计同源）：范围外的打卡不该让词条进 ③ 段
 *   ——否则用户把某域移出复习范围后，它今天打过卡的词条还会被"重复巩固"拉回来。
 * ★ 归属也由这次连接带出来（`term_review_log` 没有 owner 列，见 `term-review.ts` 文件头）。
 */
function todayLastReviewAt(ownerId: string | null, day: string): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT l.term_id AS id, MAX(l.reviewed_at) AS last_at
         FROM term_review_log l JOIN term_library t ON t.id = l.term_id ${SCOPE_JOIN}
        WHERE ${IN_SCOPE} AND t.owner_id = ? AND l.reviewed_day = ?
        GROUP BY l.term_id`,
    )
    .all(ownerForWrite(ownerId), day) as Array<{ id: string; last_at: string }>;
  return new Map(rows.map((r) => [r.id, r.last_at]));
}

/**
 * 今日队列（路由入口）：读目标 → 三段补位（或退回只真账）→ 连同进度一起返回。
 *
 * ★★ **目标关闭（`count = 0`）⇒ 退回 v1.1 行为：只放真账**。这是 §10.2 的向后兼容承诺，
 *   不能因为"反正三段补位已经写好了"就顺手把提前背塞给没设目标的用户——那是替用户做了
 *   一个他没做过的决定，而后果是他的队列从 3 条突然变 20 条。
 */
export function reviewQueue(
  limit: number | undefined,
  domain: string | undefined,
  ownerId: string | null,
): ReviewQueueResult {
  const now = new Date();
  const day = localDayKey(now);
  const goal = loadReviewGoal(ownerId);
  const rows = rowsAll(domain, ownerId).map((r) => toReviewTerm(r, now));
  const counts = todayReviewCounts(ownerId, day);
  const poolSize = rows.filter((t) => !t.review.mastered).length;

  if (goal.count <= 0) {
    const items = dueOnly(rows, clampQueueLimit(limit)).map((t) => ({ ...t, segment: 'due' as const }));
    return { items, goal, doneCards: counts.cards, doneTerms: counts.terms, poolSize };
  }

  const items = buildReviewQueue(rows, todayLastReviewAt(ownerId, day), goal, goal.count);
  return { items, goal, doneCards: counts.cards, doneTerms: counts.terms, poolSize };
}
