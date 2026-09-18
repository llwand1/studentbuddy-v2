/**
 * routes/study-flow — 学习流薄路由（契约 docs/STUDY-FLOW-SPEC.md §9）。
 * 只做「取参 → 调域函数 → 定状态码」，不含业务判定（ADR-3）。
 *
 * ★ 注册表端点（`/steps`）刻意带上 `wired` 标记：前端据此**禁用还没接执行器的步骤类型**，
 *   而不是让用户配好一条流、跑到一半才失败。这是「把错误挡在配置期」而不是运行期。
 *
 * ★ 状态码口径（与 /api/terms、/api/memory 刻意不同，理由同 memory 路由）：
 *   域层已把「不存在」「状态不对」「参数非法」分得很清楚，路由**原样透传**、不反推
 *   （`advanceRun` 的 AdvanceResult 就带 status）。路由自己发明状态码会让前端分不清
 *   「你传错了」和「服务端炸了」。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { FLOW_STEP_METAS, FLOW_MAX_STEPS } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import {
  createDef,
  getDef,
  listDefs,
  updateDef,
  removeDef,
  cloneDef,
} from '../learning/study-flow.js';
import { advanceRun, cancelRun, createRun, getRun, listRuns } from '../learning/study-flow-run.js';
import { getExecutor } from '../learning/flow-registry.js';
import {
  addEdge,
  ensureNode,
  getNode,
  graphStats,
  listNodes,
  neighborhood,
  nodesOfRun,
  purgeDerivedEdges,
  removeEdge,
} from '../learning/knowledge-graph.js';
import type { KnowledgeEdgeKind, KnowledgeEdgeOrigin, KnowledgeNodeKind } from '@sb/shared';

export const studyFlowRouter = Router();

// ── 步骤注册表 ──

/** 可编排的「学习交互体验」清单 + 哪些已接执行器（前端禁用未接的） */
studyFlowRouter.get('/steps', (_req, res) => {
  res.json({
    maxSteps: FLOW_MAX_STEPS,
    steps: FLOW_STEP_METAS.map((m) => ({ ...m, wired: Boolean(getExecutor(m.kind)) })),
  });
});

// ── 定义 CRUD ──

studyFlowRouter.get('/defs', (_req, res) => {
  res.json(listDefs());
});

studyFlowRouter.post('/defs', (req: Request, res: Response) => {
  const r = createDef(req.body);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.status(201).json(r.def);
});

studyFlowRouter.get('/defs/:id', (req: Request, res: Response) => {
  const def = getDef(req.params.id ?? '');
  if (!def) {
    res.status(404).json({ error: '学习流不存在' });
    return;
  }
  res.json(def);
});

studyFlowRouter.put('/defs/:id', (req: Request, res: Response) => {
  const r = updateDef(req.params.id ?? '', req.body);
  if (!r.ok) {
    // 不存在 → 404；其余（校验不过）→ 400。域层不区分，故在此按「是否查得到」判一次
    const exists = getDef(req.params.id ?? '') !== null;
    res.status(exists ? 400 : 404).json({ error: r.error });
    return;
  }
  res.json(r.def);
});

studyFlowRouter.delete('/defs/:id', (req: Request, res: Response) => {
  const ok = removeDef(req.params.id ?? '');
  if (!ok) {
    res.status(404).json({ error: '学习流不存在' });
    return;
  }
  res.json({ ok: true });
});

/** 克隆成新流（「固定化复用」最常用的动作）。跑过的运行不受影响——它们有自己的定义快照 */
studyFlowRouter.post('/defs/:id/clone', (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  const r = cloneDef(req.params.id ?? '', name);
  if (!r.ok) {
    res.status(404).json({ error: r.error });
    return;
  }
  res.status(201).json(r.def);
});

// ── 运行 ──

studyFlowRouter.get('/runs', (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  res.json(listRuns(Number.isFinite(limit) ? limit : 50));
});

studyFlowRouter.post('/runs', (req: Request, res: Response) => {
  const { defId, sessionId } = req.body as { defId?: string; sessionId?: string };
  if (!defId) {
    res.status(400).json({ error: 'defId 必填' });
    return;
  }
  // ★ 归属必须传下去：否则自动建的会话是孤儿，登录用户会「跑完学习流却找不到会话」
  const r = createRun(defId, { sessionId: sessionId ?? null, userId: ownerIdOf(req) });
  if (!r.ok) {
    res.status(404).json({ error: r.error });
    return;
  }
  res.status(201).json(r.run);
});

/** 运行详情：带逐步轨迹 + 本次产出的知识节点（「这一趟学到了什么」） */
studyFlowRouter.get('/runs/:id', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  const run = getRun(id, true);
  if (!run) {
    res.status(404).json({ error: '运行实例不存在' });
    return;
  }
  res.json({ ...run, producedNodes: nodesOfRun(id) });
});

/**
 * 推进**一步**（步进式，见 study-flow-run.ts 文件头）。
 * ★ 这一步可能耗时数十秒（= 一整轮 LLM 对话），前端超时要放宽。
 */
studyFlowRouter.post('/runs/:id/advance', async (req: Request, res: Response) => {
  const r = await advanceRun(req.params.id ?? '');
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ run: r.run, executed: r.executed, note: r.note });
});

studyFlowRouter.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const run = cancelRun(req.params.id ?? '', reason?.trim() || '用户主动终止');
  if (!run) {
    res.status(409).json({ error: '运行不在可终止状态（仅 running/paused 可终止）' });
    return;
  }
  res.json(run);
});

// ── 知识数据图 ──

studyFlowRouter.get('/graph/stats', (_req, res) => {
  res.json(graphStats());
});

studyFlowRouter.get('/graph/nodes', (req: Request, res: Response) => {
  const kind = typeof req.query.kind === 'string' ? (req.query.kind as KnowledgeNodeKind) : undefined;
  const limit = Number(req.query.limit);
  res.json(listNodes(kind, Number.isFinite(limit) ? limit : 200));
});

/**
 * 邻域子图（局部渲染的唯一入口）。
 * 也支持**新建**一个 concept 节点后直接查它的邻域——`POST /graph/nodes` 见下。
 */
studyFlowRouter.get('/graph/neighborhood/:nodeId', (req: Request, res: Response) => {
  const depth = Number(req.query.depth);
  const nb = neighborhood(req.params.nodeId ?? '', Number.isFinite(depth) ? depth : 2);
  if (!nb) {
    res.status(404).json({ error: '知识节点不存在' });
    return;
  }
  res.json(nb);
});

/** 手工登记一个知识节点（用户自己建的 concept / 手工补的词条引用） */
studyFlowRouter.post('/graph/nodes', (req: Request, res: Response) => {
  const { kind, refId, refText } = req.body as {
    kind?: KnowledgeNodeKind;
    refId?: string | null;
    refText?: string;
  };
  if (!kind || !refText?.trim()) {
    res.status(400).json({ error: 'kind 与 refText 必填' });
    return;
  }
  res.status(201).json(ensureNode({ kind, refId: refId ?? null, refText: refText.trim() }));
});

/**
 * 手工加边。★ 路由**强制** `origin='user'`：经用户之手在界面上拉的线就是用户确认的边，
 * 不允许客户端自称 origin（否则 AI 抽取的边可以伪装成用户确认的，`origin` 的可信分层就废了）。
 */
studyFlowRouter.post('/graph/edges', (req: Request, res: Response) => {
  const { fromNodeId, toNodeId, kind, weight, evidence } = req.body as {
    fromNodeId?: string;
    toNodeId?: string;
    kind?: KnowledgeEdgeKind;
    weight?: number;
    evidence?: string;
  };
  if (!fromNodeId || !toNodeId || !kind) {
    res.status(400).json({ error: 'fromNodeId / toNodeId / kind 必填' });
    return;
  }
  if (!getNode(fromNodeId) || !getNode(toNodeId)) {
    res.status(404).json({ error: '两端节点必须都已存在' });
    return;
  }
  const edge = addEdge({
    fromNodeId,
    toNodeId,
    kind,
    origin: 'user',
    weight,
    evidence: evidence?.trim() || '用户手动建立',
  });
  if (!edge) {
    res.status(400).json({ error: '该边无法建立（自环，或两端相同）' });
    return;
  }
  res.status(201).json(edge);
});

studyFlowRouter.delete('/graph/edges/:id', (req: Request, res: Response) => {
  const ok = removeEdge(req.params.id ?? '');
  if (!ok) {
    res.status(404).json({ error: '边不存在' });
    return;
  }
  res.json({ ok: true });
});

/** 批量撤销结构推导的边（`derived`）；AI/用户边不受影响（见 knowledge-graph.ts 注释） */
studyFlowRouter.post('/graph/purge-derived', (_req, res) => {
  res.json({ removed: purgeDerivedEdges() });
});

/** 知识图可选的边类型/出处（前端下拉用；与 shared 的联合类型同源） */
studyFlowRouter.get('/graph/meta', (_req, res) => {
  res.json({
    nodeKinds: ['term', 'note', 'turn', 'concept'] satisfies KnowledgeNodeKind[],
    edgeKinds: ['prereq', 'relates', 'derived_from', 'contains'] satisfies KnowledgeEdgeKind[],
    edgeOrigins: ['ai', 'user', 'derived'] satisfies KnowledgeEdgeOrigin[],
  });
});
