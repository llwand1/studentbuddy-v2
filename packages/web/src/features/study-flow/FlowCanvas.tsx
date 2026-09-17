/**
 * FlowCanvas — 学习流的**编排画布**（契约 docs/STUDY-FLOW-SPEC.md §2）。
 *
 * 这里就是老板说的「控制流可视化 CRUD」：每个「点」是一个学习交互体验（节点），
 * 连线决定下一步跑哪个（含 `correct`/`wrong` 两条分支），拖动即改 `position`（落库，不是纯前端状态）。
 *
 * ★ 四处刻意的交互决定：
 *  ① **坐标吸附网格**：不吸附的话每次拖动都产生新坐标，库里会积一堆 187.34 这种碎值，
 *     且同一张图每次打开都长得略不一样；
 *  ② **拖动过程不落库、松手才落**：拖动中每个 pointermove 都发请求会打满后端，也没必要
 *     （用户还没定下来）；
 *  ③ **未接执行器的类型在画布上就标出来**：等跑到一半才失败是最差时点（契约 §7）。
 *     这里只是**标注**，真正的禁用由 StepPanel 的类型下拉负责——两者都不静默。
 *  ④ **空白处拖动 = 平移画布**（缩放的配套动作，见下方 ★缩放）：放大之后没地方「挪」＝放大没用。
 *
 * ★ 缩放/平移的几何与状态在 `flow-viewport.ts` + `use-flow-viewport.ts`：
 *   原来 `viewBox` 直接吃 `contentBounds`，等于「永远把内容整体塞进容器」——内容一宽就自动缩，
 *   10px 的字缩到 6px 就没法读，且用户**没有任何手段拉回来**。
 *   现在视口是受控的：默认 100%，滚轮/按钮缩放，空白拖动平移，「适配窗口」才是原来的整体塞满。
 *
 * ★ 画布**不自己改数据**：所有变更都通过 `onMove` / `onSelect` 交给页面层，
 *   页面层统一「改本地 → 落库」，避免一处改本地一处改库两套真相。
 */
import { useRef, useState } from 'react';
import { findFlowStepMeta, type FlowEdgeDef, type FlowStepDef, type FlowPort } from '@sb/shared';
import { STEP_BOX, contentBounds, edgePath, inputAnchor, portAnchor, portLabel, snapGrid, type Point } from './flow-layout';
import { displayStepLabel, stepParamsSummary } from './flow-form';
import { useFlowViewport } from './use-flow-viewport';
import { ZoomBar } from './ZoomBar';

/** 卡片上摘要那一行的最大字数（超出截断，卡片不是详情面板） */
const SUMMARY_MAX = 14;

export function FlowCanvas({
  steps,
  edges,
  selectedId,
  wiredKinds,
  onSelect,
  onMove,
}: {
  steps: FlowStepDef[];
  edges: FlowEdgeDef[];
  selectedId: string | null;
  /** 已接执行器的步骤类型（未接的在画布上标出来） */
  wiredKinds: Set<string>;
  onSelect: (id: string | null) => void;
  /** 拖动结束（已吸附）：页面层负责落库 */
  onMove: (id: string, pos: Point) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  /** 拖动中的临时位置（松手才提交，见文件头 ②） */
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null);
  /**
   * 这一次指针交互是否「点在了节点上」或「拖动过」——决定松手后随之而来的 `click` 要不要吞掉。
   * ★ 必须吞：`setPointerCapture` 会把 click **重定向到 svg**（指针捕获期间兼容鼠标事件以捕获元素为目标），
   *   于是「点节点」也会命中 svg 的「点空白取消选中」——不吞的话节点刚选中就立刻被取消，面板永远打不开。
   */
  const swallowClickRef = useRef(false);

  const centerOf = (s: FlowStepDef): Point =>
    ghost && ghost.id === s.id ? { x: ghost.x, y: ghost.y } : s.position;

  const bounds = contentBounds(steps.map((s) => s.position));
  const canvas = useFlowViewport(svgRef, bounds, steps[0]?.defId);

  /** 客户端坐标 → SVG 用户坐标（viewBox 会缩放，必须走 CTM 换算，不能拿 offsetX 凑） */
  const toSvg = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const onPointerDown = (e: React.PointerEvent<SVGGElement>, step: FlowStepDef) => {
    e.stopPropagation();
    const p = toSvg(e.clientX, e.clientY);
    if (!p) return;
    const c = step.position;
    dragRef.current = { id: step.id, dx: c.x - p.x, dy: c.y - p.y };
    setGhost({ id: step.id, x: c.x, y: c.y });
    onSelect(step.id);
    swallowClickRef.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 空白处按下 = 起手平移（左键/中键）。空白单击仍然只做「取消选中」——靠 swallowClickRef 区分 */
  const onCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    swallowClickRef.current = false;
    if (e.button !== 0 && e.button !== 1) return;
    canvas.startPan(e);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (d) {
      const p = toSvg(e.clientX, e.clientY);
      if (!p) return;
      swallowClickRef.current = true;
      setGhost({ id: d.id, x: snapGrid(p.x + d.dx), y: snapGrid(p.y + d.dy) });
      return;
    }
    if (canvas.movePan(e)) swallowClickRef.current = true;
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    const g = ghost;
    dragRef.current = null;
    canvas.endPan();
    // 只有真的动了才提交（点一下选中不该产生一次写库）
    if (d && g && g.id === d.id) {
      const step = steps.find((s) => s.id === d.id);
      if (step && (step.position.x !== g.x || step.position.y !== g.y)) {
        onMove(d.id, { x: g.x, y: g.y });
      }
    }
    setGhost(null);
  };

  /** 点空白 = 取消选中；但「点节点」与「拖动过」的 click 要吞掉（见 swallowClickRef） */
  const onCanvasClick = () => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false;
      return;
    }
    onSelect(null);
  };

  return (
    <div className={`fl-canvas${canvas.panning ? ' panning' : ''}`}>
      <svg
        ref={svgRef}
        className="fl-svg"
        viewBox={canvas.viewBox}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={onCanvasClick}
        role="application"
        aria-label={`学习流画布：${steps.length} 个步骤、${edges.length} 条连线，当前缩放 ${canvas.percent}%`}
      >
        <defs>
          <marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="fl-arrow-path" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>

        {/* 连线先画（压在节点下面） */}
        {edges.map((e) => {
          const from = steps.find((s) => s.id === e.fromStepId);
          const to = steps.find((s) => s.id === e.toStepId);
          if (!from || !to) return null;
          const a = portAnchor(centerOf(from), e.fromPort);
          const b = inputAnchor(centerOf(to));
          const d = edgePath(a, b);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return (
            <g key={e.id} className={`fl-edge ${e.fromPort}`}>
              <path d={d} className="fl-edge-line" markerEnd="url(#fl-arrow)" />
              {e.fromPort !== 'next' && (
                <text className="fl-edge-text" x={mid.x} y={mid.y - 6} textAnchor="middle">
                  {e.label || portLabel(e.fromPort)}
                </text>
              )}
            </g>
          );
        })}

        {/* 步骤卡片 */}
        {steps.map((s) => {
          const c = centerOf(s);
          const meta = findFlowStepMeta(s.kind);
          const name = displayStepLabel(s.label, s.kind, meta?.label);
          const summary = meta ? stepParamsSummary(meta, s.params) : '';
          const notWired = !wiredKinds.has(s.kind);
          return (
            <g
              key={s.id}
              className={`fl-node${s.id === selectedId ? ' on' : ''}${notWired ? ' unwired' : ''}${ghost?.id === s.id ? ' dragging' : ''}`}
              transform={`translate(${c.x},${c.y})`}
              onPointerDown={(e) => onPointerDown(e, s)}
            >
              <rect className="fl-node-box" x={-STEP_BOX.w / 2} y={-STEP_BOX.h / 2} width={STEP_BOX.w} height={STEP_BOX.h} rx={12} />
              <text className="fl-node-kind" x={-STEP_BOX.w / 2 + 10} y={-STEP_BOX.h / 2 + 16}>
                {meta?.label ?? s.kind}
                {notWired ? ' · 未接' : ''}
              </text>
              <text className="fl-node-name" x={0} y={4} textAnchor="middle">
                {name.length > 10 ? `${name.slice(0, 10)}…` : name}
              </text>
              <text className="fl-node-summary" x={0} y={20} textAnchor="middle">
                {summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary}
              </text>
              {/* 出口端口：三档位置由 portAnchor 给出，与连线端点同源 */}
              {(['next', 'correct', 'wrong'] as FlowPort[]).map((p) => {
                const a = portAnchor({ x: 0, y: 0 }, p);
                const used = edges.some((e) => e.fromStepId === s.id && e.fromPort === p);
                return <circle key={p} className={`fl-port ${p}${used ? ' used' : ''}`} cx={a.x} cy={a.y} r={3.5} />;
              })}
            </g>
          );
        })}
      </svg>

      {steps.length === 0 && (
        <div className="fl-canvas-empty">
          <p>这条流还没有步骤</p>
          <p className="fl-canvas-empty-sub">在右侧点「加一个步骤」，每一步都是一个学习交互体验</p>
        </div>
      )}

      <ZoomBar
        percent={canvas.percent}
        onZoomIn={canvas.zoomIn}
        onZoomOut={canvas.zoomOut}
        onReset={canvas.resetZoom}
        onFit={canvas.fitToContent}
      />
    </div>
  );
}
