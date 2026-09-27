import { Mascot } from './Mascot';

/** Decorative 144 × 48 scene, rendered at 3×. No timer, network request or gameplay state. */
export function PixelScene() {
  return (
    <div className="pixel-scene" aria-hidden="true">
      <svg className="pixel-scene-art" viewBox="0 0 144 48" shapeRendering="crispEdges" focusable="false">
        <g className="pixel-cloud pixel-cloud-left">
          <path className="scene-cloud-shade" d="M8 16h28v2H8z" />
          <path className="scene-cloud" d="M8 12h4V8h4V6h8v2h4v4h8v4H8z" />
        </g>
        <g className="pixel-cloud pixel-cloud-right">
          <path className="scene-cloud-shade" d="M106 12h26v2h-26z" />
          <path className="scene-cloud" d="M106 8h6V4h10v2h4v2h6v4h-26z" />
        </g>
        <g className="pixel-spark pixel-spark-one"><path className="scene-gold" d="M44 8h2v4h4v2h-4v4h-2v-4h-4v-2h4z" /></g>
        <g className="pixel-spark pixel-spark-two"><path className="scene-purple" d="M96 22h2v2h2v2h-2v2h-2v-2h-2v-2h2z" /></g>
        <path className="scene-ground" d="M22 38h100v2h6v2h-6v2H22v-2h-6v-2h6z" />
        <path className="scene-grass" d="M22 38h100v2H22zM30 42h4v2h-4zM108 42h6v2h-6z" />
        <g className="pixel-books">
          <path className="scene-outline" d="M26 28h20v4h2v6H24v-6h2z" />
          <path className="scene-purple" d="M28 30h16v2H28z" />
          <path className="scene-paper" d="M28 32h16v2H28zM28 36h16v1H28z" />
          <path className="scene-gold" d="M26 34h18v2H26z" />
        </g>
        <g className="pixel-flower">
          <path className="scene-leaf" d="M110 28h2v10h-2zM106 30h4v2h-4zM112 32h4v2h-4z" />
          <path className="scene-purple" d="M108 22h6v2h2v4h-2v2h-6v-2h-2v-4h2z" />
          <path className="scene-gold" d="M110 24h2v4h-2z" />
        </g>
        <path className="scene-grass" d="M50 34h2v4h-2zM52 36h2v2h-2zM92 34h2v4h-2zM90 36h2v2h-2z" />
      </svg>
      <Mascot />
    </div>
  );
}
