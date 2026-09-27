import { Mascot } from './Mascot';

/**
 * 欢迎页装饰场景（144 × 48，3 倍渲染）：2026-09-28 换成「夜晚篝火营地」——血月、星屑、
 * 插在地上的剑、石上的词典、跳动的篝火与团子法师。纯装饰：无计时器、无网络、无玩法状态；
 * 火焰逐帧只用 steps()，减少动态效果时静止。
 */
export function PixelScene() {
  return (
    <div className="pixel-scene" aria-hidden="true">
      <svg className="pixel-scene-art" viewBox="0 0 144 48" shapeRendering="crispEdges" focusable="false">
        <g className="scene-stars">
          <path d="M6 4h1v1H6zM20 10h1v1h-1zM34 3h1v1h-1zM58 8h1v1h-1zM84 4h1v1h-1zM100 12h1v1h-1zM128 6h1v1h-1zM140 14h1v1h-1z" />
        </g>
        <g className="pixel-spark pixel-spark-one"><path className="scene-gold" d="M44 8h1v2h2v1h-2v2h-1v-2h-2v-1h2z" /></g>
        <g className="scene-moon">
          <path className="scene-moon-halo" d="M114 2h12v2h2v2h2v10h-2v2h-2v2h-12v-2h-2v-2h-2V6h2V4h2z" />
          <path className="scene-moon-face" d="M116 4h8v2h2v8h-2v2h-8v-2h-2V6h2z" />
          <path className="scene-moon-crater" d="M118 7h2v2h-2zM121 11h2v2h-2z" />
        </g>
        <path className="scene-tent" d="M92 38l10-14h2l10 14z" />
        <path className="scene-tent-door" d="M101 38l2-6 2 6z" />
        <path className="scene-ground" d="M14 38h116v2h6v2h-6v2H14v-2H8v-2h6z" />
        <path className="scene-grass" d="M14 38h116v1H14zM30 42h4v1h-4zM108 42h6v1h-6z" />
        <g className="pixel-sword">
          <path className="scene-steel" d="M36 20h2v16h-2z" />
          <path className="scene-steel-lite" d="M36 20h1v16h-1z" />
          <path className="scene-gold" d="M33 30h8v2h-8z" />
          <path className="scene-outline" d="M36 32h2v5h-2z" />
        </g>
        <g className="pixel-books">
          <path className="scene-outline" d="M22 34h12v4H22z" />
          <path className="scene-tome" d="M23 31h10v3H23z" />
          <path className="scene-gold" d="M27 31h2v3h-2z" />
        </g>
        <g className="pixel-fire">
          <path className="scene-log" d="M76 36h14v2H76zM78 34h10v2H78z" />
          <path className="scene-fire-out fire-a" d="M79 26h2v-2h2v-2h2v4h2v4h2v4H77v-6h2z" />
          <path className="scene-fire-mid fire-a" d="M80 28h2v-2h2v2h2v2h2v4h-8z" />
          <path className="scene-fire-core fire-a" d="M82 30h2v4h-2z" />
          <path className="scene-fire-out fire-b" d="M78 28h2v-4h2v2h2v-4h2v4h2v2h2v6H78z" />
          <path className="scene-fire-mid fire-b" d="M80 30h2v-2h2v-2h2v4h2v4h-8z" />
          <path className="scene-fire-core fire-b" d="M83 30h2v4h-2z" />
          <path className="scene-ember" d="M86 18h1v1h-1zM80 14h1v1h-1zM84 10h1v1h-1z" />
        </g>
      </svg>
      <Mascot />
    </div>
  );
}
