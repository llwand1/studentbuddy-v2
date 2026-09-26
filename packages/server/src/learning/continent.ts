/**
 * learning/continent — 知识大陆（S6）地图取数。
 *
 * ★ 与 `term-review.ts#rowsAll` 的**唯一区别**：那边只要「复习范围内」的词条（概览/队列的语义），
 *   本文件要的是**本用户全部词条**——地图是全景，范围外的词条也该以「普通地块」出现
 *   （玩家能在图上看到自己的全部词汇，只是它们暂时不冒怪）。故范围谓词 `IN_SCOPE`
 *   在这里**刻意不加**，但把有效范围值 `SCOPE_FLAG` 作为 `review_in_scope` 带出去——
 *   前端判「该不该冒怪」必须用**服务端的结论**，不许自己 COALESCE 一次（那会变成第二份范围口径，
 *   先例见 `term-review.ts` 头注：双份口径 ⇒ 「概览说欠 3 条、队列里 0 条」）。
 *
 * ★ **零新表、零迁移**（SPEC §4.2）：本文件只是一条 SELECT，不落任何派生值。
 *   「有没有怪」「几级」「什么怪种」全部每次现算（`shared/continent.ts`），
 *   落库的话将来调等级公式就得洗全表——这正是 `review_stage` 当初只存两个真值的原因。
 *
 * ★ 排序 `ORDER BY t.created_at, t.id` 与前端铺格口径**同源**（早入库靠中心）：
 *   排序放在服务端，前端只管按序填格，这样"谁在内圈"只有一个答案。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import {
  SELECT_REVIEW_COLS,
  SCOPE_FLAG,
  SCOPE_FROM,
  toReviewTerm,
  type ReviewTerm,
  type TermReviewRow,
} from './term-review.js';

/** 地图上的一条词条 = 复习条目 + **有效**复习范围（1 = 该词条要复习，0 = 只铺地块不冒怪） */
export interface ContinentMapTerm extends ReviewTerm {
  review_in_scope: number;
}

/**
 * 本用户**全部**词条的复习状态（按入库时间升序）。
 * ★ 归属走 `ownerForWrite`（`null` ⇒ `''` = 无主行），与全仓读写同口径。
 * ★ `LEFT JOIN term_domain` 由 `SCOPE_FROM` 带出，且连接条件含 `d.owner_id = t.owner_id`
 *   （M2d-2 的泄露封堵，见 `term-review.ts` 头注）——本文件复用它而不是自己写 JOIN，
 *   就是为了不可能漏掉那个条件。
 */
export function continentMap(ownerId: string | null): ContinentMapTerm[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_REVIEW_COLS}, ${SCOPE_FLAG} AS review_in_scope
         FROM ${SCOPE_FROM}
        WHERE t.owner_id = ?
        ORDER BY t.created_at, t.id`,
    )
    .all(ownerForWrite(ownerId)) as Array<TermReviewRow & { review_in_scope: number }>;
  const now = new Date();
  // 同一个 `now` 算完所有词条：不然 140 条里有几条会落在"跨天"的两侧，地图上出现
  // 「同一天入库、状态却差一天」的鬼影（先例：概览也是取一次 now 算全表）。
  return rows.map((row) => ({ ...toReviewTerm(row, now), review_in_scope: row.review_in_scope }));
}