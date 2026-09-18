/**
 * learning/study-flow-run — 学习流**运行层**（控制流的实例部分：`flow_run` / `flow_run_step`）。
 * 契约 docs/STUDY-FLOW-SPEC.md §5-§6。定义层在 `learning/study-flow.ts`。
 *
 * ★★ 核心设计（本文件最重要的一段，改码前必读）：
 *
 *  **运行器是「步进式」的，不是后台 while 循环**。每次 `advanceRun` 只推进**一步**，
 *  推进所需的一切状态都在 `flow_run` 行里（`current_step_id` / `cursor` / `step_count` /
 *  `status`），进程内存里**不持有任何运行状态**。带来四个好处：
 *   ① **进程重启不丢**：没有内存 Promise 会随进程消失，也就不需要 LangGraph 那套
 *      checkpointer/interrupt 机制（本仓 `chat/choice.ts` 为 `ask_choices` 手写过一遍同款，
 *      但那是**必须**的——工具在等答复、不落库就会变成点不动的死卡；学习流这一步是纯加法，
 *      状态本来就在库里，**不引入新的挂起式等待**）。
 *   ② **天然支持「停在任一步」**：前端每点一次「继续」走一步，用户看得见每一步的结果。
 *   ③ **无后台任务**：不需要定时器、不需要 job 队列、不受「关掉客户端即被终止」的进程托管限制。
 *   ④ **可测**：注入 fake executor 后，整个推进过程是确定性的同步可断言序列。
 *
 *  ★ 代价（诚实记录）：一个步骤的执行（= 一整轮 LLM 对话）会在一次 HTTP 请求里跑完，
 *    耗时可到数十秒。故**前端必须给它够长的超时**，或后续把单步执行改为 SSE 流式。
 *    这一批先不做 SSE——先让状态机跑对（契约 §13 未验账有记）。
 *
 * ★ `def_snapshot` 不可省：用户改完定义后，已跑过的运行必须仍按**当时的定义**解释自己的轨迹，
 *   否则历史回放张冠李戴（同 `pk_matches.snapshot_json` 手法）。故 `getRun` 不读 `flow_def`。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { findFlowStepMeta, FLOW_MAX_STEPS } from '@sb/shared';
import type { FlowPort, FlowRun, FlowRunStatus, FlowRunStep, FlowStepKind } from '@sb/shared';
import { getDef } from './study-flow.js';
import { insertSession, ownerOfSession } from '../auth/ownership.js';
import { getExecutor, registeredKinds } from './flow-registry.js';
import type { FlowStepContext } from './flow-registry.js';
import { emitTermNodes } from './knowledge-graph.js';

/** 运行用的定义快照（Dify WorkflowRunHistory.graph 的对应物；只留运行器真正要用的字段） */
interface DefSnapshot {
  defId: string;
  defName: string;
  defVersion: number;
  steps: Array<{ id: string; kind: FlowStepKind; label: string; params: Record<string, unknown>; orderIndex: number }>;
  edges: Array<{ fromStepId: string; toStepId: string; fromPort: FlowPort }>;
}

interface RunRow {
  id: string;
  def_id: string;
  def_snapshot: string;
  def_version: number;
  session_id: string | null;
  status: string;
  current_step_id: string | null;
  cursor: string | null;
  step_count: number;
  pause_reason: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunStepRow {
  id: string;
  run_id: string;
  step_id: string;
  kind: string;
  seq: number;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toRun = (r: RunRow, steps?: FlowRunStep[]): FlowRun => ({
  id: r.id,
  defId: r.def_id,
  defVersion: r.def_version,
  sessionId: r.session_id,
  status: r.status as FlowRunStatus,
  currentStepId: r.current_step_id,
  cursor: r.cursor as FlowPort | null,
  stepCount: r.step_count,
  pauseReason: r.pause_reason,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
  ...(steps ? { steps } : {}),
});

const toRunStep = (r: RunStepRow): FlowRunStep => ({
  id: r.id,
  runId: r.run_id,
  stepId: r.step_id,
  kind: r.kind as FlowStepKind,
  seq: r.seq,
  status: r.status as FlowRunStep['status'],
  input: optJson(r.input),
  output: optJson(r.output),
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

function optJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const parseSnapshot = (raw: string): DefSnapshot | null => {
  try {
    const v = JSON.parse(raw) as DefSnapshot;
    return Array.isArray(v?.steps) && Array.isArray(v?.edges) ? v : null;
  } catch {
    return null;
  }
};

// ── 创建与查询 ──

export type CreateRunResult = { ok: true; run: FlowRun } | { ok: false; error: string };

/**
 * 建立一次运行：把定义的**当前版本快照**冻进 `flow_run.def_snapshot`。
 * 未给 sessionId 时**自动建一个会话**——学习流的意义就是「在对话里学」，没有会话它无处产出
 * 词条/笔记；让调用方先建会话只会把这份责任推给前端而毫无好处。
 */
/**
 * @param opts.userId 会话归属者（TENANCY-SPEC §1）。★ 不传＝孤儿会话，登录用户将**看不到它**
 *   （比泄露更隐蔽的 bug：学习流跑完却找不到会话），故由调用方显式从 `ownerIdOf(req)` 传入。
 */
export function createRun(defId: string, opts?: { sessionId?: string | null; userId?: string | null }): CreateRunResult {
  const def = getDef(defId);
  if (!def) return { ok: false, error: '学习流不存在' };
  if (def.steps.length === 0) return { ok: false, error: '这条学习流没有步骤，无法运行' };

  const db = getDb();
  const runId = randomUUID();
  let sessionId = opts?.sessionId ?? null;
  const snapshot: DefSnapshot = {
    defId: def.id,
    defName: def.name,
    defVersion: def.version,
    steps: def.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, params: s.params, orderIndex: s.orderIndex })),
    edges: def.edges.map((e) => ({ fromStepId: e.fromStepId, toStepId: e.toStepId, fromPort: e.fromPort })),
  };

  db.transaction(() => {
    if (!sessionId) {
      sessionId = randomUUID();
      // 走 auth/ownership 的唯一落点：user_id 由签名强制传入，杜绝"忘了写归属列"
      insertSession(sessionId, opts?.userId ?? null, `学习流：${def.name}`);
    }
    db.prepare(
      `INSERT INTO flow_run (id, def_id, def_snapshot, def_version, session_id, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    ).run(runId, def.id, JSON.stringify(snapshot), def.version, sessionId);
  })();

  return { ok: true, run: getRun(runId, true)! };
}

export function getRun(id: string, withSteps = false): FlowRun | null {
  const row = getDb().prepare('SELECT * FROM flow_run WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) return null;
  const steps = withSteps
    ? (getDb().prepare('SELECT * FROM flow_run_step WHERE run_id = ? ORDER BY seq').all(id) as RunStepRow[]).map(toRunStep)
    : undefined;
  return toRun(row, steps);
}

export function listRuns(limit = 50): FlowRun[] {
  const cap = Math.min(Math.max(limit, 1), 200);
  const rows = getDb()
    .prepare('SELECT * FROM flow_run ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(cap) as RunRow[];
  return rows.map((r) => toRun(r));
}

/** 运行详情里带「本次学到了什么」——运行产出的知识节点（回看价值最高的一块） */
export function runSnapshotMeta(runId: string): { defName: string | null; stepCount: number } {
  const row = getDb().prepare('SELECT def_snapshot, step_count FROM flow_run WHERE id = ?').get(runId) as
    | Pick<RunRow, 'def_snapshot' | 'step_count'>
    | undefined;
  if (!row) return { defName: null, stepCount: 0 };
  return { defName: parseSnapshot(row.def_snapshot)?.defName ?? null, stepCount: row.step_count };
}

// ── 推进（核心）──

/**
 * 走哪一步。
 * 优先走**显式边**（用户编排的意图）；边缺失时回落到「按 `order_index` 找下一个」——
 * 这条兜底让「只拖了节点没连线」的流也能跑通，不至于让用户面对一个看不懂的「找不到下一步」。
 * 两者都没有 ⇒ 返回 null ⇒ 运行正常收尾为 done。
 */
function pickNextStep(
  snap: DefSnapshot,
  currentStepId: string | null,
  cursor: FlowPort | null,
): DefSnapshot['steps'][number] | null {
  const byId = new Map(snap.steps.map((s) => [s.id, s]));
  if (!currentStepId) {
    // 入口 = 没有任何边指向它的步骤；多个（或成环导致没有）时取 order_index 最小的那个
    const pointedTo = new Set(snap.edges.map((e) => e.toStepId));
    const entries = snap.steps.filter((s) => !pointedTo.has(s.id));
    const pool = entries.length > 0 ? entries : snap.steps;
    return [...pool].sort((a, b) => a.orderIndex - b.orderIndex)[0] ?? null;
  }
  const port = cursor ?? 'next';
  const edge = snap.edges.find((e) => e.fromStepId === currentStepId && e.fromPort === port);
  if (edge) return byId.get(edge.toStepId) ?? null;
  // 兜底：线性推进
  const cur = byId.get(currentStepId);
  if (!cur) return null;
  const later = snap.steps.filter((s) => s.orderIndex > cur.orderIndex).sort((a, b) => a.orderIndex - b.orderIndex);
  return later[0] ?? null;
}

/** 收集本 run 前面各步的产出（供后续步骤引用；步骤间传数据的唯一通道） */
function collectUpstream(runId: string): Record<string, Record<string, unknown>> {
  const rows = getDb()
    .prepare(`SELECT step_id, output FROM flow_run_step WHERE run_id = ? AND status = 'done' ORDER BY seq`)
    .all(runId) as Array<Pick<RunStepRow, 'step_id' | 'output'>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows) out[r.step_id] = optJson(r.output) ?? {};
  return out;
}

export type AdvanceResult =
  | { ok: true; run: FlowRun; executed: FlowRunStep | null; note: string | null }
  | { ok: false; status: number; error: string };

/**
 * 推进**一步**。`running` 与 `paused` 都可推进（paused 只是「停在某步等用户」，用户做完该做的事
 * 再推进正是恢复语义本身）；`done`/`failed`/`cancelled` 一律 409，错误里带上当前状态原文
 * （状态语义不在路由里反推，ADR-5）。
 */
export async function advanceRun(runId: string): Promise<AdvanceResult> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM flow_run WHERE id = ?').get(runId) as RunRow | undefined;
  if (!row) return { ok: false, status: 404, error: '运行实例不存在' };
  // ★ running 与 paused **都可推进**：paused 只是「停在某步等用户」，用户做完该做的事再推进
  //   正是恢复语义本身。故这里把它自动翻回 running，前端不需要先调一个单独的 resume 端点
  //   （多一个端点就多一处「前端忘了调」的坑，而状态语义并不因此更清楚）。
  if (row.status !== 'running' && row.status !== 'paused') {
    return { ok: false, status: 409, error: `运行当前是「${row.status}」，不能再推进（仅 running / paused 可推进）` };
  }
  const snap = parseSnapshot(row.def_snapshot);
  if (!snap) {
    failRun(runId, '运行的定义快照已损坏，无法继续');
    return { ok: false, status: 500, error: '定义快照损坏' };
  }
  if (row.step_count >= FLOW_MAX_STEPS) {
    const msg = `已连续执行 ${FLOW_MAX_STEPS} 步仍未走到终点，出于防死循环保护中止（契约 §6）`;
    failRun(runId, msg);
    return { ok: false, status: 409, error: msg };
  }

  const step = pickNextStep(snap, row.current_step_id, row.cursor as FlowPort | null);
  if (!step) {
    finishRun(runId);
    return { ok: true, run: getRun(runId, true)!, executed: null, note: '流程已走到终点' };
  }

  const exec = getExecutor(step.kind);
  if (!exec) {
    const msg = `步骤类型「${step.kind}」尚未接入执行器；已接入：${registeredKinds().join(' / ') || '（无）'}（契约 §7 待接清单）`;
    failRun(runId, msg);
    return { ok: false, status: 409, error: msg };
  }

  const meta = findFlowStepMeta(step.kind);
  const seq = row.step_count + 1;
  const stepRowId = randomUUID();
  const startedAt = db.prepare(`SELECT datetime('now') AS t`).get() as { t: string };

  db.prepare(
    `INSERT INTO flow_run_step (id, run_id, step_id, kind, seq, status, input)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(stepRowId, runId, step.id, step.kind, seq, JSON.stringify({ params: step.params }));
  // 先把「正在跑哪一步」落库、并把 paused 翻回 running：此刻进程若挂掉，
  // 重启后能一眼看出停在哪里（不静默），且状态不会卡在 paused 上再也推不动。
  db.prepare(
    `UPDATE flow_run SET status = 'running', current_step_id = ?, step_count = ?,
     pause_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(step.id, seq, runId);

  const ctx: FlowStepContext = {
    runId,
    stepId: step.id,
    kind: step.kind,
    params: step.params,
    sessionId: row.session_id,
    ownerId: ownerOfSession(row.session_id),
    upstream: collectUpstream(runId),
  };

  try {
    const outcome = await exec(ctx);
    const port: FlowPort = outcome.port ?? 'next';
    const shouldPause = outcome.awaitUser ?? meta?.awaitsUser ?? false;
    db.prepare(
      `UPDATE flow_run_step SET status = 'done', output = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(outcome.output), stepRowId);

    // 产物落图：本步跑出的词条成为知识节点，并按同域补 derived 相关边。
    // ★ 只做 'term'：词条表有 source_session_id，可按「会话 + 时间窗」精确定位本步新增的行。
    //   'note'/'turn' 的定位缺可靠锚点（quiz_notes 无 session 列），**不猜**、留待 SPEC §7 待接。
    if (meta?.produces.includes('term') && row.session_id) {
      emitTermNodes(runId, step.id, row.session_id, startedAt.t, ctx.ownerId);
    }

    if (shouldPause) {
      db.prepare(
        `UPDATE flow_run SET status = 'paused', cursor = ?, pause_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(port, outcome.pauseReason ?? '该步骤需要你的交互后才能继续', runId);
    } else {
      db.prepare(
        `UPDATE flow_run SET cursor = ?, pause_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(port, runId);
    }
    return {
      ok: true,
      run: getRun(runId, true)!,
      executed: toRunStep(
        db.prepare('SELECT * FROM flow_run_step WHERE id = ?').get(stepRowId) as RunStepRow,
      ),
      note: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(
      `UPDATE flow_run_step SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(msg.slice(0, 500), stepRowId);
    failRun(runId, msg);
    return { ok: false, status: 502, error: `步骤执行失败：${msg}` };
  }
}

// ── 状态收尾（全部集中在此，别处不再直接改 status）──

function finishRun(runId: string): void {
  getDb()
    .prepare(
      `UPDATE flow_run SET status = 'done', cursor = NULL, pause_reason = NULL,
       finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(runId);
}

function failRun(runId: string, message: string): void {
  getDb()
    .prepare(
      `UPDATE flow_run SET status = 'failed', error = ?, pause_reason = NULL,
       finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(message.slice(0, 500), runId);
}

/** 用户主动终止（逃生口：与 `chat/choice.ts` 的 cancelChoicesBySession 同一取向——事后可恢复） */
export function cancelRun(runId: string, reason: string): FlowRun | null {
  const r = getDb()
    .prepare(
      `UPDATE flow_run SET status = 'cancelled', pause_reason = NULL, error = ?,
       finished_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status IN ('running', 'paused')`,
    )
    .run(reason.slice(0, 200), runId);
  if (r.changes !== 1) return null;
  return getRun(runId, true);
}
