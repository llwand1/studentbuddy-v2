/**
 * learning/term-graph — 词条关系图：AI 后台抽关系（任务 `term.relate`）＋ 读邻居（词条页、对话检索）。
 *
 * ★ 触发：新词条入库发 `term_added`（带 termIds）⇒ `wireTermGraph` 派发一个后台任务。放后台是因为
 *   入库常发生在对话收尾，用户不该为"顺便连个图"多等一次模型调用；失败按队列退避重试。
 * ★ 候选：把新词条与**最多 40 个**已有词条一起给模型（同领域优先、再按重要度）——全库几百条
 *   塞进去既贵又让模型乱连；跨领域的关系少而珍贵，靠重要度那一截兜住。
 * ★ 名字 → id：模型只看名字；回来的边按名字映射，同名多条（不同领域）时优先新词条。
 */
import { randomUUID } from 'node:crypto';
import type { RawEdge, TermRelationView } from '@sb/shared';
import { UNDIRECTED_RELATIONS, parseRelations, relationLabel } from '@sb/shared';
import type { TermRelation } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { aiJson } from '../ai/gateway.js';
import { subscribeEvents } from '../events/bus.js';
import { dispatchJob, PermanentJobError, registerJobHandler } from '../jobs/worker.js';
import type { TermRow } from './terms.js';

export const RELATE_JOB = 'term.relate';
const MAX_CANDIDATES = 40;
const MAX_NEW = 12;

interface Brief {
  id: string;
  term: string;
  definition: string;
  domain: string;
}

function briefs(owner: string, newIds: string[]): { fresh: Brief[]; others: Brief[] } {
  const db = getDb();
  const ids = newIds.slice(0, MAX_NEW);
  if (ids.length === 0) return { fresh: [], others: [] };
  const ph = ids.map(() => '?').join(',');
  const fresh = db
    .prepare(`SELECT id, term, definition, domain FROM term_library WHERE owner_id = ? AND id IN (${ph})`)
    .all(owner, ...ids) as Brief[];
  const domains = [...new Set(fresh.map((f) => f.domain))];
  const dph = domains.map(() => '?').join(',') || "''";
  const others = db
    .prepare(
      `SELECT id, term, definition, domain FROM term_library
        WHERE owner_id = ? AND id NOT IN (${ph})
        ORDER BY CASE WHEN domain IN (${dph}) THEN 0 ELSE 1 END, importance DESC, updated_at DESC LIMIT ?`,
    )
    .all(owner, ...ids, ...domains, MAX_CANDIDATES) as Brief[];
  return { fresh, others };
}

const SYSTEM = `你在帮学生整理知识网络。给你一组「新词条」和一组「已有词条」，找出它们之间**确实成立**的关系。
关系只有五种：
- prerequisite：a 是理解 b 的前置知识（有向）
- part_of：a 是 b 的组成部分/子概念（有向）
- example_of：a 是 b 的一个具体例子（有向）
- contrast：a 与 b 容易混淆，需要对比着学（无向）
- related：同一主题下紧密相关，但不属于以上四种（无向，少用）
规则：每条边至少一端是新词条；只连有把握的，宁缺毋滥；名字必须与给出的**逐字一致**；note 用一句话说明为什么（≤30 字）。
只输出 JSON：{"edges":[{"a":"名字","b":"名字","relation":"…","note":"…"}]}，没有可连的就输出 {"edges":[]}。`;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function buildRelateMessages(fresh: Brief[], others: Brief[]) {
  const line = (b: Brief) => `- ${b.term}（${b.domain}）：${clip(b.definition, 80)}`;
  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `【新词条】\n${fresh.map(line).join('\n')}\n\n【已有词条】\n${others.map(line).join('\n') || '（暂无）'}` },
  ];
}

/** 落边：名字映射成 id（同名优先新词条），无向边按 id 排序；返回新写入条数 */
export function saveEdges(ownerId: string | null, edges: RawEdge[], fresh: Brief[], others: Brief[]): number {
  const owner = ownerForWrite(ownerId);
  const byName = new Map<string, string>();
  for (const b of [...others, ...fresh]) byName.set(b.term, b.id); // 后写覆盖 ⇒ 新词条优先
  const ins = getDb().prepare('INSERT OR IGNORE INTO term_edge (id, owner_id, a_id, b_id, relation, note) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  getDb().transaction(() => {
    for (const e of edges) {
      let a = byName.get(e.a);
      let b = byName.get(e.b);
      if (!a || !b || a === b) continue;
      if (UNDIRECTED_RELATIONS.has(e.relation) && a > b) [a, b] = [b, a];
      n += ins.run(randomUUID(), owner, a, b, e.relation, e.note).changes;
    }
  })();
  return n;
}

/** 任务本体。没配模型 ⇒ 永久失败；上游/超时 ⇒ 抛错交给队列退避；输出不成形 ⇒ 当作"没连出来"，不重试 */
export async function relateTerms(payload: { termIds?: unknown }, ownerId: string | null): Promise<number> {
  const ids = Array.isArray(payload.termIds) ? payload.termIds.filter((x): x is string => typeof x === 'string') : [];
  const { fresh, others } = briefs(ownerForWrite(ownerId), ids);
  if (fresh.length === 0 || fresh.length + others.length < 2) return 0;
  const names = new Set([...fresh, ...others].map((b) => b.term));
  const r = await aiJson({
    purpose: 'term.relate',
    ownerId,
    messages: buildRelateMessages(fresh, others),
    parse: (t) => parseRelations(t, names),
  });
  if (!r.ok) {
    if (r.reason === 'no-model') throw new PermanentJobError(r.error);
    if (r.reason === 'parse') return 0;
    throw new Error(r.error);
  }
  return saveEdges(ownerId, r.value, fresh, others);
}

registerJobHandler(RELATE_JOB, '整理词条关系', async (payload, ctx) => {
  await relateTerms(payload as { termIds?: unknown }, ctx.ownerId);
});

let wired = false;
/** 新词条入库 ⇒ 派发关系任务（index 启动时接线；单测不接，免得每次存词条都触发内联任务） */
export function wireTermGraph(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type !== 'term_added' || !ev.termIds || ev.termIds.length === 0) return;
    const ids = [...ev.termIds].sort();
    dispatchJob({ kind: RELATE_JOB, ownerId: ev.ownerId, payload: { termIds: ids }, dedupeKey: `relate:${ownerForWrite(ev.ownerId)}:${ids.join(',')}`.slice(0, 300) });
  });
}

/** 某词条的全部关系（两个方向），JOIN 回词条表过滤悬空边 */
export function termRelations(ownerId: string | null, termId: string): TermRelationView[] {
  const rows = getDb()
    .prepare(
      `SELECT e.relation, e.note, e.a_id, t.id AS other_id, t.term AS other
         FROM term_edge e JOIN term_library t ON t.id = CASE WHEN e.a_id = ? THEN e.b_id ELSE e.a_id END AND t.owner_id = e.owner_id
        WHERE e.owner_id = ? AND (e.a_id = ? OR e.b_id = ?)
        ORDER BY e.relation, t.term`,
    )
    .all(termId, ownerForWrite(ownerId), termId, termId) as Array<{ relation: TermRelation; note: string; a_id: string; other_id: string; other: string }>;
  return rows.map((r) => {
    const outgoing = r.a_id === termId;
    return { termId: r.other_id, term: r.other, relation: r.relation, outgoing, label: relationLabel(r.relation, outgoing), note: r.note };
  });
}

/**
 * 混合检索的"图"那一半：字面命中的词条 ⇒ 一跳邻居（去掉已命中的），前置与易混淆优先。
 * ★ 只扩一跳、最多 `limit` 条：两跳以上在几百条词条的库里基本等于"全库"，只会稀释注入段。
 */
export function neighborTerms(ownerId: string | null, hits: TermRow[], limit = 6): TermRow[] {
  if (hits.length === 0 || limit <= 0) return [];
  const owner = ownerForWrite(ownerId);
  const ids = hits.map((h) => h.id);
  const ph = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT t.*, MIN(CASE e.relation WHEN 'prerequisite' THEN 0 WHEN 'contrast' THEN 1 WHEN 'part_of' THEN 2 ELSE 3 END) AS pri
         FROM term_edge e
         JOIN term_library t ON t.owner_id = e.owner_id AND t.id = CASE WHEN e.a_id IN (${ph}) THEN e.b_id ELSE e.a_id END
        WHERE e.owner_id = ? AND (e.a_id IN (${ph}) OR e.b_id IN (${ph})) AND t.id NOT IN (${ph})
        GROUP BY t.id ORDER BY pri, t.importance DESC LIMIT ?`,
    )
    .all(...ids, owner, ...ids, ...ids, ...ids, limit) as Array<TermRow & { pri: number }>;
  return rows.map(({ pri: _pri, ...t }) => t as TermRow);
}
