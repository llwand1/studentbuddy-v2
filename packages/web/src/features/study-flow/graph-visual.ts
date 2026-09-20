/**
 * graph-visual —— 知识数据图的**渲染纯逻辑**（契约 docs/STUDY-FLOW-SPEC.md §3 / §4）。
 *
 * ★ 为什么单独成文件（而不是写在组件里）：本仓 web 组件有 `.tsx ≤300 行` 的 gates 红线，
 *   而「邻域怎么摆、边从哪画到哪、三种 origin 怎么区分」全是**与 React 无关的几何/映射**，
 *   抽出来既能单测（摆位错了是肉眼很难发现的那类 bug），组件里只剩渲染。
 *
 * ★ 本文件**不产出任何颜色值**，只产出 CSS 类名（`gr-edge ai` 这种）——配色是
 *   `tokens.css` 的职责；组件里写死颜色会同时踩「禁内联样式」与「配色不集中」两条。
 */
import type {
  KnowledgeEdge,
  KnowledgeEdgeKind,
  KnowledgeEdgeOrigin,
  KnowledgeNeighborhood,
  KnowledgeNode,
  KnowledgeNodeKind,
} from '@sb/shared';

/**
 * 邻域图的固定坐标系（组件按容器宽度等比缩放，`preserveAspectRatio` 兜住比例）。
 * ★ 高度取 480 而不是"看起来够用"的 460：最外环（二跳）在 196px 半径上，加上卡片半高与
 *   下方标签需要约 233px 的余量，中心 y=240 时刚好兜住——矮一点最外圈的卡片会被裁掉。
 */
export const GRAPH_VIEW = { w: 680, h: 480 } as const;

/** 节点卡片尺寸（中心对齐；见下方 `rectEdgePoint` 用它算边端点） */
export const NODE_BOX = { w: 108, h: 34 } as const;

/** 各跳的环半径。`R1 `放一跳、之后每跳 +74（够放下一环的卡片，不至于挤成一团） */
const RING_R1 = 122;
const RING_STEP = 74;

export interface PlacedNode {
  node: KnowledgeNode;
  /** 卡片中心坐标 */
  x: number;
  y: number;
  /** 与中心节点的跳数（0 = 中心） */
  depth: number;
  /** 该跳的环半径（中心节点为 0），供组件画环引导线 */
  ring: number;
}

export interface PlacedEdge {
  edge: KnowledgeEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 边中点（放类型标签的位置） */
  mx: number;
  my: number;
  /** 两端是否都落在图内（不可能为 false，留字段是为了 future 视口裁剪不改变调用面） */
  visible: boolean;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** 实际用到的最大跳数（0 = 只有一个孤立中心） */
  maxDepth: number;
  /** 各跳半径（去重后升序，组件据此画同心环） */
  rings: number[];
}

/**
 * 布局的**尺寸可调项**（都有默认值 ⇒ 不传就是知识图页的原尺寸）。
 *
 * ★ 为什么需要它：落地页 hero 的演示窗只有 ~550×270 的可用区，而知识图页是 680×420。
 *   若把 680×480 的坐标硬塞进演示窗再等比缩小，节点卡片会缩到 60px 宽、字号掉到 7px——
 *   演示的意义（让人看清"词条之间连起来了"）当场没了。
 *
 * ★ 只调**尺寸**、不动**规则**：分层、扇区角序、边缩进、孤立节点兜底全部照旧。
 *   若为演示另写一份布局，两份必然漂开（同 RefList / ReviewPanel 的先例），
 *   而"演示里的图长什么样"恰恰是用户对知识图的第一印象——漂了比没有更糟。
 */
export interface GraphLayoutOptions {
  /** 一跳环半径（默认 `RING_R1`＝122） */
  ringR1?: number;
  /** 每多一跳的半径增量（默认 `RING_STEP`＝74） */
  ringStep?: number;
  /** 节点卡片尺寸（默认 `NODE_BOX`）——边端点按它缩进，小了必须同步传 */
  box?: { w: number; h: number };
}

/** 标签截断：超长词条名会把画布撑烂，截断比换行好（换行会让节点高度不定） */
export function clipLabel(text: string, max = 9): string {
  const s = text.trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 射线与轴对齐矩形（卡片）的**最近交点**——用来把边缩到卡片边缘，箭头才露得出来。
 *
 * ★ 为什么不用「按固定半径缩进」那种近似：斜向边若统一缩 30px，水平边会压在卡片上、
 *   垂直边又会离得很远。`t = min(a/|ux|, b/|uy|)` 是矩形相交的精确解，一行就能算对。
 *   `|ux|` 或 `|uy|` 为 0（正上/正下/正左/正右）时对应项取 `Infinity` 自动让位给另一轴。
 */
export function rectEdgePoint(
  cx: number,
  cy: number,
  towardX: number,
  towardY: number,
  // ★ 显式声明为「宽高各是一个数」而不是 `typeof NODE_BOX`：后者是 `as const` 出来的
  //   字面量类型（`{readonly w:108; readonly h:34}`），会把调用方锁死在 108×34 上，
  //   落地页演示窗的小卡片（92×26）传不进来。默认值仍是 NODE_BOX，行为不变。
  box: { w: number; h: number } = NODE_BOX,
): { x: number; y: number } {
  const dx = towardX - cx;
  const dy = towardY - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: cx, y: cy };
  const ux = dx / len;
  const uy = dy / len;
  const tx = ux === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(ux);
  const ty = uy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(uy);
  const t = Math.min(tx, ty);
  return { x: cx + ux * t, y: cy + uy * t };
}

/**
 * 邻域子图 → 画布布局。
 *
 * 摆位规则（先定**分层**、再定**同层角序**）：
 *  ① 用 BFS 从中心算跳数，并按 BFS 树记下每个节点的「父」；
 *  ② 中心放圆心；一跳节点沿整圆均分；
 *  ③ 二跳及以后：**落在父节点的角度扇区内**（而不是整圆均分）——不这样做的话，
 *     二跳节点会飘到与它无关的分支那边去，看起来像连错了。
 *
 * ★ 同层角序用**节点 id 排序**而非入参顺序：同一份数据必须摆出同一张图，
 *   否则用户每点一次刷新，图就转一个角度（"图在动" 会让人怀疑数据变了）。
 */
export function layoutNeighborhood(
  nb: KnowledgeNeighborhood,
  // ★ 同样显式声明为「宽高各是一个数」：`GRAPH_VIEW` 是 `as const` 出来的字面量类型
  //   （`{readonly w:680; readonly h:480}`），不写开就会把调用方锁死在 680×480 上，
  //   落地页演示窗的 520×268 传不进来。默认值仍是 GRAPH_VIEW，行为不变。
  view: { w: number; h: number } = GRAPH_VIEW,
  opts: GraphLayoutOptions = {},
): GraphLayout {
  const cx = view.w / 2;
  const cy = view.h / 2;
  // 尺寸可调项（不传即原尺寸；见 GraphLayoutOptions 的说明）
  const r1 = opts.ringR1 ?? RING_R1;
  const step = opts.ringStep ?? RING_STEP;
  const box = opts.box ?? NODE_BOX;

  // ── ① BFS 分层（无向；只走邻域返回的那批边） ──
  //
  // ★ 先按「节点清单」过滤边：邻域是按深度截断出来的（契约 §3.3），深处那条边很可能
  //   一端在清单里、另一端已经被截掉了。若不过滤，BFS 会把清单外的 id 也当节点拉进来，
  //   最后摆出一个没有名字的幽灵卡片（`byId.get(id)` 为 undefined）。
  //   这类边画不出来是**正确**的（不知道它该摆在哪），跳过即可，不是错误。
  const byId = new Map<string, KnowledgeNode>();
  for (const n of nb.nodes) byId.set(n.id, n);
  byId.set(nb.center.id, nb.center);

  const adj = new Map<string, string[]>();
  const drawableEdges = nb.edges.filter((e) => byId.has(e.fromNodeId) && byId.has(e.toNodeId));
  for (const e of drawableEdges) {
    if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, []);
    if (!adj.has(e.toNodeId)) adj.set(e.toNodeId, []);
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    adj.get(e.toNodeId)!.push(e.fromNodeId);
  }

  const depth = new Map<string, number>([[nb.center.id, 0]]);
  const parent = new Map<string, string>();
  const queue = [nb.center.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const next of adj.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      parent.set(next, id);
      queue.push(next);
    }
  }
  // 孤立节点（未被任何边连到中心）：不硬塞进环里，单独归到最外环——比丢弃诚实
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const orphans = nb.nodes.filter((n) => !depth.has(n.id));
  if (orphans.length > 0) maxDepth = Math.max(maxDepth, 1);

  // ── ② 逐层摆位：先把角度定下来 ──
  const angle = new Map<string, number>([[nb.center.id, -Math.PI / 2]]);
  const place = new Map<string, PlacedNode>();

  const ringOf = (d: number) => (d === 0 ? 0 : r1 + (d - 1) * step);
  const at = (id: string, d: number, ang: number): PlacedNode => {
    const r = ringOf(d);
    return {
      node: byId.get(id)!,
      x: cx + Math.cos(ang) * r,
      y: cy + Math.sin(ang) * r,
      depth: d,
      ring: r,
    };
  };

  place.set(nb.center.id, at(nb.center.id, 0, -Math.PI / 2));

  for (let d = 1; d <= maxDepth; d += 1) {
    const group = [...depth.entries()]
      .filter(([, dd]) => dd === d)
      .map(([id]) => id)
      .sort();
    // 孤立节点补齐到第一环（它们没有父，按 id 顺序排在真实一跳节点之后）
    const ids = d === 1 ? [...group, ...orphans.map((o) => o.id).sort()] : group;
    if (ids.length === 0) continue;

    if (d === 1) {
      // 一跳：整圆均分，从正上方开始（视觉上"上面是入口"）
      const step = (Math.PI * 2) / ids.length;
      ids.forEach((id, i) => {
        const ang = -Math.PI / 2 + i * step;
        angle.set(id, ang);
        place.set(id, at(id, 1, ang));
      });
      continue;
    }

    // 二跳及以后：按父节点分组，各组在父角度附近 ±spread 内均分
    const byParent = new Map<string, string[]>();
    for (const id of ids) {
      const p = parent.get(id) ?? nb.center.id;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(id);
    }
    for (const [p, kids] of [...byParent.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const base = angle.get(p) ?? -Math.PI / 2;
      // 兄弟越多扇得越开，但封顶 90°，免得两跳节点绕回去跟别家重叠
      const spread = Math.min(Math.PI / 2, 0.42 * kids.length);
      const step = kids.length > 1 ? spread / (kids.length - 1) : 0;
      kids.sort().forEach((id, i) => {
        const ang = kids.length > 1 ? base - spread / 2 + i * step : base;
        angle.set(id, ang);
        place.set(id, at(id, d, ang));
      });
    }
  }

  // ── ③ 边：端点缩到卡片边缘，中点留给类型标签 ──
  const edges: PlacedEdge[] = [];
  for (const e of drawableEdges) {
    const a = place.get(e.fromNodeId);
    const b = place.get(e.toNodeId);
    if (!a || !b) continue; // 兜底：理论上 ① 已滤过，这里防住后续改动引入的失配
    const p1 = rectEdgePoint(a.x, a.y, b.x, b.y, box);
    const p2 = rectEdgePoint(b.x, b.y, a.x, a.y, box);
    edges.push({
      edge: e,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      mx: (p1.x + p2.x) / 2,
      my: (p1.y + p2.y) / 2,
      visible: true,
    });
  }

  const rings = [...new Set([...place.values()].map((p) => p.ring).filter((r) => r > 0))].sort((a, b) => a - b);

  return { nodes: [...place.values()], edges, maxDepth, rings };
}

// ── 语义 → 文案 / CSS 类名（配色与线型归 CSS，见文件头）──

export function nodeKindLabel(kind: KnowledgeNodeKind): string {
  switch (kind) {
    case 'term':
      return '词条';
    case 'note':
      return '错题笔记';
    case 'turn':
      return '对话轮次';
    case 'concept':
      return '概念';
    default:
      return kind;
  }
}

export function edgeKindLabel(kind: KnowledgeEdgeKind): string {
  switch (kind) {
    case 'prereq':
      return '前置';
    case 'relates':
      return '相关';
    case 'derived_from':
      return '由…引发';
    case 'contains':
      return '从属';
    default:
      return kind;
  }
}

/**
 * 边出处的**视觉分层**（契约 §4.2：三值刻意不平权，前端必须让它们看起来就不一样）。
 * 返回 CSS 类名，三种 origin 各对应一套「颜色 + 线型 + 标签」。
 *
 * ★ `ai` 那一档必须在**明处**标注「可能不准」：模型抽取的边是幻觉风险最高的产物，
 *   用户有权一眼看出哪些关系不是自己确认过的（可一键转正/删除，见节点详情）。
 */
export function edgeOriginLabel(origin: KnowledgeEdgeOrigin): string {
  switch (origin) {
    case 'user':
      return '已确认';
    case 'ai':
      return 'AI 抽取·未经确认';
    case 'derived':
      return '结构推导';
    default:
      return origin;
  }
}

/** 节点卡片的 CSS 类名（`gr-node <kind>`，配色在 graph.css 按 kind 分档） */
export function nodeClass(node: KnowledgeNode, isCenter: boolean): string {
  return `gr-node ${node.kind}${isCenter ? ' center' : ''}`;
}

/** 边的 CSS 类名（`gr-edge <origin>`，线型/颜色在 graph.css 按 origin 分档） */
export function edgeClass(origin: KnowledgeEdgeOrigin): string {
  return `gr-edge ${origin}`;
}

/**
 * 该 origin 的边是否**可被用户直接删除**。
 * `derived` 走批量撤销（`purgeDerived`），不该在单边上做逐个删除——那是两个不同动作，
 * 混成一个会让用户以为"删干净了"，实际规则重算后又会冒出来。
 */
export function canRemoveEdge(origin: KnowledgeEdgeOrigin): boolean {
  return origin !== 'derived';
}
