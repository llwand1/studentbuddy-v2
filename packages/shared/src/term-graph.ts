/**
 * term-graph — 词条关系图的共享契约（服务端 `learning/term-graph.ts` 写、对话检索与词条页读）。
 *
 * ★ 为什么要图：检索原来只按字面匹配（问"光反应"只捞得到名字里含"光反应"的词条），而学习上真正
 *   有用的往往是**邻居**——它的前置概念、它的组成部分、最容易混淆的那个。关系由 AI 在词条入库后
 *   后台抽取（任务队列 `term.relate`），对话注入时把命中词条的一跳邻居一起带上。
 * ★ 方向：`prerequisite`（a 是学 b 的前置）、`part_of`（a 是 b 的一部分）、`example_of`（a 是 b 的例子）
 *   有向；`contrast`（易混淆）与 `related` 无向——无向边落库时按 id 排序存一行，免得同一对存两次。
 */
export const TERM_RELATIONS = ['prerequisite', 'part_of', 'example_of', 'contrast', 'related'] as const;
export type TermRelation = (typeof TERM_RELATIONS)[number];

export const UNDIRECTED_RELATIONS: ReadonlySet<TermRelation> = new Set<TermRelation>(['contrast', 'related']);

/** 从"本词条"视角看这条边的中文说法。`outgoing`＝本词条是 a 端 */
export function relationLabel(rel: TermRelation, outgoing: boolean): string {
  switch (rel) {
    case 'prerequisite':
      return outgoing ? '是它的前置' : '需要先懂';
    case 'part_of':
      return outgoing ? '属于' : '包含';
    case 'example_of':
      return outgoing ? '是它的例子' : '例子';
    case 'contrast':
      return '易混淆';
    default:
      return '相关';
  }
}

export interface TermRelationView {
  termId: string;
  term: string;
  relation: TermRelation;
  /** 本词条是否为边的 a 端（决定中文说法） */
  outgoing: boolean;
  label: string;
  note: string;
}

export interface RawEdge {
  a: string;
  b: string;
  relation: TermRelation;
  note: string;
}

/**
 * 校验模型输出的关系列表。只收：两端都在给定名字集合里、两端不同、关系在白名单里的边；
 * 名字按去空白后精确匹配（模型改写过的名字宁可丢，也不连错节点）。上限 `max` 条。
 */
export function parseRelations(raw: string, names: ReadonlySet<string>, max = 40): RawEdge[] | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const list = (o as { edges?: unknown })?.edges;
  if (!Array.isArray(list)) return null;
  const out: RawEdge[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const a = typeof r.a === 'string' ? r.a.trim() : '';
    const b = typeof r.b === 'string' ? r.b.trim() : '';
    const relation = r.relation as TermRelation;
    if (!names.has(a) || !names.has(b) || a === b || !TERM_RELATIONS.includes(relation)) continue;
    const key = UNDIRECTED_RELATIONS.has(relation) ? [relation, ...[a, b].sort()].join('|') : `${relation}|${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, relation, note: typeof r.note === 'string' ? r.note.trim().slice(0, 80) : '' });
    if (out.length >= max) break;
  }
  return out;
}
