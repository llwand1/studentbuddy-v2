/**
 * world/ChapterContinent — 冒险录第一章「知识大陆如何生长」：俯视大陆 ⇄ 横版讨伐 的可交互演示。
 *
 * ★ 两种镜头：平时是饥荒式俯视平面（`continent-engine`，词条＝地砖、越学越大）；
 *   发起讨伐 → 像素溶解转场 + 遭遇战标题卡 → 横版战斗（直接复用首屏的 `LandingHero` 遭遇战模式）→
 *   胜利后再溶解回大陆，被占地块重新亮起。
 * ★ 进入视口时自动铺几块地、放出一只怪，让访客不点也能看懂；之后全交给访客。
 * ★ 减少动态效果：转场瞬切、不自动播放；jsdom / 无 2D 上下文时只渲染 DOM 层。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { LandingHero } from '../hero/LandingHero';
import { ContinentEngine } from './continent-engine';
import type { ContinentSnap } from './continent-engine';
import { CH_CONTINENT as C, DEMO_TERMS, DOMAIN_NAME } from './world-copy';
import { Chapter } from './Chapter';

type Cover = 'none' | 'close' | 'hold' | 'open';
type Pop = { id: number; text: string; kind: string; x: number; y: number };
const CELLS = Array.from({ length: 12 * 7 }, (_, i) => {
  const x = i % 12;
  const y = Math.floor(i / 12);
  return Math.round(Math.hypot(x - 5.5, (y - 3) * 1.6) * 45);
});

export function ChapterContinent() {
  const { lang } = useLandingLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const eng = useRef<ContinentEngine | null>(null);
  const [snap, setSnap] = useState<ContinentSnap>({ tiles: 0, radius: 0, occupied: 0, monster: false, walking: false });
  const [scene, setScene] = useState<'map' | 'battle'>('map');
  const [cover, setCover] = useState<Cover>('none');
  const [pops, setPops] = useState<Pop[]>([]);
  const [calm] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const langRef = useRef(lang);
  langRef.current = lang;
  const pid = useRef(0);

  const cut = useCallback((to: 'map' | 'battle', mid?: () => void) => {
    if (calm) { setScene(to); mid?.(); return; }
    setCover('close');
    window.setTimeout(() => { setCover('hold'); setScene(to); mid?.(); }, 650);
    window.setTimeout(() => setCover('open'), to === 'battle' ? 1500 : 1000);
    window.setTimeout(() => setCover('none'), to === 'battle' ? 2150 : 1650);
  }, [calm]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box || /jsdom/i.test(navigator.userAgent)) return;
    let e: ContinentEngine;
    try {
      e = new ContinentEngine(canvas, {
        snap: setSnap,
        pop: (kind, idx, x, y) => {
          const L = langRef.current;
          const text = kind === 'term' ? `+ ${DEMO_TERMS[idx]!.name[L]}` : kind === 'reclaim' ? C.reclaimed[L] : C.foeName[L];
          const id = ++pid.current;
          setPops((p) => [...p.slice(-3), { id, text, kind, x, y }]);
          window.setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 1400);
        },
        encounter: () => cut('battle'),
      }, calm);
    } catch {
      return;
    }
    eng.current = e;
    let timers: number[] = [];
    let played = false;
    let running = false;
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([en]) => {
          if (en?.isIntersecting && !running) { e.start(); running = true; }
          if (!en?.isIntersecting && running) { e.stop(); running = false; }
          if (en?.isIntersecting && !played) {
            played = true;
            const n = 9;
            for (let i = 0; i < n; i++) timers.push(window.setTimeout(() => e.learn(), calm ? 0 : 300 + i * 380));
            timers.push(window.setTimeout(() => { e.decay(); e.decay(); }, calm ? 0 : 300 + n * 380 + 500));
          }
        }, { threshold: 0.35 })
      : null;
    if (io) io.observe(box);
    else { e.start(); running = true; }
    return () => { io?.disconnect(); timers.forEach((t) => window.clearTimeout(t)); timers = []; e.stop(); eng.current = null; };
  }, [calm, cut]);

  const onWin = useCallback(() => cut('map', () => window.setTimeout(() => eng.current?.cleanse(), 300)), [cut]);
  const busy = cover !== 'none' || snap.walking;

  return (
    <Chapter id="continent" title={C.title[lang]} accent={C.accent[lang]} lead={C.lead[lang]}>
      <ol className="cw-rules">
        {C.rules.map((r, i) => (
          <li key={r.k.en}>
            <span className="cw-rule-no">{String(i + 1).padStart(2, '0')}</span>
            <strong>{r.k[lang]}</strong>
            <p>{r.v[lang]}</p>
          </li>
        ))}
      </ol>
      <div className="wf-frame cw-frame" ref={boxRef} role="group" aria-label={C.aria[lang]}>
        <div className="cw-bar">
          <span className={scene === 'map' ? 'cw-view cw-view-on' : 'cw-view'}>{C.viewMap[lang]}</span>
          <span className="cw-arrow" aria-hidden="true">⇄</span>
          <span className={scene === 'battle' ? 'cw-view cw-view-on' : 'cw-view'}>{C.viewBattle[lang]}</span>
          <span className="cw-stats">
            {C.statTerms[lang]} <b>{snap.tiles}</b> · {C.statRadius[lang]} <b>{snap.radius}</b> · {C.statFoe[lang]} <b className="cw-bad">{snap.occupied}</b>
          </span>
        </div>
        <div className="cw-screen">
          <canvas
            ref={canvasRef}
            className={scene === 'map' ? 'cw-canvas' : 'cw-canvas cw-hidden'}
            aria-hidden="true"
            onClick={(ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              eng.current?.click((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
            }}
          />
          <div className="cw-tilt" aria-hidden="true" />
          {scene === 'map' && pops.map((p) => (
            // gates:style-ok — 飘字落点来自画布坐标
            <span key={p.id} className={`cw-pop cw-pop-${p.kind}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>{p.text}</span>
          ))}
          {scene === 'battle' && <div className="cw-battle"><LandingHero encounter={{ wave: 0, onDone: onWin }} /></div>}
          {cover !== 'none' && (
            <div className={`cw-cover cw-cover-${cover}`} aria-hidden="true">
              {CELLS.map((d, i) => (
                // gates:style-ok — 像素溶解：每格延迟按离中心距离派生
                <i key={i} style={{ ['--d' as string]: `${d}ms` }} />
              ))}
              {cover === 'hold' && (
                <div className="cw-title">
                  <small>{scene === 'battle' ? C.encounter[lang] : C.viewMap[lang]}</small>
                  <strong>{scene === 'battle' ? C.foeName[lang] : C.reclaimed[lang]}</strong>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="cw-controls">
          <button type="button" className="wf-btn" disabled={busy || scene !== 'map' || snap.tiles >= 81} onClick={() => eng.current?.learn()}>{C.learn[lang]}</button>
          <button type="button" className="wf-btn" disabled={busy || scene !== 'map' || snap.tiles < 5} onClick={() => eng.current?.decay()}>{C.decay[lang]}</button>
          <button type="button" className="wf-btn wf-btn-blood" disabled={busy || scene !== 'map' || !snap.monster} onClick={() => eng.current?.hunt()}>{C.hunt[lang]}</button>
          <span className="cw-hint">{C.hint[lang]}</span>
        </div>
        <div className="cw-legend">
          {(Object.keys(DOMAIN_NAME) as Array<keyof typeof DOMAIN_NAME>).map((d) => (
            <span key={d}><i className={`cw-sw cw-sw-${d}`} />{DOMAIN_NAME[d][lang]}</span>
          ))}
        </div>
      </div>
      <p className="wf-note">{C.note[lang]}</p>
    </Chapter>
  );
}
