/**
 * learning/knowledge-graph — **知识数据图**读写（学习产物层，契约 docs/STUDY-FLOW-SPEC.md §3）。
 *
 * 与 `learning/study-flow.ts`（控制流：定义 + 运行）严格分家：那个管「学习流怎么走」，
 * 这个管「走完留下了什么」。两者只在运行器写产物时单向相交，互不反向依赖。
 *
 * ★★ 三条不可省的约束（改码前必读）：
 *  1. **节点只存引用 + 抗删快照，不复制正文**。`ref_id` 指向 `term_library.id` /
 *     `quiz_notes.id` / `messages.id`，正文仍在原表；`ref_text` 是抗删快照，
 *     源行删除后图仍自洽可读（同 `evolution_event.term_text` 手法，第五次复用）。
 *  2. **边必须区分出处**（`origin`）。AI 抽取（`ai`，可能幻觉）/ 用户手搭（`user`，最高可信）
 *     / 结构推导（`derived`，可被规则重算与批量撤销）三值**刻意不平权**。混作一谈，
 *     模型幻觉出的关系就再也纠不回来。撤销接口因此**只准批量删 `derived`**。
 *  3. **幂等一律交给库约束**：`UNIQUE(kind, ref_id)` 与 `UNIQUE(from_node_id, to_node_id, kind)`
 *     配 `INSERT OR IGNORE`，不靠调用方记得只调一次（同 `pk_matches` 手法）。
 *
 * ★ 邻域查询**只返回局部子图**、不返回全图：词条级全图到万级节点会拖死前端渲染，
 *   而用户真正要看的是「当前这个词条跟谁有关系」。截断时**如实置 `truncated`**（ADR-5 不静默），
 *   不静默把局部图当成全图给出去。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import type {
  KnowledgeEdge,
  KnowledgeEdgeKind,
  KnowledgeEdgeOrigin,
  KnowledgeGraphStats,
  KnowledgeNeighborhood,
  KnowledgeNode,
  KnowledgeNodeKind,
} from '@sb/shared';

/** 邻域展开上限：深度与总节点数（超了如实截断，见文件头注释） */
export const NEIGHBORHOOD_MAX_DEPTH = 3;
export const NEIGHBORHOOD_MAX_NODES = 60;

interface NodeRow {
  id: string;
  kind: string;
  ref_id: string | null;
  ref_text: string;
  source_run_id: string | null;
  source_step_id: string | null;
  created_at: string;
}

interface EdgeRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  kind: string;
  origin: string;
  weight: number;
  evidence: string | null;
  created_at: string;
}

const toNode = (r: NodeRow): KnowledgeNode => ({
  id: r.id,
  kind: r.kind as KnowledgeNodeKind,
  refId: r.ref_id,
  refText: r.ref_text,
  sourceRunId: r.source_run_id,
  sourceStepId: r.source_step_id,
  createdAt: r.created_at,
});

const toEdge = (r: EdgeRow): KnowledgeEdge => ({
  id: r.id,
  fromNodeId: r.from_node_id,
  toNodeId: r.to_node_id,
  kind: r.kind as KnowledgeEdgeKind,
  origin: r.origin as KnowledgeEdgeOrigin,
  weight: r.weight,
  evidence: r.evidence,
  createdAt: r.created_at,
});

// ── 节点 ──

/**
 * 登记一个知识节点（幂等）。`kind`+`refId` 已存在则**返回既有节点**、不新建
 * （同一词条在两条流里被沉淀，图上仍是一个点——这正是「学习历程图」要的语义）。
 * `refId` 为 null 的 `concept` 节点每次都新建（SQLite 的 UNIQUE 允许多个 NULL）。
 */
export function ensureNode(input: {
  kind: KnowledgeNodeKind;
  refId?: string | null;
  refText: string;
  sourceRunId?: string | null;
  sourceStepId?: string | null;
  ownerId: string | null; // M2d-3：knowledge_node 归主（v33）——此前全站一张图，A 的节点 B 能看见
}): KnowledgeNode {
  const db = getDb();
  const owner = ownerForWrite(input.ownerId);
  const refId = input.refId ?? null;
  if (refId) {
    const found = db
      .prepare('SELECT * FROM knowledge_node WHERE kind = ? AND ref_id = ? AND owner_id = ?')
      .get(input.kind, refId, owner) as NodeRow | undefined;
    if (found) return toNode(found);
  }
  const id = randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_node (id, kind, ref_id, ref_text, source_run_id, source_step_id, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.kind, refId, input.refText.slice(0, 500), input.sourceRunId ?? null, input.sourceStepId ?? null, owner);
  const row = db.prepare('SELECT * FROM knowledge_node WHERE id = ?').get(id) as NodeRow;
  return toNode(row);
}

export function getNode(id: string, ownerId: string | null): KnowledgeNode | null {
  const row = getDb()
    .prepare('SELECT * FROM knowledge_node WHERE id = ? AND owner_id = ?')
    .get(id, ownerForWrite(ownerId)) as NodeRow | undefined;
  return row ? toNode(row) : null;
}

export function listNodes(ownerId: string | null, kind?: KnowledgeNodeKind, limit = 200): KnowledgeNode[] {
  const db = getDb();
  const cap = Math.min(Math.max(limit, 1), 1000);
  const rows = (
    kind
      ? db.prepare('SELECT * FROM knowledge_node WHERE kind = ? AND owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(kind, ownerForWrite(ownerId), cap)
      : db.prepare('SELECT * FROM knowledge_node WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(ownerForWrite(ownerId), cap)
  ) as NodeRow[];
  return rows.map(toNode);
}

/** 一次运行产出的全部节点（运行详情页「本次学到了什么」用） */
export function nodesOfRun(runId: string, ownerId: string | null): KnowledgeNode[] {
  const rows = getDb()
    .prepare('SELECT * FROM knowledge_node WHERE source_run_id = ? AND owner_id = ? ORDER BY created_at, rowid')
    .all(runId, ownerForWrite(ownerId)) as NodeRow[];
  return rows.map(toNode);
}

// ── 边 ──

/**
 * 立一条语义边（幂等）。同 `(from, to, kind)` 已存在时**返回既有边**、不新建
 * ——重复抽取不会把权重刷成两条。
 * ★ `origin` 决定可信层级，调用方必须显式给：AI 抽取传 `'ai'`、用户手搭传 `'user'`、
 *   结构推导传 `'derived'`。**不给默认值**，避免把「AI 猜的」混进「用户确认的」。
 */
export function addEdge(input: {
  fromNodeId: string;
  toNodeId: string;
  kind: KnowledgeEdgeKind;
  origin: KnowledgeEdgeOrigin;
  weight?: number;
  evidence?: string | null;
  ownerId: string | null; // M2d-3：knowledge_edge 归主（v33）
}): KnowledgeEdge | null {
  const db = getDb();
  const owner = ownerForWrite(input.ownerId);
  if (input.fromNodeId === input.toNodeId) return null; // 自环无意义，静默丢弃
  const existing = db
    .prepare('SELECT * FROM knowledge_edge WHERE from_node_id = ? AND to_node_id = ? AND kind = ? AND owner_id = ?')
    .get(input.fromNodeId, input.toNodeId, input.kind, owner) as EdgeRow | undefined;
  if (existing) return toEdge(existing);
  const id = randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_edge (id, from_node_id, to_node_id, kind, origin, weight, evidence, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.fromNodeId,
    input.toNodeId,
    input.kind,
    input.origin,
    Math.min(1, Math.max(0, input.weight ?? 0.5)),
    input.evidence ?? null,
    owner,
  );
  const row = db.prepare('SELECT * FROM knowledge_edge WHERE id = ?').get(id) as EdgeRow | undefined;
  return row ? toEdge(row) : null;
}

/** 删一条边（用户手工纠正 AI 的幻觉边时用） */
export function removeEdge(id: string, ownerId: string | null): boolean {
  return getDb()
    .prepare('DELETE FROM knowledge_edge WHERE id = ? AND owner_id = ?')
    .run(id, ownerForWrite(ownerId)).changes === 1;
}

/**
 * 批量撤销**结构推导**的边。
 * ★ 刻意只准删 `derived`：`ai` 边要用户逐条看过再删（可能是有价值的关系），
 *   `user` 边是用户自己搭的、更不该被程序清掉。给规则一个「重算」的后悔药，
 *   但不给程序一个「一键清空用户劳动成果」的危险能力。
 */
export function purgeDerivedEdges(ownerId: string | null): number {
  return getDb()
    .prepare(`DELETE FROM knowledge_edge WHERE origin = 'derived' AND owner_id = ?`)
    .run(ownerForWrite(ownerId)).changes;
}

// ── 邻域查询（前端局部图渲染的唯一入口）──

export function neighborhood(nodeId: string, ownerId: string | null, depth = 2): KnowledgeNeighborhood | null {
  const center = getNode(nodeId, ownerId);
  if (!center) return null;
  const db = getDb();
  const maxDepth = Math.min(Math.max(depth, 1), NEIGHBORHOOD_MAX_DEPTH);
  const nodes = new Map<string, KnowledgeNode>([[center.id, center]]);
  const edges = new Map<string, KnowledgeEdge>();
  let frontier = [center.id];
  let truncated = false;

  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const placeholders = frontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_edge
         WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
         ORDER BY weight DESC`,
      )
      .all(...frontier, ...frontier) as EdgeRow[];
    const next: string[] = [];
    for (const r of rows) {
      edges.set(r.id, toEdge(r));
      for (const nid of [r.from_node_id, r.to_node_id]) {
        if (nodes.has(nid)) continue;
        if (nodes.size >= NEIGHBORHOOD_MAX_NODES) {
          truncated = true;
          continue;
        }
        const n = getNode(nid, ownerId);
        if (!n) continue;
        nodes.set(nid, n);
        next.push(nid);
      }
    }
    frontier = next;
  }

  return {
    center,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
  };
}

// ── 结构推导（origin='derived' 的唯一产地）──

/**
 * 为给定节点补「同域相关」边：同一 `term_library.domain` 的词条两两 `relates`。
 * ★ 这是**规则可重算**的边，故一律 `origin='derived'`、`evidence` 记规则名——
 *   将来换更聪明的推导（共现 / 引用 / 前置关系）时，`purgeDerivedEdges()` 一清即可，
 *   不会伤到 AI 抽取与用户手搭的边。
 * ★ 已知边界：同域词条多时是 O(n²)，故本函数**由调用方限定同域节点数**（见 SPEC §13 未验账）。
 * ★ v31（M2d-2）：`ownerId` 必传——`ref_id` 指向的 `term_library` 已归主。传进来的 id
 *   本来就该是同一批，但**「同域」这个判据现在含 owner**（A、B 各有一个 `math` 域，
 *   它们的词条不是「同域」）⇒ 不带归属会把两个用户的词条连成一条 derived 边。
 */
export function deriveDomainEdges(termNodeIds: string[], ownerId: string | null): number {
  if (termNodeIds.length < 2) return 0;
  const db = getDb();
  const placeholders = termNodeIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, ref_id FROM knowledge_node WHERE id IN (${placeholders}) AND owner_id = ?`)
    .all(...termNodeIds, ownerForWrite(ownerId)) as Array<Pick<NodeRow, 'id' | 'ref_id'>>;
  const refIds = rows.map((r) => r.ref_id).filter((v): v is string => typeof v === 'string');
  if (refIds.length < 2) return 0;
  const ph2 = refIds.map(() => '?').join(',');
  const terms = db
    .prepare(`SELECT id, domain FROM term_library WHERE id IN (${ph2}) AND owner_id = ?`)
    .all(...refIds, ownerForWrite(ownerId)) as Array<{ id: string; domain: string }>;
  const nodeOfTerm = new Map(rows.map((r) => [r.ref_id ?? '', r.id]));
  const byDomain = new Map<string, string[]>();
  for (const t of terms) {
    const nid = nodeOfTerm.get(t.id);
    if (!nid) continue;
    const list = byDomain.get(t.domain) ?? [];
    list.push(nid);
    byDomain.set(t.domain, list);
  }
  let made = 0;
  for (const [domain, ids] of byDomain) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (addEdge({ fromNodeId: ids[i]!, toNodeId: ids[j]!, kind: 'relates', origin: 'derived', weight: 0.3, evidence: `同域：${domain}`, ownerId })) {
          made++;
        }
      }
    }
  }
  return made;
}

/**
 * 本步跑出的词条 → 知识节点（+ 同域 derived 边）。
 *
 * ★ 为什么在这里（2026-09-18 v31 M2d-2 从 `study-flow-run.ts` 移入）：那个文件加归属后
 *   涨到 405 行触 server ≤400 红线，照仓规**拆文件、不压注释**。接缝是「**走完留下了什么**」
 *   ——正是本文件宪章（见文件头：控制流归 study-flow.ts，产物层归本文件），且本文件
 *   已经在读 `term_library`（`deriveDomainEdges` 就是），不引入新的表依赖。
 *   ⇒ `study-flow-run.ts` 只留「怎么走」（状态机），本文件收「留下了什么」。
 *
 * 定位办法：`term_library.source_session_id = 本会话` 且 `created_at >= 本步开始时刻`。
 * ★ 时间窗用的是 SQLite 自己的 `datetime('now')`（UTC，秒级），与写入端同源，故可直接字符串比较。
 * ★ v31 起必须带 `owner_id`：不加就会把**别人**在同时刻落的词条也认成本步产出。
 */
export function emitTermNodes(
  runId: string,
  stepId: string,
  sessionId: string,
  startedAt: string,
  ownerId: string | null,
): void {
  const rows = getDb()
    .prepare(
      `SELECT id, term FROM term_library
       WHERE source_session_id = ? AND created_at >= ? AND owner_id = ?
       ORDER BY created_at, rowid`,
    )
    .all(sessionId, startedAt, ownerForWrite(ownerId)) as Array<{ id: string; term: string }>;
  if (rows.length === 0) return;
  const nodeIds = rows.map(
    (t) =>
      ensureNode({ kind: 'term', refId: t.id, refText: t.term, sourceRunId: runId, sourceStepId: stepId, ownerId }).id,
  );
  deriveDomainEdges(nodeIds, ownerId);
}

// ── 统计 ──

export function graphStats(ownerId: string | null): KnowledgeGraphStats {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const total = (sql: string): number => (db.prepare(sql).get(owner) as { c: number }).c;
  const byKind = db
    .prepare('SELECT kind, COUNT(*) AS c FROM knowledge_node WHERE owner_id = ? GROUP BY kind ORDER BY c DESC')
    .all(owner) as Array<{ kind: string; c: number }>;
  const byOrigin = db
    .prepare('SELECT origin, COUNT(*) AS c FROM knowledge_edge WHERE owner_id = ? GROUP BY origin ORDER BY c DESC')
    .all(owner) as Array<{ origin: string; c: number }>;
  return {
    nodes: total('SELECT COUNT(*) AS c FROM knowledge_node WHERE owner_id = ?'),
    edges: total('SELECT COUNT(*) AS c FROM knowledge_edge WHERE owner_id = ?'),
    byKind: byKind.map((r) => ({ kind: r.kind as KnowledgeNodeKind, count: r.c })),
    byOrigin: byOrigin.map((r) => ({ origin: r.origin as KnowledgeEdgeOrigin, count: r.c })),
  };
}
