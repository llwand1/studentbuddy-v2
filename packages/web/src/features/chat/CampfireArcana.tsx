/** Original coarse-grid ward and spell fragments. All motion stays behind the fixed architecture. */
export function CampfireArcana() {
  return <div className="cw-arcana" aria-hidden="true">
    <div className="cw-rift" />
    <svg viewBox="0 0 160 192" shapeRendering="crispEdges" focusable="false">
      <g className="cw-ward-outer">
        <path d="M64 12h32v8h24v16h16v24h8v48h-8v24h-16v16H96v8H64v-8H40v-16H24v-24h-8V60h8V36h16V20h24z" />
        <path className="cw-ward-echo" d="M80 4v16m0 128v16M8 84h20m104 0h20M24 28l16 16m80 80 16 16M24 140l16-16m80-80 16-16" />
      </g>
      <g className="cw-ward-inner">
        <path d="M64 32h32v8h16v16h8v56h-8v16H96v8H64v-8H48v-16h-8V56h8V40h16zM80 42l40 42-40 42-40-42z" />
        <path className="cw-ward-echo" d="M56 56h8v8h-8zm40 0h8v8h-8zM56 104h8v8h-8zm40 0h8v8h-8z" />
      </g>
      <g className="cw-ward-glyphs">
        <path d="M72 16h4v8h8v-8h4v12H72zM136 72h-8v8h8v4h-12V68h12zM72 144v-8h4v8h8v-8h4v12H72zM24 72h8v-4h4v16H24v-4h8v-4h-8z" />
        <path className="cw-ward-echo" d="M32 36h8v8h-8zm88 0h8v8h-8zM32 124h8v8h-8zm88 0h8v8h-8z" />
      </g>
      <path className="cw-ward-ground" d="M28 172h104v4H28zm16-8h72v4H44zm-8 20h88v4H36" />
    </svg>
    <div className="cw-spell-motes">{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
  </div>;
}
