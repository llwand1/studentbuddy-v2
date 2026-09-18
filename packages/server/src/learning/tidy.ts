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
 */
import type { TidyPlan, TidyCluster, TidySummary } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { parseAliases, type TermRow } from './terms.js';

const TIDY_PROTOCOL = `你是词条库整理引擎。给定学习者的全部词条（每行：id | 词条 | 领域 | 释义），输出整理方案，严格按以下 JSON 格式输出，外围包一对 [TIDY]...[/TIDY] 标记：
[TIDY]{"clusters":[{"keep":"保留词条的id","term":"主词条名（必须取簇内已有词条名）","domain":"归一后的领域","merge":["被并入词条的id"],"reason":"一句话合并理由"}],"domainRenames":{"旧领域":"新领域"}}[/TIDY]
规则：
1. clusters 只合并同一概念的不同写法：同义词、中英互译、大小写/单复数变体、缩写展开。不确定是否同一概念的绝不合并。
2. 每簇至少 2 个词条（keep + merge）；keep 取信息最全或最常用的那条。
3. domainRenames 把碎领域归到规范名（如 计算机/computer science 归 cs）；已有规范领域名不动；领域名小写、不超过 30 字符。
4. 无可合并的输出空 clusters；无领域可归一时省略 domainRenames 字段。
5. 除该 JSON 外不要输出任何其他文字。
6. 输出必须是**完整合法**的 JSON：严禁用省略号（... 或 …）省略任何簇或字段，有几个簇就完整写几个；reason 不超过 30 字；闭合标记必须严格是 [/TIDY]（不能写成 </TIDY>）。`;

/** 单次整理送审的词条上限（importance+usage 排序截断；超大概率用不到，防撑爆） */
const TIDY_MAX_TERMS = 1000;

/** 从 src 的 at 处抽一个括号配平的完整 {...} 对象（字符串内的括号/引号不参与配平）；无配平返回 null */
function balancedObject(src: string, at: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

/** 解析出的簇对象 → TidyCluster（字段类型防线，整包/逐簇两条路共用） */
function toCluster(c: unknown): TidyCluster | null {
  const cl = c as Partial<TidyCluster>;
  if (typeof cl.keep !== 'string' || !cl.keep) return null;
  if (typeof cl.term !== 'string' || !cl.term) return null;
  if (!Array.isArray(cl.merge)) return null;
  return {
    keep: cl.keep,
    term: cl.term,
    domain: typeof cl.domain === 'string' ? cl.domain : '',
    merge: cl.merge.filter((x): x is string => typeof x === 'string'),
    reason: typeof cl.reason === 'string' ? cl.reason.slice(0, 100) : '',
  };
}

/**
 * 省略号/截断 salvage（2026-09-07 真机抓到的失败形态：模型把 JSON 写成 `...}` 偷懒省略、
 * 闭合标签写成 </TIDY>，整包 JSON 非法）。不赌整包能解析：逐个抽「括号配平且能 JSON.parse」
 * 的完整簇对象 + domainRenames 对象，残尾直接丢。完整簇一个不丢，残簇不硬编——
 * normalizeTidyPlan 落库前还会再校验一遍 id 真实性，双保险。
 */
function salvageTidy(src: string): TidyPlan | null {
  const clusters: TidyCluster[] = [];
  let scanFrom = 0;
  for (;;) {
    const keepAt = src.indexOf('"keep"', scanFrom);
    if (keepAt < 0) break;
    const objStart = src.lastIndexOf('{', keepAt);
    if (objStart < 0) break;
    const obj = balancedObject(src, objStart);
    if (obj) {
      try {
        const cl = toCluster(JSON.parse(obj));
        if (cl) {
          clusters.push(cl);
          scanFrom = objStart + obj.length;
          continue;
        }
      } catch {
        /* 残簇：跳过，继续找下一个 "keep" */
      }
    }
    scanFrom = keepAt + 1;
  }
  const domainRenames: Record<string, string> = {};
  const drAt = src.indexOf('"domainRenames"');
  if (drAt >= 0) {
    const objStart = src.indexOf('{', drAt);
    if (objStart >= 0) {
      const obj = balancedObject(src, objStart);
      if (obj) {
        try {
          const data = JSON.parse(obj) as Record<string, unknown>;
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'string' && v) domainRenames[k] = v;
          }
        } catch {
          /* 残表：放弃 domainRenames，簇照常 salvage */
        }
      }
    }
  }
  if (clusters.length === 0 && Object.keys(domainRenames).length === 0) return null;
  return { clusters, domainRenames };
}

/** 解析模型输出中的 [TIDY] JSON（容错：多行/围栏/前后杂质；失败返回 null 走降级） */
export function parseTidyBlock(text: string): TidyPlan | null {
  // 模型闭合标签写错成 </TIDY>（2026-09-07 真机抓到）→ 先归一成 [/TIDY] 再匹配
  const normalized = text.replace(/<\/\s*TIDY\s*>/g, '[/TIDY]');
  const m = normalized.match(/\[TIDY\]([\s\S]*?)\[\/TIDY\]/);
  let raw = m ? m[1] : '';
  if (!raw && normalized.includes('"clusters"')) raw = normalized;
  if (!raw) return null;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const data = JSON.parse(objMatch[0]) as { clusters?: unknown; domainRenames?: unknown };
      const clusters: TidyCluster[] = [];
      for (const c of Array.isArray(data.clusters) ? data.clusters : []) {
        const cl = toCluster(c);
        if (cl) clusters.push(cl);
      }
      const domainRenames: Record<string, string> = {};
      if (data.domainRenames && typeof data.domainRenames === 'object') {
        for (const [k, v] of Object.entries(data.domainRenames as Record<string, unknown>)) {
          if (typeof v === 'string' && v) domainRenames[k] = v;
        }
      }
      return { clusters, domainRenames };
    } catch {
      /* 整包非法（省略号/截断）→ 走 salvage 逐簇抢救 */
    }
  }
  return salvageTidy(cleaned);
}

function normDomain(d: string | undefined, fallback: string): string {
  return (d ?? '').trim().toLowerCase().slice(0, 30) || fallback;
}

/**
 * 校验规范化（applyTidy 前置防线，契约 §6）：
 * 丢无效簇（id 不存在/簇不足 2 条/canonical 杜撰/id 被其他簇占用）；领域改名只保留
 * 真实存在的旧领域。LLM 输出不可信，落库前必须过这一道。
 */
export function normalizeTidyPlan(plan: TidyPlan, rows: TermRow[]): TidyPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set<string>();
  const clusters: TidyCluster[] = [];
  for (const c of plan.clusters ?? []) {
    const ids = [...new Set([c.keep, ...(c.merge ?? [])])].filter((x) => typeof x === 'string' && x);
    if (ids.length < 2) continue;
    if (ids.some((id) => !byId.has(id) || used.has(id))) continue;
    const members = ids.map((id) => byId.get(id)).filter((r): r is TermRow => r !== undefined);
    if (members.length !== ids.length) continue;
    const term = c.term.trim();
    if (!members.some((r) => r.term === term)) continue; // canonical 必须取簇内已有词条名
    for (const id of ids) used.add(id);
    clusters.push({
      keep: c.keep,
      term,
      domain: normDomain(c.domain, byId.get(c.keep)?.domain ?? 'general'),
      merge: (c.merge ?? []).filter((id) => id !== c.keep),
      reason: (c.reason ?? '').slice(0, 100),
    });
  }
  const existing = new Set(rows.map((r) => r.domain));
  const domainRenames: Record<string, string> = {};
  for (const [from, to] of Object.entries(plan.domainRenames ?? {})) {
    const f = from.trim().toLowerCase();
    const t = normDomain(to, '');
    if (!f || !t || f === t || !existing.has(f)) continue;
    domainRenames[f] = t;
  }
  return { clusters, domainRenames };
}

/** 最近一次 planTidy 失败原因（tidyTerms 重试后如实上报；2026-09-07 前 catch 吞错导致用户只见笼统失败） */
let lastPlanError = '';

/** 全库词条发 LLM 产出整理方案；null=调用失败（降级），空方案=无需整理。 */
export async function planTidy(ownerId?: string | null): Promise<TidyPlan | null> {
  const rows = getDb()
    .prepare('SELECT * FROM term_library ORDER BY importance DESC, usage_count DESC LIMIT ?')
    .all(TIDY_MAX_TERMS) as TermRow[];
  if (rows.length < 2) return { clusters: [], domainRenames: {} };
  // M2c：整理方案是一次 LLM 调用，归属取发起者（契约 §8.1.4）
  const target = routeRole('explain', undefined, ownerId); // 与词条抽取同角色；契约留扩展点：可拆独立 tidy 角色
  if (!target || !target.model) {
    lastPlanError = '未配置可用的模型 provider';
    return null;
  }
  const domains = [...new Set(rows.map((r) => r.domain))];
  const lines = rows.map((r) => `${r.id} | ${r.term} | ${r.domain} | ${r.definition.replace(/\s+/g, ' ').slice(0, 60)}`);
  const prompt = `${TIDY_PROTOCOL}\n\n现有领域：${domains.join('、')}\n\n全部词条：\n${lines.join('\n')}`;
  let acc = '';
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: prompt }],
    })) {
      acc += chunk.content;
      if (chunk.done) break;
    }
  } catch (e) {
    // 整理 prompt ≈15k 字，第三方网关（agnes 等）对它偶发秒抛/中途断流/429（2026-09-07 实测 5 连发 2 失败），
    // 原因必须留档上报而不是吞成 null——否则用户永远只看到笼统的"调用失败"。
    lastPlanError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    return null;
  }
  const plan = parseTidyBlock(acc);
  if (!plan) {
    lastPlanError = acc.trim() ? `模型输出不含有效 [TIDY] 方案（输出 ${acc.length} 字）` : '模型返回空输出';
    return null;
  }
  return normalizeTidyPlan(plan, rows);
}

/**
 * 合并一行（keep 吸收 others，canonicalTerm 为合并后的主词条名）：契约 §6 语义。
 * 返回合并后的 aliases（含被并词名，供汇报）。
 */
function mergeRows(keep: TermRow, others: TermRow[], canonicalTerm: string, domain: string): string[] {
  const db = getDb();
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
  const del = db.prepare('DELETE FROM term_library WHERE id = ?');
  for (const o of others) del.run(o.id);
  db.prepare(
    `UPDATE term_library SET term = ?, definition = ?, domain = ?, importance = ?, usage_count = ?,
       last_used_at = ?, created_at = ?, source_session_id = ?, aliases = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(canonicalTerm, best.definition, domain, importance, usage, lastUsed, createdAt, source, JSON.stringify(aliases), keep.id);
  return aliases;
}

/** 应用整理方案（单事务）：先簇合并（领域经归一映射、UNIQUE 冲突防御性并入），再领域改名。 */
export function applyTidy(plan: TidyPlan): TidySummary {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM term_library').all() as TermRow[];
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
      const extra = (db.prepare('SELECT * FROM term_library WHERE term = ? AND domain = ?').all(c.term, domain) as TermRow[])
        .filter((r) => r.id !== keep.id && !c.merge.includes(r.id));
      const aliases = mergeRows(keep, [...others, ...extra], c.term, domain);
      merged.push({ canonical: c.term, aliases, reason: c.reason });
    }
    for (const [from, to] of Object.entries(domainRenames)) renameDomainTx(from, to);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  return { result: 'ok', before, after, mergedClusters: merged, domainRenames };
}

/** 领域改名（事务内）：同名词条在新旧两域各有一条时先并入（保 usage 高者），再统一改名。 */
function renameDomainTx(from: string, to: string): void {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM term_library WHERE domain IN (?, ?)').all(from, to) as TermRow[];
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
    mergeRows(keep, others, keep.term, keep.domain === from ? to : keep.domain);
  }
  db.prepare(`UPDATE term_library SET domain = ?, updated_at = datetime('now') WHERE domain = ?`).run(to, from);
}

/** 点名合并（不走 LLM）：terms[0] 为主词条；找不到的如实报告。 */
export function mergeTerms(terms: string[]): TidySummary {
  const wanted = terms.map((t) => t.trim()).filter(Boolean);
  if (wanted.length < 2) return { result: 'error', message: '至少需要两个词条名才能合并' };
  const db = getDb();
  const rows = db.prepare('SELECT * FROM term_library').all() as TermRow[];
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
    mergeRows(keep, others, canonicalTerm, keep.domain);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  return {
    result: 'ok',
    before,
    after,
    mergedClusters: [{ canonical: canonicalTerm, aliases: others.map((o) => o.term), reason: '按用户指令合并' }],
  };
}

/** 领域改名（公开入口，确定性）：from 不存在时如实报告。 */
export function renameDomain(from: string, to: string): TidySummary {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase().slice(0, 30);
  if (!f || !t || f === t) return { result: 'error', message: '领域名无效（为空或新旧相同）' };
  const db = getDb();
  const moved = (db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE domain = ?').get(f) as { c: number }).c;
  if (moved === 0) return { result: 'error', message: `没有名为「${f}」的领域` };
  const before = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  const tx = db.transaction(() => {
    renameDomainTx(f, t);
  });
  tx();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  return {
    result: 'ok',
    before,
    after,
    domainRenames: { [f]: t },
    message: `${moved} 条词条已从「${f}」移到「${t}」`,
  };
}

/** 全量整理（tidy_terms 工具 auto 入口）：单次失败自动重试一次；仍失败带真实原因如实报告（ADR-4）。 */
export async function tidyTerms(ownerId?: string | null): Promise<TidySummary> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000)); // 抖动多为瞬时限流，退避后再试
    const plan = await planTidy(ownerId);
    if (plan) return applyTidy(plan);
    lastErr = lastPlanError;
  }
  return { result: 'error', message: `整理引擎调用失败（已自动重试仍失败）：${lastErr || '模型未返回有效方案'}，请稍后再试` };
}
