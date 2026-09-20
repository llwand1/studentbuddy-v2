/**
 * graph-demo —— 落地页「知识图演示」的**数据 + 帧显现逻辑**（渲染在 `GraphDemo.tsx`）。
 *
 * ★ 为什么单独成文件：本仓 demo 的纪律是「帧渲染器只读 stage」，而"第几帧该露出哪个节点/
 *   哪条边"是可单测的**纯逻辑**（纯函数、无 React、无计时器）。放在组件里就只能靠看图验，
 *   而这类"少露一条边"的错恰恰是肉眼最容易漏的（图看起来还是对的）。
 *
 * ★★ 本演示唯一的硬约束：**布局必须一次性算完，帧只控制显现**。
 *   若按帧重算布局（"第 2 帧只有 4 个节点 ⇒ 每 90° 一个"），那么加到 5 个节点时角度会
 *   重分配，**已经画出来的节点会当场飞走**——观感上像图在抽搐，而不是在生长。
 *   故 `GRAPH_DEMO_NEIGHBORHOOD` 恒含**最终拓扑**，`layout` 也只算一次（模块级常量）。
 *
 * ★ 几何**不重写**：直接调知识图页的 `layoutNeighborhood`（同一份 BFS 分层 / 扇区角序 /
 *   边缩进实现），只把环半径与卡片尺寸调小一号（hero 右栏可用区 ~550×268，放不下
 *   680×480 的原尺寸）。若为演示另写一份布局，两份必然漂开——而"演示里的图长什么样"
 *   正是访客对知识图的第一印象，漂了比没有更糟。
 *
 * ★ 数据全部前端写死（同 `TermFlowDemo`）：落地页是门面，不做需要后端配合的活演示。
 */
import type { KnowledgeEdge, KnowledgeEdgeOrigin, KnowledgeNeighborhood, KnowledgeNode } from '@sb/shared';
import { layoutNeighborhood } from '../../features/study-flow/graph-visual';

/**
 * 演示窗画布。★ 尺寸是按 hero 右栏反算的，不是随手取的：
 *   `ld-stage` 高 302 − 上下 padding 32 = 270 可用高；宽约 550。
 *   取 520×268 后等比缩放到 270 高时正好 1.0 倍左右（卡片 92px 宽、字号 ~12.6px 清楚可读）；
 *   若沿用 680×480，缩放系数掉到 0.56、卡片缩成 60px、字号掉到 7px——演示就白做了。
 */
export const GRAPH_DEMO_VIEW = { w: 520, h: 268 } as const;

/**
 * 紧凑几何：环半径 100/180、卡片 92×26（真图是 122/196 与 108×34）。
 * ★ 这两个数不能随手调小：二跳节点与它的父节点若挨太近，两张卡片会**叠在一起**
 *   （中心距要大于两个半宽之和）。`graph-demo.test.ts` 里有一条「无卡片重叠」的断言兜住。
 */
export const GRAPH_DEMO_OPTS = { ringR1: 100, ringStep: 80, box: { w: 92, h: 26 } } as const;

/**
 * 帧语义（下标与 `registry.ts` 的 `GRAPH_DEMO.stages` 一一对应，改一处必须改两处）。
 * 用常量而不是裸数字：组件里写 `stage >= 3` 读起来是"大于等于三"，而
 * `stage >= FRAME.tree` 读起来是"已经长到树了"——后者才是这行代码的意思。
 */
export const FRAME = { first: 0, ask: 1, star: 2, tree: 3, origin: 4 } as const;

/** 演示里的时间戳：★ 写死而不用 `new Date()`——同一帧每次渲染必须完全一致 */
const T = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-20T10:00:30.000Z';
const T3 = '2026-09-20T10:01:00.000Z';

/** 中心词条：整张图围着它转 */
export const DEMO_CENTER: KnowledgeNode = {
  id: 'g-center',
  kind: 'term',
  refId: 'demo-center',
  refText: '梯度下降',
  sourceRunId: null,
  sourceStepId: null,
  createdAt: T,
};

/**
 * 邻域节点（含中心）。`at` = 该节点**首次出现**的帧号。
 * ★ 一跳共 4 个（损失函数 / 学习率 / 反向传播 / 过拟合）：`layoutNeighborhood` 按 **id 升序**
 *   分配角度（正上方起、整圆均分），故这里的 id 前缀故意排成 a/b/c/d，让"谁在上谁在右"
 *   可预期——否则改一个 id 就会让整张图转个角度，而没人会想到是 id 在决定位置。
 */
type DemoNode = { node: KnowledgeNode; at: number };

const NODES: DemoNode[] = [
  { node: DEMO_CENTER, at: FRAME.first },
  { node: { id: 'g-a-loss', kind: 'term', refId: 'demo-loss', refText: '损失函数', sourceRunId: null, sourceStepId: null, createdAt: T }, at: FRAME.first },
  { node: { id: 'g-b-lr', kind: 'term', refId: 'demo-lr', refText: '学习率', sourceRunId: null, sourceStepId: null, createdAt: T2 }, at: FRAME.star },
  { node: { id: 'g-c-bp', kind: 'term', refId: 'demo-bp', refText: '反向传播', sourceRunId: null, sourceStepId: null, createdAt: T2 }, at: FRAME.star },
  { node: { id: 'g-d-over', kind: 'term', refId: 'demo-over', refText: '过拟合', sourceRunId: null, sourceStepId: null, createdAt: T2 }, at: FRAME.star },
  { node: { id: 'g-e-decay', kind: 'term', refId: 'demo-decay', refText: '学习率衰减', sourceRunId: null, sourceStepId: null, createdAt: T3 }, at: FRAME.tree },
  { node: { id: 'g-f-adam', kind: 'term', refId: 'demo-adam', refText: 'Adam', sourceRunId: null, sourceStepId: null, createdAt: T3 }, at: FRAME.tree },
];

/**
 * 邻域边。`at` = 该边**首次出现**的帧号。
 *
 * ★ 出处分档刻意让**两种同时出现在图上**（帧 0 就有一条 `user` 实线）：
 *   演示要讲的正是"AI 连的边和确认过的边看起来不一样"，若全图只有一种 origin，
 *   帧 4 就没有对照物，用户看不出区别在哪。
 *
 * ★ `ai` 边的 `evidence` 存"AI 抽取时的原话摘录"（契约 `KNOWLEDGE-FOLLOWUP-SPEC` §3），
 *   `weight=0.5` 是追问连边的既定口径——演示数据也照抄，免得演示与真机两套说法。
 */
type DemoEdge = { edge: KnowledgeEdge; at: number };

const EDGES: DemoEdge[] = [
  {
    edge: { id: 'ge-loss', fromNodeId: 'g-center', toNodeId: 'g-a-loss', kind: 'relates', origin: 'user', weight: 0.9, evidence: '手工确认', createdAt: T },
    at: FRAME.first,
  },
  {
    edge: { id: 'ge-lr', fromNodeId: 'g-center', toNodeId: 'g-b-lr', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-bp', fromNodeId: 'g-center', toNodeId: 'g-c-bp', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-over', fromNodeId: 'g-center', toNodeId: 'g-d-over', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-decay', fromNodeId: 'g-b-lr', toNodeId: 'g-e-decay', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「学习率」', createdAt: T3 },
    at: FRAME.tree,
  },
  {
    edge: { id: 'ge-adam', fromNodeId: 'g-b-lr', toNodeId: 'g-f-adam', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「学习率」', createdAt: T3 },
    at: FRAME.tree,
  },
];

/** 帧 4 演示「确认一次就转正」的那条边（中心—学习率，图上最核心的一条 AI 关系） */
export const CONFIRMED_EDGE_ID = 'ge-lr';

/**
 * 最终拓扑（**恒定不变**；帧只决定显现多少，见文件头）。
 * ★ 并进中心的节点去重：`layoutNeighborhood` 会把 `center` 也放进 `byId`，
 *   若 `nodes` 里再放一份中心，`place` 里同一个 id 会被算两次（虽然结果相同，但语义重复）。
 */
export const GRAPH_DEMO_NEIGHBORHOOD: KnowledgeNeighborhood = {
  center: DEMO_CENTER,
  nodes: NODES.filter((n) => n.node.id !== DEMO_CENTER.id).map((n) => n.node),
  edges: EDGES.map((e) => e.edge),
  truncated: false,
};

/**
 * ★ 布局**只算一次**（模块级常量）：它同时承担两件事——
 *   ① 性能上不必每帧重算；② 语义上保证"节点不会在第 2 帧和第 3 帧之间换位置"。
 *   把它写成函数再在组件里 `useMemo` 也能跑，但那样"只算一次"就成了一条口头约定，
 *   而这里它是**类型与作用域保证的事实**。
 */
export const GRAPH_DEMO_LAYOUT = layoutNeighborhood(GRAPH_DEMO_NEIGHBORHOOD, GRAPH_DEMO_VIEW, GRAPH_DEMO_OPTS);

// ── 帧 → 显现（渲染层唯一需要的三个判据）──

const NODE_AT = new Map(NODES.map((n) => [n.node.id, n.at]));
const EDGE_AT = new Map(EDGES.map((e) => [e.edge.id, e.at]));

/** 该节点在第 `stage` 帧是否该出现（中心恒在——它是这张图的锚） */
export function nodeVisibleAt(node: KnowledgeNode, stage: number): boolean {
  if (node.id === DEMO_CENTER.id) return true;
  return (NODE_AT.get(node.id) ?? Number.POSITIVE_INFINITY) <= stage;
}

/** 该边在第 `stage` 帧是否该出现 */
export function edgeVisibleAt(edge: KnowledgeEdge, stage: number): boolean {
  return (EDGE_AT.get(edge.id) ?? Number.POSITIVE_INFINITY) <= stage;
}

/**
 * 该边在第 `stage` 帧的**出处**（帧 4 把 `CONFIRMED_EDGE_ID` 那条从 `ai` 转成 `user`）。
 *
 * ★ 转正只改 origin、**不改 kind**：用户确认的是"这条关系成立"，
 *   而"相关"还是"前置"是另一件事（真机里也允许确认后再改类型）。演示若把两者一起改，
 *   就把两个独立动作糊成了一个。
 */
export function edgeOriginAt(edge: KnowledgeEdge, stage: number): KnowledgeEdgeOrigin {
  if (edge.id === CONFIRMED_EDGE_ID && stage >= FRAME.origin) return 'user';
  return edge.origin;
}

/** 帧 1 要浮出的那张词条卡（文案与真机 `TermCard` 的「向 AI 追问」同口径） */
export const DEMO_ASK = {
  term: DEMO_CENTER.refText,
  /** 真机词条卡上的输入占位（留空即用默认问法） */
  placeholder: '想问这个词条什么？（留空用默认问法）',
  button: '向 AI 追问',
  note: '开一条独立会话 · 自动带上原对话摘要',
} as const;

/**
 * 帧 2 的"回复抽词"清单——★ 与 `at === FRAME.star` 的三个节点**必须逐字一致**。
 * 这两处一旦漂开，演示就会出现"提示说抽到 A，图上却连出 B"的错位（读者会怀疑图是假的）。
 * `graph-demo.test.ts` 里有一条交叉断言锁住这份一致。
 */
export const DEMO_REPLY_TERMS = ['学习率', '反向传播', '过拟合'] as const;
