/**
 * GraphDemo — 落地页「知识图」的**过程式演示**（hero 演示窗的第二个场景）。
 *
 * ★ 讲的是哪件事（老板 2026-09-20 拍定的核心动线）：
 *   对一个词条点「向 AI 追问」→ 开一条独立会话 → 那条回复里抽出的每个词条
 *   **自动连回源词条** ⇒ 一次追问长出一个**星型**；孩子还能再追问 ⇒ 星长成树。
 *   全程不需要用户手工拖线，但每条 AI 连的边都标着"未经确认"。
 *
 * ★ 几何与类名**全部复用知识图页**（`graph-visual.ts` 的 `layoutNeighborhood` /
 *   `edgeClass` / `nodeClass`），本组件不算坐标、不写颜色、**也不写字面文案**：
 *   配色归 `graph.css`、几何归 `graph-visual.ts`、中英两侧的上屏文案归 `graph-demo.ts`，
 *   这里只负责"第几帧露出多少"。
 *
 * ★ 显现动画走 **CSS transition**（同 `TermFlowDemo`：动画一律 CSS，不引库）。
 *   两个坑写在代码里而不是踩过才想起：
 *   ① 节点在 SVG 里靠 `transform="translate(x,y)"` **属性**定位，而 CSS `transform`
 *      **优先级高于属性** ⇒ 想给节点加"弹出缩放"就必须**套两层 `<g>`**：
 *      外层管定位（属性）、内层管动效（CSS）。写在一层上会把节点全部弹回原点。
 *   ② 未显现的节点**仍然渲染**（只把 opacity 置 0），不靠条件渲染卸载——
 *      卸载会让 transition 失去起点，节点变成"啪"地出现，失去生长的观感。
 */
import type { KnowledgeNodeKind } from '@sb/shared';
import { clipLabel, edgeClass, nodeClass } from '../../features/study-flow/graph-visual';
import { useLandingLang } from '../landing-lang';
import {
  CLIP_MAX,
  DEMO_ASK,
  FRAME,
  GRAPH_DEMO_LAYOUT,
  GRAPH_DEMO_NEIGHBORHOOD,
  GRAPH_DEMO_OPTS,
  GRAPH_DEMO_VIEW,
  GRAPH_LEGEND,
  edgeOriginAt,
  edgeVisibleAt,
  graphAriaLabel,
  nodeKindText,
  nodeText,
  nodeTitle,
  nodeVisibleAt,
  termLabelAt,
  termsAt,
} from './graph-demo';
// ★ 演示复用知识图页的类名（`.gr-node` / `.gr-edge` / `.gr-ring` / `.gr-legend-item`），
//   故必须把那份样式表也引进来——否则类名对得上、样式却全是空的（节点没有卡片外框、
//   边没有线型分档），图会退化成一堆无样式文字。`graph.css` 是全局的，引一次即可。
import '../../features/study-flow/graph.css';

export function GraphDemo({ stage }: { stage: number }) {
  const { lang } = useLandingLang();
  const { nodes, edges, rings } = GRAPH_DEMO_LAYOUT;
  const cx = GRAPH_DEMO_VIEW.w / 2;
  const cy = GRAPH_DEMO_VIEW.h / 2;
  const box = GRAPH_DEMO_OPTS.box;
  const centerId = GRAPH_DEMO_NEIGHBORHOOD.center.id;

  /** 帧 2~3 显示"回复抽出了哪些词条"；帧 4 换成图例（同一位置切换，不叠着挤） */
  const showTerms = stage >= FRAME.star && stage < FRAME.origin;
  const showLegend = stage >= FRAME.origin;
  const termList = termsAt(stage, lang);
  const termLabel = termLabelAt(stage, lang);

  const kindText = (kind: KnowledgeNodeKind) => nodeKindText(kind, lang);

  return (
    <div className="ld-layer ld-g">
      <svg
        className="ld-g-svg"
        viewBox={`0 0 ${GRAPH_DEMO_VIEW.w} ${GRAPH_DEMO_VIEW.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={graphAriaLabel(lang)}
      >
        <defs>
          {GRAPH_LEGEND.map(({ origin }) => (
            <marker
              key={origin}
              id={`ld-g-arrow-${origin}`}
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

        {/* 环引导线：让「几跳」看得见（与真图同一套，只是半径小一号） */}
        {rings.map((r) => (
          <circle key={r} className="gr-ring" cx={cx} cy={cy} r={r} />
        ))}

        {/* 边先画（压在节点下面）；端点已由布局缩到卡片外沿，箭头才露得出来 */}
        {edges.map(({ edge, x1, y1, x2, y2 }) => {
          const on = edgeVisibleAt(edge, stage);
          // ★ origin 逐帧取：帧 4 会把那条 ai 边转成 user ⇒ 类名一变，
          //   graph.css 的线型/颜色与 CSS transition 一起把它从虚线"收拢"成实线。
          const origin = edgeOriginAt(edge, stage);
          return (
            <g key={edge.id} className={`${edgeClass(origin)} ld-g-e${on ? ' on' : ''}`}>
              {/* ★ 刻意**不画**边上的类型标签（真图有 `.gr-edge-text`）：本演示 6 条边全是
                  `relates`，"相关"重复六遍零信息量；而标签得放在边中点，中点正落在中心卡片与
                  邻居之间那道 20px 的缝里 ⇒ 白底描边的字压在白卡片上，**半个字被切掉**
                  （真机目检发现）。"这是什么关系、可不可信"交给末帧图例与解说词，不靠挤在缝里的小字。 */}
              <path className="gr-edge-line" d={`M ${x1} ${y1} L ${x2} ${y2}`} markerEnd={`url(#ld-g-arrow-${origin})`} />
            </g>
          );
        })}

        {nodes.map((n) => {
          const on = nodeVisibleAt(n.node, stage);
          const isCenter = n.node.id === centerId;
          const name = nodeText(n.node.id, lang);
          return (
            <g key={n.node.id} transform={`translate(${n.x},${n.y})`}>
              {/* 内层：只承担 CSS 动效（弹出缩放）。★ 定位必须留在外层属性 transform 上 */}
              <g className={`${nodeClass(n.node, isCenter)} ld-g-n${on ? ' on' : ''}`}>
                <title>{nodeTitle(n.node.id, n.node.kind, lang)}</title>
                <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} rx={9} />
                <text className="gr-node-kind" x={0} y={-3} textAnchor="middle">
                  {kindText(n.node.kind)}
                </text>
                <text className="gr-node-name" x={0} y={13} textAnchor="middle">
                  {clipLabel(name, CLIP_MAX[lang])}
                </text>
              </g>
            </g>
          );
        })}

        {/* 帧 1：贴在中心卡片正下方的「向 AI 追问」按钮（与真机词条卡上是同一个动作）。
            ★ 同样双层：外层属性 transform 定位，内层 CSS 做缩放（同节点卡片那个坑） */}
        <g transform={`translate(${cx},${cy + box.h / 2 + 22})`}>
          <g className={stage === FRAME.ask ? 'ld-g-ask on' : 'ld-g-ask'}>
            <rect x={-52} y={-12} width={104} height={24} rx={12} />
            <text x={0} y={4} textAnchor="middle">
              {DEMO_ASK.button[lang]}
            </text>
          </g>
        </g>
      </svg>

      <div className="ld-g-bar">
        <div className={showTerms ? 'ld-g-terms on' : 'ld-g-terms'} aria-hidden={!showTerms}>
          <span className="ld-g-terms-label">{termLabel}</span>
          {termList.map((t) => (
            <span key={t} className="ld-g-term">
              {t}
            </span>
          ))}
        </div>
        <div className={showLegend ? 'ld-g-legend on' : 'ld-g-legend'} aria-hidden={!showLegend}>
          {GRAPH_LEGEND.map(({ origin, text }) => (
            <span key={origin} className={`gr-legend-item ${origin}`}>
              <svg width="24" height="8" viewBox="0 0 24 8" aria-hidden="true">
                <line className="gr-legend-line" x1="1" y1="4" x2="23" y2="4" />
              </svg>
              {text[lang]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
