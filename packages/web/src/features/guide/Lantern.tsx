/**
 * Lantern — 引路灯图标：16×16 像素提灯（点阵见 `lantern-sprite.ts`）。
 * 只在 2× 整数倍（32px）下放大，配 shape-rendering=crispEdges 才不会糊成灰边；颜色与动画全在 `guide.css`。
 * 三个状态只换外层类名：静（火苗轻闪）/ 亮（整灯晃 + 光晕 + 小点）/ 开（边框换主色）——组件本身不懂「为什么亮」。
 */
import { toRuns, type Pixel } from '../chat/Mascot';
import { BODY, FLAME_A, FLAME_B, LEGEND } from './lantern-sprite';

export type LanternState = 'idle' | 'lit' | 'open';

const BODY_RUNS = toRuns(BODY);
const FLAME_A_RUNS = toRuns(FLAME_A);
const FLAME_B_RUNS = toRuns(FLAME_B);

function Pixels({ runs }: { runs: Pixel[] }) {
  return (
    <>
      {runs.map((p) => (
        <rect key={`${p.x}-${p.y}-${p.k}`} x={p.x} y={p.y} width={p.w} height={1} className={LEGEND[p.k]} />
      ))}
    </>
  );
}

export function Lantern({ state = 'idle' }: { state?: LanternState }) {
  return (
    <span className={`lantern lantern--${state}`} aria-hidden="true">
      <svg className="lantern-px" viewBox="0 0 16 16" shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
        <Pixels runs={BODY_RUNS} />
        <g className="lantern-flame-a">
          <Pixels runs={FLAME_A_RUNS} />
        </g>
        <g className="lantern-flame-b">
          <Pixels runs={FLAME_B_RUNS} />
        </g>
      </svg>
    </span>
  );
}
