/**
 * NeighborhoodGraph — 知识数据图的**邻域子图**渲染（契约 docs/STUDY-FLOW-SPEC.md §3.3）。
 *
 * 只画「当前节点 + N 跳」这一小块，**刻意不画全图**：词条级全图到万级节点会拖死渲染，
 * 而用户此刻真正想看的正是「这个词条跟谁有关系」。
 *
 * ★ 三处如实说明（ADR-5 不静默，都是用户会误判的地方）：
 *   ① 深度被截断时给出 `truncated` 提示——不许把局部图冒充全图；
 *   ② 图例把三种 `origin` 的差别写出来（尤其 AI 抽取的边"未经确认"）；
 *   ③ 点击任一节点即**以它为新的中心**重画（这就是"顺着关系走下去"的交互本体）。
 *
 * 布局与配色全部来自 `graph-visual.ts`（几何）与 `graph.css`（配色）：本组件不算坐标、不写颜色。
 */
import { GRAPH_VIEW, NODE_BOX, clipLabel, edgeClass, edgeKindLabel, layoutNeighborhood, nodeClass, nodeKindLabel } from './graph-visual';
import type { KnowledgeNeighborhood } from '@sb/shared';
import './graph.css';

/** 三种边出处在图例里的说明（与 `edgeClass` 的分档一一对应） */
const LEGEND: Array<{ origin: 'user' | 'ai' | 'derived'; text: string }> = [
  { origin: 'user', text: '已确认（你手工连的）' },
  { origin: 'ai', text: 'AI 抽取·未经确认（可能有误）' },
  { origin: 'derived', text: '结构推导（同域/同会话自动）' },
];

export function NeighborhoodGraph({
  nb,
  onPickNode,
  maxDepth = 2,
}: {
  nb: KnowledgeNeighborhood;
  /** 点击任一节点 → 以它为中心重画（点当前中心无效） */
  onPickNode: (nodeId: string) => void;
  /** 与接口的 depth 参数同口径，仅用于提示文案 */
  maxDepth?: number;
}) {
  const layout = layoutNeighborhood(nb);
  const cx = GRAPH_VIEW.w / 2;
  const cy = GRAPH_VIEW.h / 2;

  return (
    <div className="gr-canvas">
      {nb.truncated && (
        <div className="gr-truncated" role="status">
          只显示了 {maxDepth} 跳内的关系，更远的关系没有画出来——点节点可以继续往里走
        </div>
      )}

      <svg
        className="gr-svg"
        viewBox={`0 0 ${GRAPH_VIEW.w} ${GRAPH_VIEW.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`知识关系图：以「${nb.center.refText}」为中心，共 ${layout.nodes.length} 个节点、${layout.edges.length} 条关系`}
      >
        <defs>
          {LEGEND.map(({ origin }) => (
            <marker
              key={origin}
              id={`gr-arrow-${origin}`}
              className={`gr-arrow ${origin}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          ))}
        </defs>

        {/* 环引导线：让「几跳」这件事看得见（否则用户不知道远近意味着什么） */}
        {layout.rings.map((r) => (
          <circle key={r} className="gr-ring" cx={cx} cy={cy} r={r} />
        ))}

        {/* 边先画（在节点下面），端点已缩到卡片外沿，箭头才露得出来 */}
        {layout.edges.map(({ edge, x1, y1, x2, y2, mx, my }) => (
          <g key={edge.id} className={edgeClass(edge.origin)}>
            <path d={`M ${x1} ${y1} L ${x2} ${y2}`} className="gr-edge-line" markerEnd={`url(#gr-arrow-${edge.origin})`} />
            <text className="gr-edge-text" x={mx} y={my - 5} textAnchor="middle">
              {edgeKindLabel(edge.kind)}
            </text>
          </g>
        ))}

        {layout.nodes.map((n) => {
          const isCenter = n.node.id === nb.center.id;
          return (
            <g
              key={n.node.id}
              className={`${nodeClass(n.node, isCenter)}${isCenter ? '' : ' clickable'}`}
              transform={`translate(${n.x},${n.y})`}
              onClick={() => {
                if (!isCenter) onPickNode(n.node.id);
              }}
              role={isCenter ? undefined : 'button'}
              tabIndex={isCenter ? undefined : 0}
              onKeyDown={(e) => {
                if (!isCenter && e.key === 'Enter') onPickNode(n.node.id);
              }}
            >
              <title>{`${nodeKindLabel(n.node.kind)}：${n.node.refText}`}</title>
              <rect x={-NODE_BOX.w / 2} y={-NODE_BOX.h / 2} width={NODE_BOX.w} height={NODE_BOX.h} rx={9} />
              <text className="gr-node-kind" x={0} y={-2} textAnchor="middle">
                {nodeKindLabel(n.node.kind)}
              </text>
              <text className="gr-node-name" x={0} y={14} textAnchor="middle">
                {clipLabel(n.node.refText, 8)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="gr-legend">
        {LEGEND.map(({ origin, text }) => (
          <span key={origin} className={`gr-legend-item ${origin}`}>
            <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
              <line className="gr-legend-line" x1="1" y1="4" x2="25" y2="4" />
            </svg>
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}
