/**
 * chat/tools/term-tidy-support —— `tidy_terms` 两阶段写的**纯策略件**（P3，随 term-tidy.ts 拆出）。
 *
 * 为什么拆：确认门改造把「取数口径 + affected 算法 + 快照差集 + 老回灌文案形状」全堆进
 * term-tidy.ts 会顶破 400 行红线（实测 406），照仓规拆文件不压注释。拆出去的没有一件
 * 需要知道「弹不弹卡」——它们只是把「算方案影响面」这件事做得可单测（零 mock 计时）。
 *
 * ★ `ownerRows`/`afterIds` 两句 SELECT 的口径抄自 `learning/tidy.ts` 内部（`WHERE owner_id = ?`
 *   严格本人）。契约判据「learning/* 零改动」（§5.1），复制口径优于给域层开新口子。
 */
import type { TermRow } from '../../learning/terms.js';
import type { TidyPlan, TidySummary } from '@sb/shared';
import { getDb } from '../../storage/db.js';
import { ownerForWrite } from '../../auth/ownership.js';
import { lastPlanErrorOf, planTidy } from '../../learning/tidy-plan.js';
import { createDomain, domainStats, removeDomain } from '../../learning/domains.js';
import { logTermDeletions } from '../../storage/term-delete-log.js';
import type { ToolContext, ToolResult } from './registry.js';

/** 词条整理结果回灌：给模型自然语言汇报的口径，不让它原样甩 JSON 给用户（P3 前原文） */
export function tidyResultContent(summary: TidySummary): string {
  return `词条库整理结果（请用简洁的自然语言向用户汇报要点，不要原样输出本 JSON）：${JSON.stringify(summary)}`;
}

function doneDetail(summary: TidySummary): string {
  return (
    summary.message ??
    (summary.before !== undefined && summary.after !== undefined ? `词条 ${summary.before} → ${summary.after} 条` : '完成')
  );
}

/** 统一收尾：发 done/error step（调度器会接管重发终态卡）+ 回灌 summary content + 统计 meta */
export function tidyTail(ctx: ToolContext, summary: TidySummary, affected: number): ToolResult {
  ctx.onStep('tidy_terms', summary.result === 'error' ? 'error' : 'done', doneDetail(summary));
  return { content: tidyResultContent(summary), meta: { affected: summary.result === 'error' ? 0 : affected } };
}

/** §4.6-5 重校验不过：中止且一条不改，如实报「计划已过期」 */
export function abortStalePlan(ctx: ToolContext, planAffected: number, nowAffected: number): ToolResult {
  ctx.onStep('tidy_terms', 'error', '方案已过期，本次未执行');
  return {
    content:
      `确认期间词条库有变动（计划影响 ${planAffected} 条，重校验只剩 ${nowAffected} 条可动），` +
      '本次整理**未执行**、一条未改。请重新发起 tidy_terms 拿新方案。',
    meta: { affected: 0 },
  };
}

export function ownerRows(ownerId: string | null): TermRow[] {
  return getDb()
    .prepare('SELECT * FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as TermRow[];
}

/** 执行后差集快照（§4.5）：整理会物理删被并行——删前状态在 `before` 里，撤得回来 */
export function logTidyDeletions(tool: string, before: TermRow[], ownerId: string | null): void {
  const rows = getDb()
    .prepare('SELECT id FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ id: string }>;
  const afterIds = new Set(rows.map((r) => r.id));
  const gone = before.filter((r) => !afterIds.has(r.id));
  if (gone.length > 0) logTermDeletions({ rows: gone, ownerId, actor: 'ai_tool', tool });
}

/** affected（§5.1 算法）：Σ(1+簇内 merge) + 领域改名命中条数（簇占用行不重复计） */
export function tidyAffectedOf(plan: TidyPlan, rows: TermRow[]): number {
  const inCluster = new Set<string>();
  for (const c of plan.clusters) {
    inCluster.add(c.keep);
    for (const id of c.merge) inCluster.add(id);
  }
  let n = plan.clusters.reduce((s, c) => s + 1 + c.merge.length, 0);
  const loose = new Map<string, number>();
  for (const r of rows) {
    if (inCluster.has(r.id)) continue;
    loose.set(r.domain, (loose.get(r.domain) ?? 0) + 1);
  }
  for (const from of Object.keys(plan.domainRenames)) n += loose.get(from) ?? 0;
  return n;
}

export function tidyPlanItems(plan: TidyPlan, rows: TermRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: string[] = [];
  for (const c of plan.clusters) {
    const names = [c.keep, ...c.merge].map((id) => byId.get(id)?.term).filter((t): t is string => !!t);
    out.push(`合并 ${names.join('、')} → 「${c.term}」［${c.domain}］`);
  }
  for (const [from, to] of Object.entries(plan.domainRenames)) out.push(`领域改名 ${from} → ${to}`);
  return out;
}

/** merge 按名找行（与 mergeTerms 的解析口径一致：大小写不敏感、同名词条跨域全拿） */
export function mergeRowsFound(terms: string[], rows: TermRow[]): { found: TermRow[]; missing: string[] } {
  const wanted = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const found: TermRow[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const hits = rows.filter((r) => r.term.toLowerCase() === w);
    if (hits.length === 0) missing.push(w);
    else for (const r of hits) if (!found.some((f) => f.id === r.id)) found.push(r);
  }
  return { found, missing };
}

/** auto 出方案（含重试，抄 tidyTerms 的 2 次 + 3s 退避）。★ 不复用 tidyTerms 本体：它 plan+apply 一气呵成，正是要拆的形态 */
export async function planTidyWithRetry(ownerId: string | null): Promise<{ plan: TidyPlan | null; err: string }> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000)); // 抖动多为瞬时限流，退避后再试
    const plan = await planTidy(ownerId);
    if (plan) return { plan, err: '' };
    lastErr = lastPlanErrorOf();
  }
  return { plan: null, err: lastErr };
}

/**
 * 领域新建/删除的工具侧包装（v19：领域与词条 CRUD 对等）。
 * 把域层异常转成 `TidySummary.error`——工具层报错口径统一走 `tidyResultContent`，
 * 不让 `DomainError`（带 HTTP status，是给路由用的）直接冒到工具层。
 */
export function domainAdd(name: string, note: string, ownerId: string | null): TidySummary {
  try {
    const { row, created } = createDomain(name, note.trim(), ownerId);
    return { result: 'ok', message: created ? `已新建领域「${row.name}」` : `领域「${row.name}」已存在，未重复创建` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '新建领域失败' };
  }
}

export function domainRemove(name: string, ownerId: string | null): TidySummary {
  try {
    const r = removeDomain(name, ownerId);
    return { result: 'ok', message: `已删除领域「${r.name}」，${r.moved} 条词条转入「${r.target}」（词条一条未删）` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '删除领域失败' };
  }
}

export function registeredDomains(ownerId: string | null): Set<string> {
  return new Set(domainStats(ownerId).domains.map((d) => d.domain));
}

export function normName(v: unknown): string {
  return String(v ?? '').trim();
}
