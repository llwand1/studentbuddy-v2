/**
 * 学习流契约（契约 docs/STUDY-FLOW-SPEC.md，2026-09-16）——控制流 + 知识数据图的前后端单一事实源。
 *
 * 三层结构（SPEC §1）：
 *  ① **步骤注册表**（本文件的 `FLOW_STEP_METAS`）——预定义的「学习交互体验」清单。
 *     用户能自定义的是「**选哪种 + 填什么参数**」，不是交互本身（SPEC §1.3 范围红线）。
 *     前端靠它渲染节点面板与参数表单 ⇒ 放 shared 而非 server。
 *  ② **控制流**（`FlowDef` = 模板 / `FlowRun` = 实例）——用户把步骤连成可保存、可固定化复用的流。
 *  ③ **知识数据图**（`KnowledgeNode` / `KnowledgeEdge`）——控制流按用户规定的方式产出的学习产物。
 *
 * ★ 设计依据（三者独立取材、交叉印证，非自创；细则见 migrations-list-v10.ts 的 v18 注释）：
 *  · LangGraph.js 源码 `graph/state.ts`：图是**构建时静态定义**的，`addNode`/`addEdge` 必须在
 *    `compile()` 前写完（**逻辑动态，结构静态**）⇒ 故这里的流是**数据**，由固定运行器解释执行。
 *  · n8n `INode{ id, name, type, typeVersion, position, parameters }` ⇒ `FlowStepDef` 的字段一一对应，
 *    其中 `kind` = 注册表键、`typeVersion` = 步骤类型自带版本、`position` = 画布坐标（属定义）。
 *  · Dify `NodesDefaultConfigs{type,config}[]` + `WorkflowRunHistory`（存当次 graph 快照）
 *    + `workflow_paused`/`paused_nodes` ⇒ `FLOW_STEP_METAS` / `FlowRun.defSnapshot` / `status='paused'`。
 */

// ── ① 步骤注册表 ──

/**
 * 步骤类型（注册表键）。**有限枚举**，不是自由文本——
 * 这是「用户可编排」与「用户可创造交互」的分界线（SPEC §1.3）。
 */
export type FlowStepKind =
  | 'explain'
  | 'quiz'
  | 'scenario' // 情景演练（SCENARIO-SPEC §8 M4，2026-09-17 登记）：AI 生成可交互 demo 并等用户完成
  | 'grade'
  | 'review'
  | 'digest'
  | 'summary';

/** 参数声明：前端据此渲染表单，服务端据此校验（两侧同源，防双写漂移） */
export interface FlowParamMeta {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string | number | boolean;
  /** type='select' 时的候选项 */
  options?: string[];
  /** type='number' 的取值区间（服务端**钳制**而非拒绝，同 normalizeTerms 手法） */
  min?: number;
  max?: number;
  hint?: string;
  /**
   * 输入框的示例提示（前端 `placeholder`）。**不是默认值**——它只在框为空时显示，
   * 不会被提交。用途是让「空白起步」或用户自己新加的那一步也知道该填什么形式
   * （模板已经带好示例参数，这条路是模板之外的兜底）。
   */
  example?: string;
}

/** 一种「学习交互体验」的元信息（= Dify NodesDefaultConfigs 的对应物） */
export interface FlowStepMeta {
  kind: FlowStepKind;
  label: string;
  description: string;
  /** 该步骤类型自己的版本（对齐 n8n INode.typeVersion；改登记表语义时递增） */
  typeVersion: number;
  params: FlowParamMeta[];
  /** 该步骤会产出哪几类知识节点（空数组 = 不产出，如纯讲解步） */
  produces: KnowledgeNodeKind[];
  /** 跑完这步是否会「停下来等用户交互」（= LangGraph 的 interrupt；见 SPEC §5） */
  awaitsUser: boolean;
}

// ── ② 控制流·定义（模板：可保存、可固定化复用）──

/** 出口端口。`next` 无条件顺序；`correct`/`wrong` 让「答对走下一题、答错走复盘」成为可能 */
export type FlowPort = 'next' | 'correct' | 'wrong';

export interface FlowStepDef {
  id: string;
  defId: string;
  kind: FlowStepKind;
  /** 步骤类型版本（落库时快照，注册表升级后老定义仍能被正确解释） */
  typeVersion: number;
  /** 画布上显示的名字（用户可改，`label` 为空时前端回落注册表默认名） */
  label: string;
  /** 用户填的参数（按 `params` 声明逐项校验） */
  params: Record<string, unknown>;
  /** 画布坐标（属定义，不是纯前端状态——n8n/Dify 均落库） */
  position: { x: number; y: number };
  orderIndex: number;
  createdAt: string;
}

export interface FlowEdgeDef {
  id: string;
  defId: string;
  fromStepId: string;
  toStepId: string;
  fromPort: FlowPort;
  label: string;
}

export interface FlowDef {
  id: string;
  name: string;
  description: string;
  /** 定义自身的版本（每次保存结构变更递增；Dify version 同款） */
  version: number;
  steps: FlowStepDef[];
  edges: FlowEdgeDef[];
  createdAt: string;
  updatedAt: string;
}

/** 保存定义时的入参（新建/更新共用一份形状） */
export interface FlowDefInput {
  name: string;
  description?: string;
  steps: Array<{
    id?: string;
    kind: FlowStepKind;
    label?: string;
    params?: Record<string, unknown>;
    position?: { x: number; y: number };
    orderIndex?: number;
  }>;
  edges: Array<{
    fromStepId: string;
    toStepId: string;
    fromPort?: FlowPort;
    label?: string;
  }>;
}

// ── ② 控制流·运行（实例）──

/**
 * 运行状态。
 *  · `paused` = 跑到一个 `awaitsUser` 的步骤、**停下来等用户交互**（= LangGraph 的 interrupt）。
 *    这不是错误态：它是「学习流」的正常中间态，用户答复后原地续跑。
 */
export type FlowRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type FlowRunStepStatus = 'running' | 'done' | 'failed' | 'skipped';

/** 单步执行轨迹（= Dify NodeTracing 的对应物） */
export interface FlowRunStep {
  id: string;
  runId: string;
  stepId: string;
  kind: FlowStepKind;
  /** 1 基步序号 */
  seq: number;
  status: FlowRunStepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FlowRun {
  id: string;
  defId: string;
  /** 当次运行用的定义版本号 */
  defVersion: number;
  sessionId: string | null;
  status: FlowRunStatus;
  /** 暂停/中断时停在哪一步（恢复锚点） */
  currentStepId: string | null;
  /** 恢复时从哪个出口继续（对齐 `FlowPort`） */
  cursor: FlowPort | null;
  /** 已执行步数（防死循环的计数器，上限见 `FLOW_MAX_STEPS`） */
  stepCount: number;
  /** 停等用户时给前端的说明（ADR-5 不静默） */
  pauseReason: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** 运行详情接口才带（列表接口省略，防列表响应体过大） */
  steps?: FlowRunStep[];
}

/**
 * 单次运行的最大步数（防死循环）。
 * 口径对齐：LangGraph 的 `recursionLimit`、本仓 `chat/flow.ts` 的 `MAX_TOOL_TURNS`。
 * ★ 超限**不是静默截断**——运行以 `failed` 收尾并在 `error` 里如实说明（ADR-4/ADR-5）。
 */
export const FLOW_MAX_STEPS = 30;

// ── ③ 知识数据图（学习产物）──

export type KnowledgeNodeKind = 'term' | 'note' | 'turn' | 'concept';

/**
 * 语义边类型。
 *  · `prereq`       前置：要理解 B 先得懂 A
 *  · `relates`      相关：同域或同现，互为参照
 *  · `derived_from` 由…引发：B 是在学习 A 的过程中（错题/追问）产生的
 *  · `contains`     从属：B 是 A 的组成部分或子概念
 */
export type KnowledgeEdgeKind = 'prereq' | 'relates' | 'derived_from' | 'contains';

/**
 * 边的出处。★ **三值刻意不平权**（SPEC §4）：
 *  · `user`    用户手工确认的最高可信边
 *  · `ai`      模型抽取，**可能幻觉** —— 前端必须给它加视觉标记，且用户可一键转正或删除
 *  · `derived` 结构推导（同域 / 同会话共现 / 同错题引用），**可被规则重算、可批量撤销**
 * 若把三者混作一谈，模型幻觉出的关系就再也纠不回来。
 */
export type KnowledgeEdgeOrigin = 'ai' | 'user' | 'derived';

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  /** 指向源表主键（term_library.id / quiz_notes.id / messages.id）；`concept` 为 null */
  refId: string | null;
  /** 抗删快照：源行删除后图仍自洽可读（同 evolution_event.term_text 手法） */
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

/**
 * 邻域查询结果：中心节点 + N 跳子图。
 * ★ 刻意**只返回局部子图**、不返回全图——词条级全图在节点数上到万级就会拖死前端渲染，
 *   而用户真正要看的是「当前这个词条跟谁有关系」。全图视图留待后续按需分片。
 */
export interface KnowledgeNeighborhood {
  center: KnowledgeNode;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** 是否因深度上限被截断（ADR-5 不静默：截断了必须告诉用户） */
  truncated: boolean;
}

/** 知识图统计（列表页/入口处的概览数字） */
export interface KnowledgeGraphStats {
  nodes: number;
  edges: number;
  byKind: Array<{ kind: KnowledgeNodeKind; count: number }>;
  byOrigin: Array<{ origin: KnowledgeEdgeOrigin; count: number }>;
}

// ── 步骤注册表：六种「学习交互体验」清单（唯一定义处）──
//
// ★ 为什么放在 shared 而不放 server：节点面板、参数表单、画布配色全靠这份清单渲染，
//   放 server 就得让前端再抄一份哑数据（`AGENTS.md` 禁的「类型双写漂移」同款病）。
//   server 侧只额外持有 `executor`（真跑逻辑），见 `learning/flow-registry.ts`。
//
// ★ 参数默认值即「不填也能跑」的兜底；`required: true` 的项缺失时服务端**当场拒绝入参**
//   （不静默落默认值——用户以为自己配了、实际没配，比报错更难查）。
export const FLOW_STEP_METAS: FlowStepMeta[] = [
  {
    kind: 'explain',
    label: '讲解',
    description: '就一个主题或词条做讲解，讲完自动沉淀词条',
    typeVersion: 1,
    params: [
      { key: 'topic', label: '讲解主题', type: 'string', required: true, hint: '词条名或知识点', example: '如：函数的单调性' },
      {
        key: 'depth',
        label: '深度',
        type: 'select',
        required: false,
        default: 'normal',
        options: ['brief', 'normal', 'deep'],
        hint: 'brief 只讲要点 / normal 常规 / deep 含推导与反例',
      },
      { key: 'withExample', label: '附例子', type: 'boolean', required: false, default: true },
    ],
    produces: ['term'],
    awaitsUser: false,
  },
  {
    kind: 'quiz',
    label: '出题',
    description: '就一个主题出题并等用户作答（跑到这里会停下来等你）',
    typeVersion: 1,
    params: [
      { key: 'topic', label: '出题主题', type: 'string', required: true, example: '如：函数的单调性' },
      { key: 'count', label: '题数', type: 'number', required: false, default: 3, min: 1, max: 10 },
      { key: 'online', label: '联网检索素材', type: 'boolean', required: false, default: true },
    ],
    produces: [],
    awaitsUser: true,
  },
  {
    kind: 'scenario',
    label: '情景演练',
    description: 'AI 生成一个可交互的情景 demo（有对错标准、自动回传统计），跑到这里会停下来等你在卡片里完成',
    typeVersion: 1,
    params: [
      { key: 'topic', label: '情景主题', type: 'string', required: true, example: '如：实验室用电安全' },
      {
        key: 'material',
        label: '参考材料',
        type: 'string',
        required: false,
        hint: '贴入材料原文则按材料出题，主题作为兜底',
      },
    ],
    produces: [],
    awaitsUser: true,
  },
  {
    kind: 'grade',
    label: '判分',
    description: '对上一次作答判分并把错题写成笔记',
    typeVersion: 1,
    params: [
      { key: 'strict', label: '严格判分', type: 'boolean', required: false, default: false },
    ],
    produces: ['note'],
    awaitsUser: false,
  },
  {
    kind: 'review',
    label: '错题复盘',
    description: '挑出错题逐个复盘，产出复盘笔记',
    typeVersion: 1,
    params: [
      {
        key: 'scope',
        label: '范围',
        type: 'select',
        required: false,
        default: 'weak',
        options: ['last', 'weak', 'all'],
        hint: 'last 最近一套 / weak 薄弱点 / all 全部',
      },
      { key: 'max', label: '最多几题', type: 'number', required: false, default: 5, min: 1, max: 20 },
    ],
    produces: ['note'],
    awaitsUser: false,
  },
  {
    kind: 'digest',
    label: '词条沉淀',
    description: '把本流已涉及的内容抽成词条入库，并建立与已有词条的关系',
    typeVersion: 1,
    params: [
      { key: 'domain', label: '归入领域', type: 'string', required: false, default: 'general', example: '如：数学 · 函数' },
      { key: 'minImportance', label: '最低重要度', type: 'number', required: false, default: 0.4, min: 0, max: 1 },
    ],
    produces: ['term'],
    awaitsUser: false,
  },
  {
    kind: 'summary',
    label: '总结',
    description: '把本流学过的内容汇总成一段可回顾的总结',
    typeVersion: 1,
    params: [
      {
        key: 'style',
        label: '风格',
        type: 'select',
        required: false,
        default: 'outline',
        options: ['brief', 'outline', 'detailed'],
      },
    ],
    produces: ['concept'],
    awaitsUser: false,
  },
];

/** 按 kind 取注册表项（未知 kind 返回 undefined，调用方负责报错——不静默兜底） */
export function findFlowStepMeta(kind: string): FlowStepMeta | undefined {
  return FLOW_STEP_METAS.find((m) => m.kind === kind);
}
