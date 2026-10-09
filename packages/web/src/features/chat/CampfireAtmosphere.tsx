/** Pixel architecture stays grounded; light, fog and runes carry the motion. */
export function CampfireAtmosphere() {
  return <div className="cw-atmosphere" aria-hidden="true">
    {['left', 'right'].map(side => <div key={side} className={`cw-wing cw-wing-${side}`}>
      <svg className="cw-wall" viewBox="0 0 160 400" preserveAspectRatio="none" shapeRendering="crispEdges" focusable="false">
        <path d="M0 400V52h8V36h8v16h12V24h8V8h8v16h12v42h16V48h8v-8h8v24h12V32h8V16h8v16h12v48h12V64h12v336z" />
        <path className="cw-wall-inset" d="M20 118h8v-12h8V94h8v12h8v12h8v108H20zm80 12h8v-12h8v12h8v96h-24zM8 270h144v4H8zm0 48h144v4H8zm0 48h144v4H8z" />
        <path className="cw-wall-crack" d="M70 78h8v50h-6v22h8v32h-6v32h-4zM134 184h6v20h-6v24h-6v24h6v30h-6v12h-6v-42h6v-26h6z" />
      </svg>
      <div className="cw-shaft" /><div className="cw-ground" /><div className="cw-ground-seal" /><div className="cw-mist" />
      <div className="cw-embers">{Array.from({length:18}, (_, i) => <i key={i} />)}</div>
    </div>)}
  </div>;
}
