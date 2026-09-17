/**
 * api-study-flow — 学习流 REST 封装（契约 docs/STUDY-FLOW-SPEC.md §9）。
 *
 * ★ 独立成文件：`api.ts` 已 357/400 行、本组有 20 个端点，放进去必越 gates 的「.ts ≤400 行」红线。
 *   本文件只依赖 `api-request.ts`（**不反向 import `api.ts`**，环断在那里，理由见该文件头注释）。
 *
 * ★ 本批（v0.2.27）**只做 API 封装、不做页面**——页面/画布/邻域图/参数表单是下一批。
 *   这里先落地是为了让下一批**直接对着真实端点写 UI**，而不是边写 UI 边猜接口形状。
 */
import type {
  FlowDef,
  FlowDefInput,
  FlowRun,
  FlowRunStep,
  FlowStepMeta,
  KnowledgeEdge,
  KnowledgeEdgeKind,
  KnowledgeEdgeOrigin,
  KnowledgeGraphStats,
  KnowledgeNeighborhood,
  KnowledgeNode,
  KnowledgeNodeKind,
} from '@sb/shared';
import { LONG_TASK_TIMEOUT_MS, request } from './api-request.js';

/** `/steps` 的返回项 = 注册表元信息 + 该类型**是否已接执行器** */
export type FlowStepMetaWired = FlowStepMeta & { wired: boolean };

export const studyFlowApi = {
  // ── 步骤注册表 ──

  /**
   * 可编排的「学习交互体验」清单。
   * ★ **必须看 `wired`**：未接执行器的类型要在画布上**禁用**，把错误挡在配置期——
   *   让用户配好一条流、跑到一半才失败，是最差的时点（契约 §7）。
   */
  steps: () =>
    request<{ maxSteps: number; steps: FlowStepMetaWired[] }>('/api/study-flow/steps'),

  // ── 流定义 CRUD ──

  listDefs: () => request<FlowDef[]>('/api/study-flow/defs'),

  /** 定义不存在 → 404（与「参数写错」的 400 分得开） */
  getDef: (id: string) => request<FlowDef>(`/api/study-flow/defs/${encodeURIComponent(id)}`),

  /** 新建：201；悬空边/空步骤/重复 id → 400（错误里点出是哪个 id 不存在） */
  createDef: (input: FlowDefInput) =>
    request<FlowDef>('/api/study-flow/defs', { method: 'POST', body: JSON.stringify(input) }),

  /** 更新：**整体替换**语义（删掉的步骤不会残留），成功则 `version` 递增 */
  updateDef: (id: string, input: FlowDefInput) =>
    request<FlowDef>(`/api/study-flow/defs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  removeDef: (id: string) =>
    request<{ ok: boolean }>(`/api/study-flow/defs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 克隆成新流（「固定化复用」最常用）；跑过的运行不受影响——它们有自己的定义快照 */
  cloneDef: (id: string, name?: string) =>
    request<FlowDef>(`/api/study-flow/defs/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
      body: JSON.stringify({ ...(name ? { name } : {}) }),
    }),

  // ── 运行 ──

  listRuns: (limit?: number) =>
    request<FlowRun[]>(`/api/study-flow/runs${limit ? `?limit=${limit}` : ''}`),

  /** 建立运行：不给 sessionId 时**服务端自动建会话**（学习流要在对话里产出学习数据） */
  createRun: (defId: string, sessionId?: string) =>
    request<FlowRun>('/api/study-flow/runs', {
      method: 'POST',
      body: JSON.stringify({ defId, ...(sessionId ? { sessionId } : {}) }),
    }),

  /** 运行详情：带逐步轨迹（`steps`）+ 本次产出的知识节点（`producedNodes`） */
  getRun: (id: string) =>
    request<FlowRun & { producedNodes: KnowledgeNode[] }>(`/api/study-flow/runs/${encodeURIComponent(id)}`),

  /**
   * 推进**一步**（步进式，非后台循环）。
   * ★★ **这一步可能耗时数十秒**（= 一整轮 LLM 对话跑完才返回）——UI 必须在途态给出明确反馈，
   *   别让它看着像卡住。`note` 非空表示「已走到终点」这类提示。
   * ★ 超时走 `LONG_TASK_TIMEOUT_MS`（180s）**显式放宽**——不显式给就等于无限等，那是更糟的默认；
   *   `signal` 供 UI 上的「停止等待」用（只断前端等待，**不会中止服务端已开始的步骤**）。
   * ★ 状态码：**409** = 状态不可推进 / 未接执行器 / 超步数上限；**502** = 步骤执行失败；
   *   **status=0**（`NO_RESPONSE`）= 超时或被取消，不是服务端拒绝。
   */
  advanceRun: (id: string, signal?: AbortSignal) =>
    request<{ run: FlowRun; executed: FlowRunStep | null; note: string | null }>(
      `/api/study-flow/runs/${encodeURIComponent(id)}/advance`,
      { method: 'POST', timeoutMs: LONG_TASK_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    ),

  /** 终止：仅 running/paused 可终止，其余 409（幂等语义如实反映） */
  cancelRun: (id: string, reason?: string) =>
    request<FlowRun>(`/api/study-flow/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    }),

  // ── 知识数据图 ──

  graphStats: () => request<KnowledgeGraphStats>('/api/study-flow/graph/stats'),

  graphNodes: (kind?: KnowledgeNodeKind, limit?: number) => {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (limit) q.set('limit', String(limit));
    const qs = q.toString();
    return request<KnowledgeNode[]>(`/api/study-flow/graph/nodes${qs ? `?${qs}` : ''}`);
  },

  /**
   * 邻域子图（**局部渲染的唯一入口**，契约 §3.3）：只给中心节点 + N 跳子图。
   * ★ 返回的 `truncated` 必须如实告诉用户——超上限时**不许把局部图冒充全图**。
   */
  neighborhood: (nodeId: string, depth?: number) =>
    request<KnowledgeNeighborhood>(
      `/api/study-flow/graph/neighborhood/${encodeURIComponent(nodeId)}${depth ? `?depth=${depth}` : ''}`,
    ),

  /** 手工登记节点（用户自建 `concept`，或手工补一个词条引用） */
  addNode: (input: { kind: KnowledgeNodeKind; refId?: string | null; refText: string }) =>
    request<KnowledgeNode>('/api/study-flow/graph/nodes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * 手工加边。★ **`origin` 由服务端强制为 `user`**，这里**刻意不接受 origin 入参**——
   * 若前端可自报，用户手画的边就能伪装成 `ai` 抽取的边，出处分层当场作废（契约 §4.2/§8）。
   * 两端节点不存在 → 404；自环 → 400。
   */
  addEdge: (input: {
    fromNodeId: string;
    toNodeId: string;
    kind: KnowledgeEdgeKind;
    weight?: number;
    evidence?: string;
  }) => request<KnowledgeEdge>('/api/study-flow/graph/edges', { method: 'POST', body: JSON.stringify(input) }),

  removeEdge: (id: string) =>
    request<{ ok: boolean }>(`/api/study-flow/graph/edges/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 批量撤销**结构推导**边（`derived`）；用户确认与 AI 抽取的边一条不动 */
  purgeDerived: () =>
    request<{ removed: number }>('/api/study-flow/graph/purge-derived', { method: 'POST' }),

  /** 可选的节点类型 / 边类型 / 边出处（前端下拉用；与 shared 的联合类型同源） */
  graphMeta: () =>
    request<{
      nodeKinds: KnowledgeNodeKind[];
      edgeKinds: KnowledgeEdgeKind[];
      edgeOrigins: KnowledgeEdgeOrigin[];
    }>('/api/study-flow/graph/meta'),
};
