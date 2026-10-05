/**
 * learning/term-source — 词条的**真来源**登记与范围过滤（迁移 v55，契约 EXAM-MODE-SPEC §7）。
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
