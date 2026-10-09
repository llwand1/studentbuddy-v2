import { useRef, useState } from 'react';
import { useCampfireParallax } from './useCampfireParallax';
import './campfire-world.css';

/** The two gutters become a small interactive world, only while the chat is empty. */
export function CampfireWorld() {
  const ref = useRef<HTMLDivElement>(null);
  const [lamp, setLamp] = useState(false);
  const [gate, setGate] = useState(false);
  useCampfireParallax(ref);
  return <div ref={ref} className={`campfire-world${lamp ? ' is-lit' : ''}${gate ? ' is-awake' : ''}`}>
    <div className="cw-sky" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></div>
    <div className="cw-horizon" aria-hidden="true">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" focusable="false" shapeRendering="crispEdges">
        <path className="cw-far" d="M0 200V120h30v-20h30V72h25v-24h30v38h25v24h30v38h38v-28h35v-20h20v38h40v42h400v-20h30v-22h20v-36h30V72h25v-28h24v42h28v24h32v-12h28v36h27v66z" />
        <path className="cw-near" d="M0 200v-36h42v-18h28v20h52v14h90v-10h70v30h430v-30h60v-12h42v-24h30v36h56v-18h30v26h70v22z" />
      </svg>
    </div>
    <div className="cw-path" aria-hidden="true" />
    <button type="button" className="cw-waypoint cw-left" aria-label={lamp ? '熄灭营灯' : '点亮营灯'} aria-pressed={lamp} onClick={() => setLamp(!lamp)}>
      <svg className="cw-tower" viewBox="0 0 80 120" shapeRendering="crispEdges" focusable="false" aria-hidden="true">
        <path className="cw-stone-shadow" d="M8 116V100h8V50h4V38h4V26h4V14h4v6h8v-6h4v12h4v12h4v12h4v50h8v16z" />
        <path className="cw-stone" d="M24 100V40h4V28h20v12h4v60zM12 108h52v8H12z" />
        <path className="cw-masonry" d="M24 48h28v2H24zM24 64h28v2H24zM24 80h28v2H24zM32 50h2v14h-2zM44 66h2v14h-2zM30 82h2v16h-2z" />
        <path className="cw-window" d="M34 40h8v14h-8zM34 72h8v12h-8z" />
        <path className="cw-lamp-frame" d="M18 98V70h2v28zM18 70h16v2H18zM24 72h8v2h2v12H22V74h2z" />
        <path className="cw-lamp-light" d="M24 76h8v8h-8zM26 74h4v12h-4z" />
        <path className="cw-lamp-halo" d="M18 76h4v-6h12v6h6v10h-6v6H22v-6h-4z" />
        <path className="cw-vines" d="M48 58h4v4h4v12h-4V64h-4zM14 108v-8h4v4h4v4zM60 108v-6h4v-4h4v10z" />
        <g className="cw-fireflies"><path d="M10 70h2v2h-2zM42 66h2v2h-2zM16 88h2v2h-2z" /></g>
      </svg>
      <span className="cw-waypoint-name">{lamp ? '营灯已点亮' : '点亮营灯'}</span>
    </button>
    <button type="button" className="cw-waypoint cw-right" aria-label={gate ? '让遗迹休眠' : '唤醒遗迹'} aria-pressed={gate} onClick={() => setGate(!gate)}>
      <svg className="cw-gate" viewBox="0 0 80 120" shapeRendering="crispEdges" focusable="false" aria-hidden="true">
        <path className="cw-stone-shadow" d="M6 116v-14h8V40h6V28h8v-8h24v8h8v12h6v62h8v14z" />
        <path className="cw-stone" d="M18 100V42h8V32h28v10h8v58zM10 108h60v8H10z" />
        <path className="cw-void" d="M28 100V46h4V40h16v6h4v54z" />
        <path className="cw-gate-light" d="M30 98V48h4v-6h12v6h4v50h-4V54h-4v-8h-4v8h-4v44z" />
        <path className="cw-rune" d="M18 54h6v2h-6zM20 52h2v8h-2zM58 62h4v2h-4zM58 64h2v6h-2zM36 28h8v2h-8zM38 26h4v6h-4z" />
        <g className="cw-gate-dust"><path d="M38 70h2v2h-2zM44 90h2v2h-2zM36 54h2v2h-2zM42 82h2v2h-2z" /></g>
        <g className="cw-orbit"><path d="M16 46h8v2h-6v6h-2zM56 46h8v8h-2v-6h-6zM16 86h2v6h6v2h-8zM62 86h2v8h-8v-2h6z" /></g>
        <path className="cw-vines" d="M58 84h6v4h4v12h-4V90h-6zM8 106v-6h4v-6h4v12z" />
        <path className="cw-tome" d="M32 100h16v6H32zM34 96h12v4H34z" />
        <path className="cw-rune" d="M38 96h4v10h-4z" />
      </svg>
      <span className="cw-waypoint-name">{gate ? '遗迹已苏醒' : '唤醒遗迹'}</span>
    </button>
    <div className="cw-arrival" aria-hidden="true"><span /><span /><span /><span /></div>
  </div>;
}
