/**
 * learning/tidy — 词条库 AI 整理引擎（忆域 v2.1，2026-09-03 契约 TERM-TIDY-SPEC）。
 *
 * 机制：
 *  1. planTidy：全库词条发 LLM，[TIDY] 协议产出同义词簇 + 领域归一方案（失败 null 降级）。
 *  2. applyTidy：服务端二次校验（id 全存在/簇≥2/canonical 取簇内名）后单事务应用；
 *     合并语义（契约 §6）：释义取簇内 importance 最高、importance max、usage 求和、
 *     created 取最早、被并词挂 aliases——概念不丢、可追溯。
 *  3. mergeTerms / renameDomain：点名确定性操作（不走 LLM），供 tidy_terms 工具的
 *     merge / rename_domain 两个 action。
 *
 * ★ **方案产出侧已拆到 `tidy-plan.ts`**（2026-09-18 M2d-2：加归属后本文件触 400 行红线，
 *   照仓规拆文件不压注释）。接缝＝「产出并校验方案（只读 + 调模型）」vs「把方案落到库里（事务）」。
 *   `parseTidyBlock` / `normalizeTidyPlan` 由本文件 **re-export**，故 `tidy.test.ts` 的
 *   既有 import 一个字都不用改（同 `terms.ts` 对 `countUsage` 的做法）。
 *
 * ── M2d-2（v31，2026-09-18）：词条库归主后本文件的形态 ─────────────────────────
 *
 * ★ **`ownerId` 必填**（`string | null`，不给默认值）：默认值会让"漏传"退化成
 *   "按未登录处理"，表现是**静默串台**（整理到别人的词条）或**静默丢写**。签名强制传入，
 *   `tsc` 会把每个调用点逐一点名（M2c 就是这么逮到 `chat/flow.ts` 那处漏点的）。
 *
 * ★ **归属值一律经 `ownerForWrite(ownerId)`**（`null` ⇒ `''` = 无主行），读写同口径。
 *   本文件的读形状是**成批行**（`SELECT *`）与**聚合**（`COUNT(*)`），两者都必须带归属——
 *   若按 `ownerFilter` 的「`null` 就不加条件」，未登录请求会**把全站词条整理成一份方案**
 *   （这正是 M2d-1 记下的那个坑，本文件是它的同型第二例）。
 *
 * ★ **写/删一律「严格本人」**：`mergeRows` 的 `DELETE`/`UPDATE` 除了 `id` 还带 `owner_id`
 *   ——`id` 已是全局唯一 uuid，理论上够；但加上 owner 是**防"上一步取数漏过滤"的兜底**：
 *   取数若漏了归属，按 id 删仍会删掉别人的行，而按 `(id, owner)` 删会**删不到**（静默失败，
 *   比静默改别人好）。这与 M2c「写侧严格本人」是同一条口径。
 */
import type { TidyPlan, TidySummary } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { parseAliases, type TermRow } from './terms.js';
// ★ `normalizeTidyPlan` 既 import（本文件要用）又 re-export（`tidy.test.ts` 从 './tidy.js' 取）——
//   re-export 不进本地作用域，故两行都要。
import { planTidy, normalizeTidyPlan, lastPlanErrorOf } from './tidy-plan.js';

// ★ re-export 保住既有导入面（`tidy.test.ts` 从 './tidy.js' 取这两个符号）
export { parseTidyBlock, normalizeTidyPlan } from './tidy-plan.js';

/**
 * 合并一行（keep 吸收 others，canonicalTerm 为合并后的主词条名）：契约 §6 语义。
 * 返回合并后的 aliases（含被并词名，供汇报）。
 * ★ `ownerId` 只用于**写侧的严格本人**判据（见文件头）；`keep`/`others` 已由调用方按 owner 取好。
 */
function mergeRows(keep: TermRow, others: TermRow[], canonicalTerm: string, domain: string, ownerId: string | null): string[] {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const all = [keep, ...others];
  // 释义取簇内 importance 最高（平手取 keep 行）
  const best = all.reduce((a, b) => (b.importance > a.importance ? b : a), keep);
  const importance = Math.max(...all.map((r) => r.importance));
  const usage = all.reduce((s, r) => s + r.usage_count, 0);
  const lastUsed = all.map((r) => r.last_used_at).filter((x): x is string => !!x).sort().pop() ?? null;
  const createdAt = all.map((r) => r.created_at).sort().shift() ?? keep.created_at;
  const source = keep.source_session_id ?? others.map((o) => o.source_session_id).find((x) => !!x) ?? null;
  const aliasMap = new Map<string, string>();
  if (keep.term !== canonicalTerm) aliasMap.set(keep.term.toLowerCase(), keep.term);
  for (const o of others) {
    if (!aliasMap.has(o.term.toLowerCase())) aliasMap.set(o.term.toLowerCase(), o.term); // 先到先得，去重确定
    for (const a of parseAliases(o.aliases)) {
      if (!aliasMap.has(a.toLowerCase())) aliasMap.set(a.toLowerCase(), a);
    }
  }
  aliasMap.delete(canonicalTerm.toLowerCase()); // 主词条名不进别名
  const aliases = [...aliasMap.values()];
  // 先删被并行再更新 keep：否则 UPDATE 的 (term, domain) 会撞上还活着的被并行，UNIQUE 炸事务
  const del = db.prepare('DELETE FROM term_library WHERE id = ? AND owner_id = ?');
  for (const o of others) del.run(o.id, owner);
  db.prepare(
    `UPDATE term_library SET term = ?, definition = ?, domain = ?, importance = ?, usage_count = ?,
       last_used_at = ?, created_at = ?, source_session_id = ?, aliases = ?, updated_at = datetime('now')
     WHERE id = ? AND owner_id = ?`,
  ).run(
    canonicalTerm,
    best.definition,
    domain,
    importance,
    usage,
    lastUsed,
    createdAt,
    source,
    JSON.stringify(aliases),
    keep.id,
    owner,
  );
  return aliases;
}

/** 应用整理方案（单事务）：先簇合并（领域经归一映射、UNIQUE 冲突防御性并入），再领域改名。 */
export function applyTidy(plan: TidyPlan, ownerId: string | null): TidySummary {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const rows = db.prepare('SELECT * FROM term_library WHERE owner_id = ?').all(owner) as TermRow[];
  const before = rows.length;
  const { clusters, domainRenames } = normalizeTidyPlan(plan, rows);
  if (clusters.length === 0 && Object.keys(domainRenames).length === 0) {
    return { result: 'noop', before, after: before, message: '没有需要整理的内容' };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const merged: Array<{ canonical: string; aliases: string[]; reason: string }> = [];
  const tx = db.transaction(() => {
    for (const c of clusters) {
      const keep = byId.get(c.keep);
      const others = c.merge.map((id) => byId.get(id)).filter((r): r is TermRow => r !== undefined);
      if (!keep || others.length === 0) continue;
      const domain = domainRenames[c.domain] ?? c.domain;
      // UNIQUE 冲突防御：簇外已有同词同域行（同词跨域并入后撞键）→ 一并并入，不让事务炸掉
      // ★ 带 owner：归主后「同词同域」只在**同一个用户**内才构成冲突（A、B 各有一条 `closure`
      //   在 `math` 下是合法的），不带 owner 会把别人的行也并进来。
      const extra = (
        db
          .prepare('SELECT * FROM term_library WHERE term = ? AND domain = ? AND owner_id = ?')
          .all(c.term, domain, owner) as TermRow[]
      ).filter((r) => r.id !== keep.id && !c.merge.includes(r.id));
      const aliases = mergeRows(keep, [...others, ...extra], c.term, domain, ownerId);
      merged.push({ canonical: c.term, aliases, reason: c.reason });
    }
    for (const [from, to] of Object.entries(domainRenames)) renameDomainTx(from, to, ownerId);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(owner) as { c: number }).c;
  return { result: 'ok', before, after, mergedClusters: merged, domainRenames };
}

/** 领域改名（事务内）：同名词条在新旧两域各有一条时先并入（保 usage 高者），再统一改名。 */
function renameDomainTx(from: string, to: string, ownerId: string | null): void {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const rows = db
    .prepare('SELECT * FROM term_library WHERE domain IN (?, ?) AND owner_id = ?')
    .all(from, to, owner) as TermRow[];
  const byTerm = new Map<string, TermRow[]>();
  for (const r of rows) {
    const key = r.term.toLowerCase();
    byTerm.set(key, [...(byTerm.get(key) ?? []), r]);
  }
  for (const group of byTerm.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => b.usage_count - a.usage_count || (a.created_at < b.created_at ? -1 : 1),
    );
    const keep = sorted[0];
    if (!keep) continue;
    const others = sorted.slice(1);
    mergeRows(keep, others, keep.term, keep.domain === from ? to : keep.domain, ownerId);
  }
  db.prepare(`UPDATE term_library SET domain = ?, updated_at = datetime('now') WHERE domain = ? AND owner_id = ?`).run(
    to,
    from,
    owner,
  );
}

/** 点名合并（不走 LLM）：terms[0] 为主词条；找不到的如实报告。 */
export function mergeTerms(terms: string[], ownerId: string | null): TidySummary {
  const wanted = terms.map((t) => t.trim()).filter(Boolean);
  if (wanted.length < 2) return { result: 'error', message: '至少需要两个词条名才能合并' };
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const rows = db.prepare('SELECT * FROM term_library WHERE owner_id = ?').all(owner) as TermRow[];
  const byLower = new Map<string, TermRow[]>();
  for (const r of rows) byLower.set(r.term.toLowerCase(), [...(byLower.get(r.term.toLowerCase()) ?? []), r]);
  const found: TermRow[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const hit = byLower.get(w.toLowerCase());
    if (hit && hit.length > 0) found.push(...hit);
    else missing.push(w);
  }
  if (missing.length > 0) return { result: 'error', message: `词条库中找不到：${missing.join('、')}` };
  const canonical = wanted[0] ?? '';
  // 主词条名保留库内既有拼写（大小写以库为准）
  const canonicalTerm = found.find((r) => r.term.toLowerCase() === canonical.toLowerCase())?.term ?? canonical;
  const keep = found.find((r) => r.term === canonicalTerm);
  if (!keep) return { result: 'error', message: '词条查找失败' };
  const others = found.filter((r) => r.id !== keep.id);
  if (others.length === 0) return { result: 'noop', message: '这些词条已经是同一条' };
  const before = rows.length;
  const tx = db.transaction(() => {
    mergeRows(keep, others, canonicalTerm, keep.domain, ownerId);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(owner) as { c: number }).c;
  return {
    result: 'ok',
    before,
    after,
    mergedClusters: [{ canonical: canonicalTerm, aliases: others.map((o) => o.term), reason: '按用户指令合并' }],
  };
}

/** 领域改名（公开入口，确定性）：from 不存在时如实报告。 */
export function renameDomain(from: string, to: string, ownerId: string | null): TidySummary {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase().slice(0, 30);
  if (!f || !t || f === t) return { result: 'error', message: '领域名无效（为空或新旧相同）' };
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const moved = (
    db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE domain = ? AND owner_id = ?').get(f, owner) as { c: number }
  ).c;
  // ★ `moved === 0` 的判据要**带 owner**：不带的话，A 想改名一个自己空着的域、而 B 在该域下有词条，
  //   会走成"有词条"分支，`renameDomainTx` 又按 owner 过滤掉 B 的行 ⇒ 白跑一趟事务。
  //   现在直接报「没有名为 X 的领域」——对 A 而言那确实是空的。
  if (moved === 0) return { result: 'error', message: `没有名为「${f}」的领域` };
  const before = (db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(owner) as { c: number }).c;
  const tx = db.transaction(() => {
    renameDomainTx(f, t, ownerId);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(owner) as { c: number }).c;
  return {
    result: 'ok',
    before,
    after,
    domainRenames: { [f]: t },
    message: `${moved} 条词条已从「${f}」移到「${t}」`,
  };
}

/** 全量整理（tidy_terms 工具 auto 入口）：单次失败自动重试一次；仍失败带真实原因如实报告（ADR-4）。 */
export async function tidyTerms(ownerId: string | null): Promise<TidySummary> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000)); // 抖动多为瞬时限流，退避后再试
    const plan = await planTidy(ownerId);
    if (plan) return applyTidy(plan, ownerId);
    lastErr = lastPlanErrorOf();
  }
  return { result: 'error', message: `整理引擎调用失败（已自动重试仍失败）：${lastErr || '模型未返回有效方案'}，请稍后再试` };
}
