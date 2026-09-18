/**
 * learning/term-review-scope — 复习**范围**（v28 契约 `docs/EBBINGHAUS-SPEC.md` §9）
 * 与「清零重来」的唯一实现（2026-09-18 M2d-2 从 `term-review.ts` 拆出）。
 *
 * ★ **为什么单开一个文件**：`term-review.ts` 加归属后涨到 435 行触 server ≤400 红线。
 *   照仓规**拆文件、不压注释**——接缝是「**读**（概览/队列/连续天数）」vs
 *   「**写**（范围开关 + 清零 + 打卡）」：本文件全是写与范围判定，`term-review.ts` 全是读。
 *   与 `tidy-plan.ts`（从 tidy.ts 拆出）、`term-usage.ts`（从 terms.ts 拆出）同手法。
 *
 * ★ 依赖方向：本文件 → `term-review.ts`（取 `IN_SCOPE` / `SCOPE_FROM` 两个唯一口径常量），
 *   **反向不成立**（`term-review.ts` 不 import 本文件）。故调用方要改 import 路径——
 *   这里**刻意不做 re-export**：那会让 `term-review.ts` 反过来 import 本文件，成为环
 *   （本仓既有规矩是断环，见 `web/src/lib/api-request.ts` 抽出时的注释）。
 *   ★ `domains.ts` 取 `SCOPE_FLAG` 仍从 `term-review.ts`（那个常量没搬）。
 *
 * ★ 归属（M2d-2）：本文件每一处写都必须带 owner——`term_domain.name` 归主后不再全局唯一，
 *   `UPDATE ... WHERE name = ?` 会一次改掉**所有人**的同名领域开关（跨用户篡改）。
 *   `term_library` 侧的批量 `UPDATE ... WHERE domain = ?` 同理。
 *   归属值一律经 `ownerForWrite(ownerId)`（`null` ⇒ `''` = 无主行）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { IN_SCOPE, SCOPE_FROM } from './term-review.js';

// ── 复习范围（v28，契约 §9）─────────────────────────────────────────────────────

/** 一条词条的有效复习范围；`null` = 词条不存在（路由据此区分 404 与 409） */
export function termScope(id: string, ownerId: string | null): { inScope: boolean } | null {
  const row = getDb()
    .prepare(`SELECT ${IN_SCOPE} AS in_scope FROM ${SCOPE_FROM} WHERE t.id = ? AND t.owner_id = ?`)
    .get(id, ownerForWrite(ownerId)) as { in_scope: number } | undefined;
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
 * ★ `where` 由调用方拼（两条路径的定位键不同：`id` / `domain`），故**owner 条件也必须由
 *   调用方拼进 `where`**——本函数不做归属判断，它只是个执行器。
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
 * ★ **本函数里每一处写都必须带 owner**（v31）：`term_domain` 的 `name` 不再唯一，
 *   `UPDATE ... WHERE name = ?` 会一次改掉**所有人**的同名领域开关（跨用户篡改）。
 */
export function setDomainReviewScope(
  rawDomain: string,
  enabled: boolean,
  ownerId: string | null,
): { domain: string; enabled: boolean; resetCount: number } | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const domain = rawDomain.trim().toLowerCase().slice(0, 30);
  const row = db.prepare('SELECT review_enabled FROM term_domain WHERE owner_id = ? AND name = ?').get(owner, domain) as
    | { review_enabled: number }
    | undefined;
  // 领域不存在 ⇒ 返回 null 让路由给 404。**不 import `domains.ts` 的 `DomainError`**：
  // 本文件已被 `domains.ts` 反向 import（要 `SCOPE_FLAG`），再 import 回去就成环
  // （本仓既有规矩是断环，见 `web/src/lib/api-request.ts` 抽出时的注释）。
  if (!row) return null;
  const before = row.review_enabled === 1;
  if (before === enabled && countOverrides(domain, ownerId) === 0) return { domain, enabled, resetCount: 0 };
  return db.transaction(() => {
    // ⚠️ 顺序：**先按旧开关算清零，再清覆盖位，最后改开关**。
    //    反过来（先清覆盖位）会让 `COALESCE(review_enabled, 旧值)` 里的旧值不再代表
    //    "原来的有效范围"，把"本来就在范围里"的词条一起清零——进度被无声抹掉。
    const resetCount = enabled
      ? resetProgress(`domain = ? AND owner_id = ? AND COALESCE(review_enabled, ?) = 0`, [domain, owner, before ? 1 : 0])
      : 0;
    db.prepare('UPDATE term_library SET review_enabled = NULL WHERE domain = ? AND owner_id = ?').run(domain, owner);
    db.prepare(
      `UPDATE term_domain SET review_enabled = ?, updated_at = datetime('now') WHERE owner_id = ? AND name = ?`,
    ).run(enabled ? 1 : 0, owner, domain);
    return { domain, enabled, resetCount };
  })();
}

/** 该域下还有几条词条带显式覆盖位（决定"开关没变但覆盖位在"时是否仍需跑一次事务） */
function countOverrides(domain: string, ownerId: string | null): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ? AND domain = ? AND review_enabled IS NOT NULL')
      .get(ownerForWrite(ownerId), domain) as { c: number }
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
export function setTermReviewScope(
  id: string,
  enabled: boolean,
  ownerId: string | null,
): { id: string; enabled: boolean; resetCount: number } | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const row = db
    .prepare(`SELECT ${IN_SCOPE} AS in_scope, d.review_enabled AS domain_enabled FROM ${SCOPE_FROM} WHERE t.id = ? AND t.owner_id = ?`)
    .get(id, owner) as { in_scope: number; domain_enabled: number | null } | undefined;
  if (!row) return null;
  const before = row.in_scope === 1;
  const domainEnabled = row.domain_enabled === 1;
  const value = enabled === domainEnabled ? null : enabled ? 1 : 0;
  const resetCount = db.transaction(() => {
    db.prepare(`UPDATE term_library SET review_enabled = ? WHERE id = ? AND owner_id = ?`).run(value, id, owner);
    return !before && enabled ? resetProgress('id = ? AND owner_id = ?', [id, owner]) : 0;
  })();
  return { id, enabled, resetCount };
}
