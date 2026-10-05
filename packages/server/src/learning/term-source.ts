/**
 * learning/term-source — 词条的**真来源**登记与范围过滤（迁移 v55，契约 EXAM-MODE-SPEC §11）。
 *
 * 为什么需要这一层（2026-10-05 现查，不是推测）：应试模式要把词条、卡牌、知识大陆地块与怪、
 * 刷词队列一起按用户圈的**站点范围**过滤，而 `term_library` 18 列里没有任何来源网址——
 * 只有 `source_session_id`（会话粒度、N:M，且手输／宝箱／大陆开拓／刷词存词四条路径为 NULL）。
 * 借会话反推只能得到「这个会话读过哪些站」，得不到「这个词是哪一站喂出来的」；
 * 本机库 331 条词条、`message_source` 0 行，连可借的存量都没有。⇒ 只能把键补在写入侧。
 *
 * ★ 三条口径：
 *  - **只记服务端事实，不记模型自报的网址**：来源取自本轮资料架（`shelf.settle()` 之后留下的
 *    读过／精选／引用到的条目）。让模型顺手写一个 url，就会重演「来源指向不存在的网页」——
 *    那条教训已经写在 `quiz-search.ts` 的头注里。
 *  - **范围判定取「任一来源命中即算在内」**：一个词可能被两三个页面喂出来，全不在范围才算范围外。
 *    宁可少滤一条，不可错杀一片（错杀的表现为「我明明学过这个词，大陆上没有了」）。
 *  - **没有来源行的词条在应试模式下不出现**（老板 2026-10-05 拍：范围内有什么就是什么）。
 *    这条的后果是真库里的历史词条几乎全为「无来源」，所以配套的空态引导不是装饰，
 *    是让用户明白「范围是从这一轮之后开始长出来的」。
 */
import { randomUUID } from 'node:crypto';
import { examHostAllowed } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { loadExamContext } from './exam-mode.js';

/** 一轮最多给一个词条记几条来源（资料架收口常有 5–12 条，全记等于没记） */
export const MAX_TERM_SOURCE_URLS = 3;

/** 来源是哪条路带来的：对话后抽词 / 对话工具存词。新路径再扩值，别塞进 `origin` 里自由发挥 */
export type TermSourceOrigin = 'chat' | 'tool';

/** 写入口带的来源（可选参数：手动添加、宝箱、大陆开拓、刷词存词这些路径**没有** URL，就不传） */
export interface TermSourceInput {
  urls: readonly string[];
  origin: TermSourceOrigin;
}

/**
 * 有来源才记、没有就什么都不做——判空收在这一处。
 * 写入口（saveTerms / saveOneTerm）各写一遍 `source.urls.length > 0` 就是第二份口径，
 * 而这类"两处条件必须一致"的账本仓已经吃过几次（同 `review_in_scope` 只在服务端算的理由）。
 */
export function recordTermSourceIfAny(termIds: readonly string[], ownerId: string | null, source?: TermSourceInput): void {
  if (source && source.urls.length > 0) recordTermSources(termIds, ownerId, source.urls, source.origin);
}

function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
    return h || null;
  } catch {
    return null;
  }
}

/**
 * 给一批词条记来源。**幂等**：同一 (term_id, url) 只有一行（唯一索引兜着）。
 * 返回真正新增的行数（调用方拿它做诊断，不拿它做用户可见文案）。
 */
export function recordTermSources(
  termIds: readonly string[],
  ownerId: string | null,
  urls: readonly string[],
  origin: TermSourceOrigin,
): number {
  const hosts = urls
    .map((u) => ({ url: u, host: hostOf(u) }))
    .filter((x): x is { url: string; host: string } => Boolean(x.host))
    .slice(0, MAX_TERM_SOURCE_URLS);
  if (termIds.length === 0 || hosts.length === 0) return 0;
  const owner = ownerForWrite(ownerId);
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO term_source (id, owner_id, term_id, url, host, origin)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const id of termIds) {
    for (const h of hosts) added += ins.run(randomUUID(), owner, id, h.url, h.host, origin).changes;
  }
  return added;
}

/** 删词条时同步清来源（无外键，靠这一口；漏清只会让范围判定偏松，不会崩） */
export function deleteTermSources(termId: string, ownerId: string | null): void {
  getDb().prepare('DELETE FROM term_source WHERE term_id = ? AND owner_id = ?').run(termId, ownerForWrite(ownerId));
}

/** 这个人记过来源的词条 id 集合（诊断与测试用） */
export function termIdsWithSource(ownerId: string | null): Set<string> {
  const rows = getDb()
    .prepare('SELECT DISTINCT term_id FROM term_source WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ term_id: string }>;
  return new Set(rows.map((r) => r.term_id));
}

/**
 * **范围内**的词条 id 集合：任一来源 host 落在白名单里就算在内。
 *
 * ★ 返回 `null` 表示「不要过滤」——只有关闭应试模式时才会拿到 null。
 *   调用方一律写 `const ids = termIdsInScope(...); if (ids && !ids.has(row.id)) continue;`，
 *   不要写成「空集合也放行」，那等于把「范围内一个词都没有」渲染成「全都在范围内」。
 */
export function termIdsInScope(ownerId: string | null, hosts: readonly string[]): Set<string> | null {
  if (hosts.length === 0) return null; // 调用方没开模式（开而未选范围时它自己就不发外部检索，视图层同样不该过滤成空）
  const rows = getDb()
    .prepare('SELECT term_id, host FROM term_source WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ term_id: string; host: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (out.has(r.term_id)) continue;
    if (examHostAllowed(r.host, hosts)) out.add(r.term_id);
  }
  return out;
}

/** 某个词条的来源 host 列表（范围推导与调试用；顺序按写入时间） */
export function termSourceHosts(termId: string, ownerId: string | null): string[] {
  const rows = getDb()
    .prepare('SELECT host FROM term_source WHERE term_id = ? AND owner_id = ? ORDER BY created_at, id')
    .all(termId, ownerForWrite(ownerId)) as Array<{ host: string }>;
  return rows.map((r) => r.host);
}

/** 一条范围过滤子句：`clause` 是**裸谓词**（不含前导 AND），`args` 跟着占位符走 */
export interface TermScopeFilter {
  clause: string;
  args: unknown[];
  /** 开着模式但范围内一个词条都没有 ⇒ 空态文案用它；SQL 侧已由 `clause` 自己兜住 */
  none: boolean;
}

/**
 * 各读路径共用的那一句范围过滤。**只允许这一份实现**：
 * 词条页、知识大陆、复习队列、卡牌、刷词五处各自写一遍 `id IN (...)`，
 * 就会有一处忘了判空、一处把无来源的词当范围内——那正是「看起来过滤了、实际漏一条」的形状。
 *
 * ★ `clause` 存的是**裸谓词**（`1 = 0` 或 `t.id IN (?,?)`），不带前导 `AND`：
 *   一半调用方是"条件数组 + join(' AND ')"的写法（`listTerms`），另一半是字符串模板直拼
 *   （大陆/队列/卡牌）。子句自带前导 AND 时，前者会拼出 `... AND AND 1 = 0` 直接语法错
 *   ——2026-10-05 写这四个面的测试当场逮到。前缀由两种接线各自负责。
 * ★ 范围内为空时给 `1 = 0`，**不是** `IN ()`（SQLite 语法错），也不要求每个调用方记得早退：
 *   少一处"必须记得判空"就少一类静默崩，空态另外用 `none` 告诉调用方。
 *
 * @param hosts 生效域名；`null` 或空数组 ⇒ 返回 null（调用方**不加任何过滤**）
 */
export function termScopeFilter(ownerId: string | null, hosts: readonly string[] | null): TermScopeFilter | null {
  if (!hosts || hosts.length === 0) return null;
  const ids = termIdsInScope(ownerId, hosts);
  if (ids === null || ids.size === 0) return { clause: '1 = 0', args: [], none: true };
  const list = [...ids];
  return { clause: `t.id IN (${list.map(() => '?').join(',')})`, args: list, none: false };
}

/**
 * 按这个人当前的应试设置取过滤子句。
 * ★ 「开了模式但一个范围都没勾」返回 null（＝不过滤）：把整个词条库清空成"你还没有词"
 *   是拿一个配置缺失去惩罚用户的数据视图；那种情况该由空态文案说「先去设置里选范围」。
 */
export function termScopeFilterForOwner(ownerId: string | null): TermScopeFilter | null {
  const ctx = loadExamContext(ownerId);
  return termScopeFilter(ownerId, ctx.on && ctx.hosts.length > 0 ? ctx.hosts : null);
}

/**
 * 把范围子句**注入到调用方的 WHERE 条件数组**里，一行搞定（返回子句本身，供空态判 `none`）。
 *
 * 为什么是这个形状而不是返回 clause/args 让五处各自 push 两行：那五处每多写一行，
 * 就多一次"某处忘了判空 / 忘了加"的机会——本仓的教训是这类漏口不报错，只让范围看起来生效了。
 */
export function applyTermScope(ownerId: string | null, conds: string[], args: unknown[]): TermScopeFilter | null {
  const scope = termScopeFilterForOwner(ownerId);
  if (scope) {
    conds.push(scope.clause);
    args.push(...scope.args);
  }
  return scope;
}

/**
 * 给"一条写死的 SQL"用的形态：返回可直接拼进 WHERE 尾部的片段与参数（未开过滤 ⇒ 空片段）。
 * 与 `applyTermScope` 是同一个判据的两种接线，不另立口径。
 */
export function termScopeSql(ownerId: string | null): { sql: string; args: unknown[] } {
  const scope = termScopeFilterForOwner(ownerId);
  return scope ? { sql: ` AND ${scope.clause}`, args: scope.args } : { sql: '', args: [] };
}

/** 范围内词条数；`null` ＝ 没开过滤。空态文案要说「范围内目前 0 个词条」，不靠前端数返回条数 */
export function termScopeCount(ownerId: string | null): number | null {
  const f = termScopeFilterForOwner(ownerId);
  return f === null ? null : f.args.length;
}
