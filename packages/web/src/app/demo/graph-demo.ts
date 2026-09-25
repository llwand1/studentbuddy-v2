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
 *
 * ★ 2026-09-22 中英切换批（老板决策：帧内示例**整段换英文等价物**，不做半中半英）：
 *   节点名进 `NODE_TEXTS`（`Bi`）。中文侧仍是那堂「梯度下降」的机器学习课；英文侧换成
 *   同样结构的「Overfitting」一例——**示例不必同词，结构必须同构**（一确认边 + 星 + 树 +
 *   转正），因为英文侧换词是被 92px 卡片宽逼的（'Gradient descent' 16 字放不进），
 *   而 caption/解说词从不点名「梯度下降」，只讲"词条→追问→连边"这套机制。
 *   ★ 交叉一致锁（抽词清单 === 该帧新增节点）在 `graph-demo.test.ts` 里**逐语言**跑。
 */
import type { KnowledgeEdge, KnowledgeEdgeOrigin, KnowledgeNeighborhood, KnowledgeNode, KnowledgeNodeKind } from './graph-types';
import { layoutNeighborhood } from './graph-visual';
import type { Bi, LandingLang } from '../landing-lang';

/**
 * 演示窗画布。★ 尺寸是按 hero 右栏反算的，不是随手取的：
 *   `ld-stage` 高 302 − 上下 padding 32 = 270 可用高；宽约 550。
 *   取 520×268 后等比缩放到 270 高时正好 1.0 倍左右（卡片 92px 宽、字号 ~12.6px 清楚可读）；
 *   若沿用 680×480，缩放系数掉到 0.56、卡片缩成 60px、字号掉到 7px——演示就白做了。
 */
export const GRAPH_DEMO_VIEW = { w: 520, h: 268 } as const;

/**
 * 紧凑几何：环半径 112/186、卡片 92×30（真图是 122/196 与 108×34）。
 *
 * ★ 这两个数是被约束**逼出来**的，不能随手调小：
 *   ① 二跳节点与父节点挨太近会**叠在一起**（中心距要在一个轴上大于卡片边长）；
 *   ② 一跳半径必须显著大于卡片宽：`ringR1` 取 100 时，中心卡片与左右两张之间只剩 8px 缝，
 *      三张卡片看起来**连成一片**（108 → **112** 后缝变 20px）。
 *      ★ 这条是「几何断言全绿 ≠ 观感合格」的实例——不重叠判据只保证**不相交**，不保证**不挤**；
 *      8px 缝在单测里是"合法"的，只有真机截图才看得出来（见 `tools/probes/landing-demo-cdp.mjs`）。
 */
export const GRAPH_DEMO_OPTS = { ringR1: 112, ringStep: 74, box: { w: 92, h: 30 } } as const;

/** 标签截宽：中文 8 字（原口径）；英文按 92px 卡片放得下的拉丁字数量级取 14 */
export const CLIP_MAX: Record<LandingLang, number> = { zh: 8, en: 14 };

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

/**
 * ★ 节点显示名（按节点 id 索引）。id 前缀 a/b/c/d **决定环上角度**（`layoutNeighborhood`
 *   按 id 升序分配扇区），所以换名/换语言都不许动 id 的字母序——2026-09-22 双语批把
 *   id 里的语义后缀（-lr / -over…）摘成中性，就是因为它们已开始对不上英文侧的内容。
 */
export const NODE_TEXTS: Record<string, Bi> = {
  'g-center': { zh: '梯度下降', en: 'Overfitting' },
  'g-a': { zh: '损失函数', en: 'Regularization' },
  'g-b': { zh: '学习率', en: 'Dropout' },
  'g-c': { zh: '反向传播', en: 'Weight decay' },
  'g-d': { zh: '过拟合', en: 'Train loss' },
  'g-e': { zh: '学习率衰减', en: 'Bernoulli' },
  'g-f': { zh: 'Adam', en: 'Ensemble' },
};

/** 取节点在 `lang` 下的显示名（缺表即抛——宁崩在开发期，不静默画出空白卡片） */
export function nodeText(id: string, lang: LandingLang): string {
  const t = NODE_TEXTS[id];
  if (!t) throw new Error(`演示节点 ${id} 没有双语名`);
  return t[lang];
}

/** 中心词条：整张图围着它转（`refText` 恒存中文侧——它只是拓扑数据，显示一律走 `NODE_TEXTS`） */
export const DEMO_CENTER: KnowledgeNode = {
  id: 'g-center',
  kind: 'term',
  refId: 'demo-center',
  refText: NODE_TEXTS['g-center']!.zh,
  sourceRunId: null,
  sourceStepId: null,
  createdAt: T,
};

/**
 * 邻域节点（含中心）。`at` = 该节点**首次出现**的帧号。
 * ★ 一跳共 4 个：id 的字母序决定角度（正上方起、整圆均分），改 id 会整图转角度。
 */
type DemoNode = { node: KnowledgeNode; at: number };

function demoNode(id: string, refId: string, createdAt: string): KnowledgeNode {
  return { id, kind: 'term', refId, refText: NODE_TEXTS[id]!.zh, sourceRunId: null, sourceStepId: null, createdAt };
}

const NODES: DemoNode[] = [
  { node: DEMO_CENTER, at: FRAME.first },
  { node: demoNode('g-a', 'demo-a', T), at: FRAME.first },
  { node: demoNode('g-b', 'demo-b', T2), at: FRAME.star },
  { node: demoNode('g-c', 'demo-c', T2), at: FRAME.star },
  { node: demoNode('g-d', 'demo-d', T2), at: FRAME.star },
  { node: demoNode('g-e', 'demo-e', T3), at: FRAME.tree },
  { node: demoNode('g-f', 'demo-f', T3), at: FRAME.tree },
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
 *   （evidence 不上屏，双语批不为其配 `en`。）
 */
type DemoEdge = { edge: KnowledgeEdge; at: number };

const EDGES: DemoEdge[] = [
  {
    edge: { id: 'ge-a', fromNodeId: 'g-center', toNodeId: 'g-a', kind: 'relates', origin: 'user', weight: 0.9, evidence: '手工确认', createdAt: T },
    at: FRAME.first,
  },
  {
    edge: { id: 'ge-b', fromNodeId: 'g-center', toNodeId: 'g-b', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-c', fromNodeId: 'g-center', toNodeId: 'g-c', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-d', fromNodeId: 'g-center', toNodeId: 'g-d', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「梯度下降」', createdAt: T2 },
    at: FRAME.star,
  },
  {
    edge: { id: 'ge-e', fromNodeId: 'g-b', toNodeId: 'g-e', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「学习率」', createdAt: T3 },
    at: FRAME.tree,
  },
  {
    edge: { id: 'ge-f', fromNodeId: 'g-b', toNodeId: 'g-f', kind: 'relates', origin: 'ai', weight: 0.5, evidence: '追问「学习率」', createdAt: T3 },
    at: FRAME.tree,
  },
];

/** 帧 4 演示「确认一次就转正」的那条边（中心—g-b，图上最核心的一条 AI 关系） */
export const CONFIRMED_EDGE_ID = 'ge-b';

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
export const DEMO_ASK: { term: Bi; placeholder: Bi; button: Bi; note: Bi } = {
  term: NODE_TEXTS['g-center']!,
  placeholder: { zh: '想问这个词条什么？（留空用默认问法）', en: 'What do you want to ask about this term? (blank = default prompt)' },
  button: { zh: '向 AI 追问', en: 'Ask AI' },
  note: { zh: '开一条独立会话 · 自动带上原对话摘要', en: 'Opens its own thread · seeded with the original summary' },
};

/**
 * 帧 2 的"回复抽词"清单——★ 与 `at === FRAME.star` 的三个节点**必须逐字一致（两语各自）**。
 * 这两处一旦漂开，演示就会出现"提示说抽到 A，图上却连出 B"的错位（读者会怀疑图是假的）。
 * `graph-demo.test.ts` 里有一条**逐语言**的交叉断言锁住这份一致。
 */
export const DEMO_REPLY_TERMS: Record<LandingLang, readonly string[]> = {
  zh: ['学习率', '反向传播', '过拟合'],
  en: ['Dropout', 'Weight decay', 'Train loss'],
};

/**
 * 帧 3 的二跳：对「学习率 / Dropout」再追一层，回复里又抽出两个词条。
 * ★ 同样与 `at === FRAME.tree` 的两个节点**逐语言**对齐（理由同上）。
 */
export const DEMO_DEEP: { term: Bi; terms: Record<LandingLang, readonly string[]> } = {
  term: NODE_TEXTS['g-b']!,
  terms: { zh: ['学习率衰减', 'Adam'], en: ['Bernoulli', 'Ensemble'] },
};

// ── 上屏文案（★ 组件里不留中文字面量，与 `landing-copy.ts` 同一条纪律）──

/**
 * 节点类型角标。zh 侧与真图的 `nodeKindLabel`（`graph-visual.ts:272`）逐字同词——
 * 演示窗用的就是知识图页那套类名与口径，角标不一样就是货不对板。
 * en 侧只在这扇演示窗里出现（登录后应用内 UI 不在本批双语范围）。
 */
export const NODE_KIND_TEXT: Record<KnowledgeNodeKind, Bi> = {
  term: { zh: '词条', en: 'Term' },
  note: { zh: '错题笔记', en: 'Mistake note' },
  turn: { zh: '对话轮次', en: 'Chat turn' },
  concept: { zh: '概念', en: 'Concept' },
};

export function nodeKindText(kind: KnowledgeNodeKind, lang: LandingLang): string {
  return NODE_KIND_TEXT[kind][lang];
}

/** 节点悬浮标题（`词条：梯度下降`）：zh 侧沿用真图 `NeighborhoodGraph.tsx:104` 的全角冒号，en 侧换半角 */
const NODE_TITLE_SEP: Bi = { zh: '：', en: ': ' };

export function nodeTitle(id: string, kind: KnowledgeNodeKind, lang: LandingLang): string {
  return `${nodeKindText(kind, lang)}${NODE_TITLE_SEP[lang]}${nodeText(id, lang)}`;
}

/** 帧 2/3 底部那行"抽出了哪些词条"的引导语；`{t}` 填该帧追问的那个词条 */
const TIER_LABELS = {
  star: { zh: '追问回复抽出：', en: 'Extracted from the reply: ' },
  tree: { zh: '对「{t}」再追一层，回复抽出：', en: 'Second follow-up on “{t}” extracted: ' },
} as const satisfies Record<string, Bi>;

/** 该帧的抽词清单（★ 与图上该帧新增的节点逐语言一致，交叉锁在 `graph-demo.test.ts`） */
export function termsAt(stage: number, lang: LandingLang): readonly string[] {
  return stage >= FRAME.tree ? DEMO_DEEP.terms[lang] : DEMO_REPLY_TERMS[lang];
}

export function termLabelAt(stage: number, lang: LandingLang): string {
  if (stage < FRAME.tree) return TIER_LABELS.star[lang];
  return TIER_LABELS.tree[lang].replace('{t}', DEMO_DEEP.term[lang]);
}

/**
 * 图例：★ 只列**这张图上真实存在**的 origin 两种（`user` / `ai`），不把真图那三条抄全。
 *   演示里出现一条图上没有的"结构推导"图例，读者会去找那种线然后找不到
 *   （同「未配 GitHub 凭据就不画登录按钮」的纪律：不画图上没有的东西）。
 *   文案比真图的 `NeighborhoodGraph` 短（演示窗窄），但"未经确认"这个关键限定词必须留。
 */
export const GRAPH_LEGEND: Array<{ origin: KnowledgeEdgeOrigin; text: Bi }> = [
  { origin: 'user', text: { zh: '已确认', en: 'Confirmed' } },
  { origin: 'ai', text: { zh: 'AI 抽的·未经确认', en: 'AI-drawn · unconfirmed' } },
];

/** 整幅图的读屏说明（SVG 对读屏只是一个 `role="img"`，这句是它唯一的交代） */
const GRAPH_ARIA: Bi = {
  zh: '知识关系图演示：以「{t}」为中心，向 AI 追问后回复里的词条自动连成关系',
  en: 'Knowledge graph demo: “{t}” sits at the center, and terms extracted from an AI follow-up reply link themselves back to it',
};

export function graphAriaLabel(lang: LandingLang): string {
  return GRAPH_ARIA[lang].replace('{t}', DEMO_ASK.term[lang]);
}
