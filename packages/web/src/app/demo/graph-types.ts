/**
 * graph-types —— 知识图数据形状的类型定义（**临时住户**）。
 *
 * ★ 来历：这些类型原住 `@sb/shared/study-flow.ts`，2026-09-25 学习流＋知识图功能整体
 *   下线（批次 K）；shared 侧随功能删除，但落地页 hero 的 GraphDemo 还在用它们渲染演示，
 *   故先就近下沉到 demo 目录——批次 2（hero 演示替换定案）时本文件与 GraphDemo 一起消失。
 */

export type KnowledgeNodeKind = 'term' | 'note' | 'turn' | 'concept';

/** 语义边类型（原 SPEC §4 口径：前置 / 相关 / 由…引发 / 从属） */
export type KnowledgeEdgeKind = 'prereq' | 'relates' | 'derived_from' | 'contains';

/** 边的出处：`user` 手工确认 > `ai` 模型抽取（可能幻觉）> `derived` 结构推导 */
export type KnowledgeEdgeOrigin = 'ai' | 'user' | 'derived';

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  /** 指向源表主键（term_library.id / quiz_notes.id / messages.id）；`concept` 为 null */
  refId: string | null;
  /** 抗删快照：源行删除后图仍自洽可读 */
  refText: string;
  sourceRunId: string | null;
  sourceStepId: string | null;
  createdAt: string;
}

export interface KnowledgeEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: KnowledgeEdgeKind;
  origin: KnowledgeEdgeOrigin;
  /** 邻域排序权重（不参与业务判定） */
  weight: number;
  /** 立这条边的依据：AI 抽取存原话摘录，结构推导存规则名 */
  evidence: string | null;
  createdAt: string;
}

/** 邻域查询结果：中心节点 + N 跳子图 */
export interface KnowledgeNeighborhood {
  center: KnowledgeNode;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 是否因深度上限被截断（ADR-5 不静默：截断了必须告诉用户） */
  truncated: boolean;
}
