import { useEffect, useRef, useState } from 'react';
import { MascotArt } from '../chat/Mascot';
import { hasHost, HOST_DRAG, HOST_TAP, HOST_MOTION_START, HOST_MOTION_END, HOST_EFFECTS_ON, HOST_EFFECTS_OFF, onHostMessage, postToHost } from './float-view';
import { companionFrame, COMPANION_LABELS, HOST_SHAPE, type CompanionMood, type SpellSchool } from './companion-view';
import './companion.css';

function useAnimation() {
  const [frame, setFrame] = useState(0);
  const [animated, setAnimated] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setAnimated(!media?.matches);
    media?.addEventListener('change', change);
    const timer = window.setInterval(() => { if (!media?.matches && !document.hidden) setFrame(n => n + 1); }, 125);
    return () => { window.clearInterval(timer); media?.removeEventListener('change', change); };
  }, []);
  return { frame, animated };
}

export function CompanionArt({ mood, hovered = false, gaze = 0, native = false, spell }: { mood: CompanionMood; hovered?: boolean; gaze?: number; native?: boolean; spell?: SpellSchool }) {
  const { frame, animated } = useAnimation();
  const paint = companionFrame(mood, frame, animated, hovered, spell);
  const shape = JSON.stringify(paint.clips);
  useEffect(() => { if (native) postToHost(HOST_SHAPE + shape); }, [native, shape]);
  useEffect(() => {
    if (native) postToHost(animated ? HOST_EFFECTS_ON : HOST_EFFECTS_OFF);
    return () => { if (native) postToHost(HOST_EFFECTS_OFF); };
  }, [native, animated]);
  const expression = mood === 'celebrate' || mood === 'play' || hovered ? 'bright'
    : ['preparing', 'waiting', 'offline', 'retry'].includes(mood) ? 'thinking' : 'calm';
  return <svg className="sb-companion-art mascot-px" data-mood={mood} data-school={paint.school} viewBox="0 0 64 64" shapeRendering="crispEdges" aria-hidden="true">
    <g className="sb-companion-shadow">{paint.halo.map(([x, y, width, height], i) => <rect key={i} x={x} y={y} width={width} height={height} />)}</g>
    <g className="sb-companion-sigil">{paint.sigil.map(([x, y, width, height], i) => <rect key={i} x={x} y={y} width={width} height={height} />)}</g>
    <g className="sb-companion-particles">{paint.particles.map((p, i) => <g key={i} className={'sb-companion-' + p.tone}>
      {p.rects.map(([x, y, width, height], j) => <rect key={j} x={x} y={y} width={width} height={height} />)}
    </g>)}</g>
    <g transform={'translate(' + paint.x + ' ' + paint.y + ') scale(2)'}><MascotArt expression={expression} gaze={gaze} /></g>
    {(mood === 'reading' || mood === 'selecting' || mood === 'retrieving') && <g className="sb-companion-book">
      <rect x={27} y={41 + paint.y - 16} width={4} height={1} /><rect x={33} y={41 + paint.y - 16} width={4} height={1} />
      <rect x={31} y={42 + paint.y - 16} width={2} height={1} />
    </g>}
  </svg>;
}

export function FloatCompanion({ mood, onOpen, onSettings }: { mood: CompanionMood; onOpen: () => void; onSettings: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [gaze, setGaze] = useState(0);
  const [playUntil, setPlayUntil] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [spell, setSpell] = useState<SpellSchool>('hex');
  const castCounter = useRef(0);
  const playing = playUntil > 0;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setPlayUntil(0), Math.max(0, playUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [playing, playUntil]);
  useEffect(() => onHostMessage(message => {
    if (message === HOST_TAP) onOpen();
    else if (message === HOST_MOTION_START) setDragging(true);
    else if (message === HOST_MOTION_END) { setDragging(false); setSpell('soul'); setPlayUntil(Date.now() + 2200); }
  }), [onOpen]);
  const play = () => { setSpell((['hex', 'rift', 'ember', 'soul'] as const)[castCounter.current++ % 4] ?? 'hex'); setPlayUntil(Date.now() + 2200); };
  const visibleMood = dragging ? 'dragging' : playing ? 'play' : mood;
  return <button type="button" className="sb-ball" data-mood={visibleMood}
    title={COMPANION_LABELS[mood] + ' · 点击打开 · 拖动换位置 · 滚轮 / Shift 点击施法 · 右键设置'}
    aria-label={'打开 StudentBuddy · ' + COMPANION_LABELS[mood]}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => { setHovered(false); setGaze(0); }}
    onPointerMove={e => { const bounds = e.currentTarget.getBoundingClientRect(); setGaze(e.clientX < bounds.left + bounds.width / 2 ? -0.5 : 0.5); }}
    onWheel={play}
    onContextMenu={e => { e.preventDefault(); onSettings(); }}
    onPointerDown={e => { if (e.button === 0 && !e.shiftKey) postToHost(HOST_DRAG); }}
    onClick={e => { if (e.shiftKey) play(); else if (!hasHost() || e.detail === 0) onOpen(); }}>
    <CompanionArt mood={visibleMood} hovered={hovered} gaze={gaze} spell={spell} native />
  </button>;
}

