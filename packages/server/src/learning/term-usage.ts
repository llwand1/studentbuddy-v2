/**
 * learning/term-usage — 词条「用到了多少」的计数与提及流水（契约 `docs/MEMORY-TREND-SPEC.md` §1.4）。
 *
 * ★ 为什么从 `terms.ts` 拆出来（2026-09-18 v31 M2d-2 批）：本批给词条库加归属后
 *   `terms.ts` 涨到 **404 行**触 AGENTS.md「server `.ts` ≤400 行」红线。照仓规
 *   **拆文件、不压注释**——而这一块本就是**第 5 个关注点**：
 *     · `terms.ts` 的入库 / 增删改查由「抽取到什么、用户点了什么」驱动（写侧生命周期）；
 *     · 本文件由「**一轮回复完成了**」驱动（读侧反馈生命周期），触发点与前者几乎不重叠。
 *   与前两次拆分（`term-extract.ts` / `term-recall.ts`）同一判据。
 * ★ 用 re-export 而不是让调用方改 import：`chat/flow.ts` 与各测试的
 *   `vi.mock('../learning/terms.js')` 都指着 `terms.ts`——改路径会同时打穿多处 mock。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { recordMentions } from './mention.js';
import { parseAliases, type TermRow } from './terms.js';

/** 回复文本是否用到某词条（term + 别名，大小写不敏感；英文词按边界匹配防子串误报）。 */
function replyHitsKey(replyLower: string, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  if (!/[a-z]/.test(k)) return replyLower.includes(k); // 中文等无词边界概念：子串即可
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(replyLower);
}

/**
 * 回复完成后扫描命中词条（term + 别名）：`usage_count + 1`、`last_used_at` 更新，
 * 并在**同一事务**里落一行提及流水（契约 `docs/MEMORY-TREND-SPEC.md` §1.4）。
 *
 * ★ 为什么计数与流水必须同事务：两处一旦分叉（计数加了、流水没落），差值此后再也无法对齐
 *   ——「总提及数」与「近期提及数」本就是两个独立口径（前者含历史、后者只有建表之后），
 *   没有任何交叉校验能发现这种分叉。
 * ★ 顺带去掉旧版"命中列表算两遍"的重复扫描（原实现第 387 与 391 行各 filter 一次）。
 *
 * ★★ v31 起 `ownerId` **必填**，且**扫描范围按归属收窄**（`WHERE owner_id = ?`）：
 *   这一处是 M2d-2 里最容易被"看起来没问题"蒙过去的地方——不按归属筛也能跑、也返回数字，
 *   但它在拿**别人的词条名**去匹配**我的回复**：命中就给别人 `usage_count + 1`，还在我的回复里
 *   替别人"认领"了一次提及。★ 注意这与本函数旧注释里"漏传的后果是退回现状，不是串台"的
 *   判断**相反**——那是 `term_library` 还是全局表时的结论；**归主之后，漏传就是串台**
 *   （库里现在真的有多个用户的词条了）。
 */
export function countUsage(
  replyText: string,
  ownerId: string | null,
  now: Date = new Date(),
): number {
  if (!replyText?.trim()) return 0;
  const owner = ownerForWrite(ownerId);
  const replyLower = replyText.toLowerCase();
  const rows = getDb()
    .prepare('SELECT id, term, aliases, domain FROM term_library WHERE owner_id = ?')
    .all(owner) as Array<Pick<TermRow, 'id' | 'term' | 'aliases' | 'domain'>>;
  const hits = rows.filter((r) => [r.term, ...parseAliases(r.aliases)].some((k) => replyHitsKey(replyLower, k)));
  if (hits.length === 0) return 0;
  const db = getDb();
  const upd = db.prepare(
    `UPDATE term_library SET usage_count = usage_count + 1, last_used_at = datetime('now')
      WHERE id = ? AND owner_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const r of hits) upd.run(r.id, owner);
    // 一次批量写：`recordMentions` 内部 prepare 一次，放进循环会 prepare N 次。
    // 它在事务**内**被调用，故自身不再开事务（嵌套 transaction 会抛，见 mention.ts 文件头）。
    recordMentions(
      hits.map((r) => ({ termId: r.id, domain: r.domain })),
      ownerId,
      now,
    );
  });
  tx();
  return hits.length;
}
