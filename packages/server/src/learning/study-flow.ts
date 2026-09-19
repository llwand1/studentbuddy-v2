/**
 * learning/study-flow — 学习流**定义层**（控制流的模板部分：`flow_def` / `flow_step` / `flow_edge`）。
 * 契约 docs/STUDY-FLOW-SPEC.md §2。运行器在 `learning/study-flow-run.ts`，两层严格分家。
 *
 * ★ 定义 = 用户编排并**固化**下来的学习流（「固定化」是需求原话）：可保存、可复用、
 *   可克隆改一版。节点是「一种学习交互体验」（注册表键 + 参数），边是执行顺序。
 *
 * ★★ 两条不可省的校验（改码前必读）：
 *  1. **步骤类型必须命中注册表**：`kind` 不是自由文本，参数逐项过 `validateStepParams`。
 *     「用户可编排」与「用户可创造交互」的边界就画在这里（SPEC §1.3 范围红线）。
 *  2. **边的两端必须在本定义的步骤集合内**：悬空边会让运行器在推进时找不到下一步。
 *     宁可保存时当场 400，也不留一条跑到一半才炸的流。
 *
 * ★ 为什么定义自带 `version`：每次保存结构变更递增。运行实例会**快照**当时的定义
 *   （见 `study-flow-run.ts` 的 createRun），故「用户改完定义」不会污染历史运行的回放。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import type { FlowDef, FlowDefInput, FlowEdgeDef, FlowPort, FlowStepDef, FlowStepKind } from '@sb/shared';
import { validateStepParams } from './flow-registry.js';

interface DefRow {
  id: string;
  name: string;
  description: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  def_id: string;
  kind: string;
  type_version: number;
  label: string;
  params: string;
  position_x: number;
  position_y: number;
  order_index: number;
  created_at: string;
}

interface EdgeRow {
  id: string;
  def_id: string;
  from_step_id: string;
  to_step_id: string;
  from_port: string;
  label: string;
  created_at: string;
}

const toStep = (r: StepRow): FlowStepDef => ({
  id: r.id,
  defId: r.def_id,
  kind: r.kind as FlowStepKind,
  typeVersion: r.type_version,
  label: r.label,
  params: safeJson(r.params),
  position: { x: r.position_x, y: r.position_y },
  orderIndex: r.order_index,
  createdAt: r.created_at,
});

const toEdge = (r: EdgeRow): FlowEdgeDef => ({
  id: r.id,
  defId: r.def_id,
  fromStepId: r.from_step_id,
  toStepId: r.to_step_id,
  fromPort: r.from_port as FlowPort,
  label: r.label,
});

/** params 坏值回落空对象（ADR-4：坏数据不该让整条流读不出来） */
function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const VALID_PORTS: FlowPort[] = ['next', 'correct', 'wrong'];

// ── 校验（纯函数，先校完再落库，绝不写半截）──

export type DefCheck = { ok: true; steps: PreparedStep[]; edges: PreparedEdge[] } | { ok: false; error: string };

interface PreparedStep {
  id: string;
  kind: FlowStepKind;
  typeVersion: number;
  label: string;
  params: Record<string, unknown>;
  positionX: number;
  positionY: number;
  orderIndex: number;
}

interface PreparedEdge {
  fromStepId: string;
  toStepId: string;
  fromPort: FlowPort;
  label: string;
}

export function validateDefInput(input: unknown): DefCheck {
  const src = input && typeof input === 'object' ? (input as FlowDefInput) : ({} as FlowDefInput);
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!name) return { ok: false, error: 'name 必填' };
  if (name.length > 60) return { ok: false, error: 'name 过长（≤60 字）' };

  const rawSteps = Array.isArray(src.steps) ? src.steps : [];
  if (rawSteps.length === 0) return { ok: false, error: '一条学习流至少要有 1 个步骤' };
  if (rawSteps.length > 50) return { ok: false, error: '步骤过多（≤50）' };

  const steps: PreparedStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i]!;
    const check = validateStepParams(String(s?.kind ?? ''), s?.params ?? {});
    if (!check.ok) return { ok: false, error: check.error };
    const id = typeof s?.id === 'string' && s.id.trim() ? s.id.trim() : randomUUID();
    if (seen.has(id)) return { ok: false, error: `步骤 id 重复：${id}——每个节点 id 必须唯一` };
    seen.add(id);
    const px = s?.position?.x;
    const py = s?.position?.y;
    steps.push({
      id,
      kind: s.kind,
      typeVersion: 1,
      label: typeof s?.label === 'string' ? s.label.trim().slice(0, 40) : '',
      params: check.params,
      positionX: typeof px === 'number' && Number.isFinite(px) ? px : 80 + i * 200,
      positionY: typeof py === 'number' && Number.isFinite(py) ? py : 80,
      orderIndex: typeof s?.orderIndex === 'number' && Number.isFinite(s.orderIndex) ? s.orderIndex : i,
    });
  }

  const rawEdges = Array.isArray(src.edges) ? src.edges : [];
  const edges: PreparedEdge[] = [];
  const edgeSeen = new Set<string>();
  for (const e of rawEdges) {
    const from = typeof e?.fromStepId === 'string' ? e.fromStepId.trim() : '';
    const to = typeof e?.toStepId === 'string' ? e.toStepId.trim() : '';
    if (!from || !to) return { ok: false, error: '边必须同时给 fromStepId 与 toStepId' };
    if (!seen.has(from) || !seen.has(to)) {
      return { ok: false, error: `边引用了本流不存在的步骤（${seen.has(from) ? to : from}）——悬空边会让运行器找不到下一步` };
    }
    const port = (e?.fromPort ?? 'next') as FlowPort;
    if (!VALID_PORTS.includes(port)) {
      return { ok: false, error: `边的出口只能是 ${VALID_PORTS.join(' / ')} 之一` };
    }
    const key = `${from}\u0000${port}\u0000${to}`;
    if (edgeSeen.has(key)) continue; // 重复边静默去重（库上也有 UNIQUE，这里是友好处理）
    edgeSeen.add(key);
    edges.push({ fromStepId: from, toStepId: to, fromPort: port, label: String(e?.label ?? '') });
  }

  return { ok: true, steps, edges };
}

// ── 定义读写 ──

const readSteps = (defId: string): FlowStepDef[] =>
  (
    getDb()
      .prepare('SELECT * FROM flow_step WHERE def_id = ? ORDER BY order_index, rowid')
      .all(defId) as StepRow[]
  ).map(toStep);

const readEdges = (defId: string): FlowEdgeDef[] =>
  (getDb().prepare('SELECT * FROM flow_edge WHERE def_id = ? ORDER BY rowid').all(defId) as EdgeRow[]).map(toEdge);

export function getDef(id: string, ownerId: string | null): FlowDef | null {
  const row = getDb()
    .prepare('SELECT * FROM flow_def WHERE id = ? AND owner_id = ?')
    .get(id, ownerForWrite(ownerId)) as DefRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    steps: readSteps(row.id),
    edges: readEdges(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDefs(ownerId: string | null): FlowDef[] {
  const rows = getDb()
    .prepare('SELECT * FROM flow_def WHERE owner_id = ? ORDER BY updated_at DESC, rowid DESC')
    .all(ownerForWrite(ownerId)) as DefRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    steps: readSteps(row.id),
    edges: readEdges(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function writeStepsAndEdges(defId: string, steps: PreparedStep[], edges: PreparedEdge[]): void {
  const db = getDb();
  const insStep = db.prepare(
    `INSERT INTO flow_step (id, def_id, kind, type_version, label, params, position_x, position_y, order_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of steps) {
    insStep.run(s.id, defId, s.kind, s.typeVersion, s.label, JSON.stringify(s.params), s.positionX, s.positionY, s.orderIndex);
  }
  const insEdge = db.prepare(
    `INSERT INTO flow_edge (id, def_id, from_step_id, to_step_id, from_port, label) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const e of edges) {
    insEdge.run(randomUUID(), defId, e.fromStepId, e.toStepId, e.fromPort, e.label.slice(0, 40));
  }
}

export type CreateDefResult = { ok: true; def: FlowDef } | { ok: false; error: string };

export function createDef(input: unknown, ownerId: string | null): CreateDefResult {
  const check = validateDefInput(input);
  if (!check.ok) return check;
  const src = input as FlowDefInput;
  const db = getDb();
  const id = randomUUID();
  const description = typeof src.description === 'string' ? src.description.trim().slice(0, 300) : '';
  db.transaction(() => {
    db.prepare('INSERT INTO flow_def (id, name, description, version, owner_id) VALUES (?, ?, ?, 1, ?)').run(
      id,
      String(src.name).trim().slice(0, 60),
      description,
      ownerForWrite(ownerId),
    );
    writeStepsAndEdges(id, check.steps, check.edges);
  })();
  return { ok: true, def: getDef(id, ownerId)! };
}

/**
 * 整体替换式更新（步骤与边全删重建）。
 * ★ 之所以不做逐节点 diff：定义的规模是「人画得出来的量级」（≤50 步），
 *   整体重建的代价可忽略，而 diff 会引入一大片易错状态机。**版本号递增**供运行快照区分。
 * ★ 已跑过的运行**不受影响**——它们用的是自己的 `def_snapshot`。
 */
export function updateDef(id: string, input: unknown, ownerId: string | null): CreateDefResult {
  const existing = getDb()
    .prepare('SELECT id, version FROM flow_def WHERE id = ? AND owner_id = ?')
    .get(id, ownerForWrite(ownerId)) as
    | { id: string; version: number }
    | undefined;
  if (!existing) return { ok: false, error: '学习流不存在' };
  const check = validateDefInput(input);
  if (!check.ok) return check;
  const src = input as FlowDefInput;
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM flow_step WHERE def_id = ?').run(id);
    db.prepare('DELETE FROM flow_edge WHERE def_id = ?').run(id);
    db.prepare(
      `UPDATE flow_def SET name = ?, description = ?, version = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      String(src.name).trim().slice(0, 60),
      typeof src.description === 'string' ? src.description.trim().slice(0, 300) : '',
      existing.version + 1,
      id,
    );
    writeStepsAndEdges(id, check.steps, check.edges);
  })();
  return { ok: true, def: getDef(id, ownerId)! };
}

/** 删定义。★ 不级联删运行实例：运行是「已发生的事」，历史要留得住。 */
export function removeDef(id: string, ownerId: string | null): boolean {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM flow_step WHERE def_id = ?').run(id);
    db.prepare('DELETE FROM flow_edge WHERE def_id = ?').run(id);
    return db.prepare('DELETE FROM flow_def WHERE id = ? AND owner_id = ?').run(id, ownerForWrite(ownerId)).changes === 1;
  })();
}

/** 克隆成一条新流（「固定化复用」最常用的动作：拿一条跑过的流改一版） */
export function cloneDef(id: string, ownerId: string | null, name?: string): CreateDefResult {
  const src = getDef(id, ownerId);
  if (!src) return { ok: false, error: '学习流不存在' };
  return createDef({
    name: name?.trim() || `${src.name} 副本`,
    description: src.description,
    steps: src.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      params: s.params,
      position: s.position,
      orderIndex: s.orderIndex,
    })),
    edges: src.edges.map((e) => ({
      fromStepId: e.fromStepId,
      toStepId: e.toStepId,
      fromPort: e.fromPort,
      label: e.label,
    })),
  }, ownerId);
}
