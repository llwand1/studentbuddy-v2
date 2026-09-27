/**
 * app/hero/LandingHero — 落地页首屏：可交互的暗黑像素序章「词条即力量」（2026-09-28）。
 *
 * ★ 叙事：你是把知识词条化为力量的勇者。序章字幕（电影黑边 + 打字）→ 怪物登场 →
 *   访客读谜题、打出词条卡（点击或按 1–4）→ 选对暴击、选错被反击 → 三战后收复领地，引向注册 CTA。
 * ★ 分工：画布由 `hero-engine` 画；本组件只管 DOM 层（字幕、手牌、Boss 血条、飘字、HUD）。
 *   hero 文案块（标题/副标/CTA）由 `Landing` 作为 children 传入——那些是被测试锁住的门面文案，
 *   留在 `Landing` 里，本组件不碰。
 * ★ 纪律：禁 emoji；动效一律 steps()；`prefers-reduced-motion` 下跳过序章、关闭抖屏/闪光/粒子，
 *   仍可完整交互；离开视口即停帧省电；jsdom / 无 2D 上下文时只渲染 DOM 层（不报错）。
 * ★ 演出里的 HP/伤害/卡牌数只是示意，不读写任何用户数据，也不代表产品数值。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLandingLang } from '../landing-lang';
import { CARDS, HERO_UI, PROLOGUE, WAVES } from './hero-copy';
import { HeroEngine } from './hero-engine';
import type { HeroSnap, PopKind } from './hero-engine';
import './landing-hero.css';

type Pop = { id: number; kind: PopKind; x: number; y: number };
const START: HeroSnap = { phase: 'intro', wave: 0, hp: 1, max: 1, kills: 0, busy: true, ready: false };

function prefersCalm(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `encounter`：知识大陆章节里的遭遇战——跳过序章、只打指定一波、胜利后回调转场回大陆 */
export type Encounter = { wave: number; onDone: () => void };

export function LandingHero({ children, encounter }: { children?: ReactNode; encounter?: Encounter }) {
  const { lang } = useLandingLang();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<HeroEngine | null>(null);
  const [snap, setSnap] = useState<HeroSnap>(START);
  const [line, setLine] = useState(0);
  const [typed, setTyped] = useState('');
  const [pops, setPops] = useState<Pop[]>([]);
  const [impact, setImpact] = useState('');
  const [calm] = useState(prefersCalm);
  const popId = useRef(0);
  const seen = useRef(false);
  const order = encounter ? [encounter.wave] : undefined;
  const orderKey = order?.join(',') ?? '';

  // 画布引擎：挂载即起，卸载即停；视口外停帧
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || /jsdom/i.test(navigator.userAgent)) return;
    let engine: HeroEngine;
    try {
      engine = new HeroEngine(canvas, {
        snap: setSnap,
        pop: (kind, x, y) => {
          const id = ++popId.current;
          setPops((p) => [...p.slice(-4), { id, kind, x, y }]);
          window.setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 1300);
        },
        impact: (k) => {
          setImpact(`lh-fx-${k}`);
          window.setTimeout(() => setImpact(''), 380);
        },
      }, calm, !!encounter);
    } catch {
      return; // 无 2D 上下文：只留 DOM 层
    }
    engineRef.current = engine;
    const fit = () => engine.resize(canvas.clientWidth, canvas.clientHeight);
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(canvas);
    let running = false;
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([e]) => {
          seen.current = !!e?.isIntersecting;
          if (e?.isIntersecting && !running) { engine.start(); running = true; }
          else if (!e?.isIntersecting && running) { engine.stop(); running = false; }
        })
      : null;
    if (io) io.observe(stage);
    else { engine.start(); running = true; seen.current = true; }
    return () => { ro?.disconnect(); io?.disconnect(); engine.stop(); engineRef.current = null; };
  }, [calm]);

  const begin = useCallback(() => {
    setLine(PROLOGUE.length);
    engineRef.current?.begin(orderKey ? orderKey.split(',').map(Number) : undefined);
    setSnap((s) => (engineRef.current ? s : { ...s, phase: 'fight', ready: true, busy: false }));
  }, [orderKey]);

  // 序章字幕打字机；减少动态效果时直接开战
  useEffect(() => {
    if (snap.phase !== 'intro') return;
    if (calm || encounter) { begin(); return; }
    if (line >= PROLOGUE.length) return;
    const full = PROLOGUE[line]![lang];
    if (typed.length < full.length) {
      const id = window.setTimeout(() => setTyped(full.slice(0, typed.length + 1)), lang === 'zh' ? 90 : 38);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => {
      if (line + 1 >= PROLOGUE.length) begin();
      else { setLine(line + 1); setTyped(''); }
    }, 1200);
    return () => window.clearTimeout(id);
  }, [snap.phase, line, typed, lang, calm, begin, encounter]);

  // 遭遇战胜利 → 稍作停顿后交还给大陆
  const onDone = encounter?.onDone;
  useEffect(() => {
    if (snap.phase !== 'victory' || !onDone) return;
    const id = window.setTimeout(onDone, calm ? 300 : 1500);
    return () => window.clearTimeout(id);
  }, [snap.phase, onDone, calm]);

  const play = useCallback((i: number) => { engineRef.current?.play(i); }, []);

  // 键盘 1–4 出牌（焦点在输入框时不抢键）
  useEffect(() => {
    if (snap.phase !== 'fight') return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (engineRef.current && !seen.current) return; // 不在视口的那一幕不抢键
      const n = Number(e.key);
      if (n >= 1 && n <= CARDS.length) play(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snap.phase, play]);

  const replay = () => { setPops([]); engineRef.current?.begin(); };
  const wave = WAVES[snap.wave]!;
  const fighting = snap.phase === 'fight';
  const cls = ['lh-stage', `lh-phase-${snap.phase}`, impact, calm ? 'lh-calm' : '', encounter ? 'lh-encounter' : ''].filter(Boolean).join(' ');

  return (
    <section className={encounter ? 'lh lh-framed' : 'landing-hero lh'}>
      <div
        ref={stageRef}
        className={cls}
        role="group"
        aria-label={HERO_UI.stageAria[lang]}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          engineRef.current?.setPointer((e.clientX - r.left) / Math.max(1, r.width));
        }}
      >
        <div className="lh-screen">
        <canvas ref={canvasRef} className="lh-canvas" aria-hidden="true" />
        <div className="lh-vignette" aria-hidden="true" />
        <div className="lh-grain" aria-hidden="true" />
        <div className="lh-bar lh-bar-top" aria-hidden="true" />
        <div className="lh-bar lh-bar-bottom" aria-hidden="true" />

        {snap.phase === 'intro' && !encounter && (
          <div className="lh-prologue">
            <p className="lh-subtitle" aria-live="polite">
              {typed}
              <span className="lh-caret" aria-hidden="true" />
            </p>
            <button type="button" className="lh-skip" onClick={begin}>
              {HERO_UI.skip[lang]}
            </button>
          </div>
        )}

        <div className="lh-hud" aria-hidden={!fighting}>
          <span className="lh-hud-label">{HERO_UI.hudLand[lang]}</span>
          <span className="lh-tiles">
            {WAVES.map((w, i) => (
              <i key={w.name.en} className={i < snap.kills ? 'lh-tile lh-tile-on' : 'lh-tile'} />
            ))}
          </span>
          <span className="lh-hud-label">
            {HERO_UI.hudCards[lang]} <b>{snap.kills}</b>
          </span>
        </div>

        {fighting && (
          <div className="lh-boss" key={snap.wave}>
            <div className="lh-boss-head">
              <strong>{wave.name[lang]}</strong>
              <span>{wave.title[lang]}</span>
            </div>
            <div className="lh-hp" role="meter" aria-valuemin={0} aria-valuemax={snap.max} aria-valuenow={snap.hp}>
              {/* 宽度随血量变化是数据驱动样式 */}
              {/* gates:style-ok */}
              <i style={{ width: `${(snap.hp / snap.max) * 100}%` }} />
            </div>
            <p className="lh-riddle">{wave.riddle[lang]}</p>
          </div>
        )}

        {pops.map((p) => (
          // gates:style-ok — 飘字落点由画布坐标换算
          <span key={p.id} className={`lh-pop lh-pop-${p.kind}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
            {HERO_UI.pops[p.kind][lang]}
          </span>
        ))}

        {snap.phase === 'victory' && (
          <div className="lh-victory" role="status">
            <strong>{HERO_UI.victoryTitle[lang]}</strong>
            {!encounter && <p>{HERO_UI.victoryText[lang]}</p>}
            {!encounter && (
              <button type="button" className="lh-replay" onClick={replay}>
                {HERO_UI.replay[lang]}
              </button>
            )}
          </div>
        )}

        </div>

        {!encounter && (
          <div className="lh-copy">
            <p className="lh-kicker">{HERO_UI.chapter[lang]}</p>
            {children}
          </div>
        )}

        <div className="lh-hand" role="toolbar" aria-label={HERO_UI.handAria[lang]}>
          {fighting && <span className="lh-hand-hint">{HERO_UI.handHint[lang]}</span>}
          {CARDS.map((c, i) => (
            <button
              key={c.name.en}
              type="button"
              className={`lh-card lh-c${i}`}
              disabled={!fighting || snap.busy}
              onClick={() => play(i)}
            >
              <span className="lh-card-key">{i + 1}</span>
              <span className="lh-card-name">{c.name[lang]}</span>
              <span className="lh-card-tag">{c.tag[lang]}</span>
            </button>
          ))}
        </div>
        {!encounter && <p className="lh-note">{HERO_UI.note[lang]}</p>}
      </div>
    </section>
  );
}
