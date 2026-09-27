/**
 * world/ChapterDiscover — 冒险录「荒野里的异火」：俯视小地图上随机出现一簇异色篝火，
 * 走到相邻格即揭开一张其他玩家留下的词条笺（带留笺人名字）。纯示意，不连服务器。
 * ★ 画面与第一章同一套像素美术（`continent-art`：带厚度的地砖、饥荒式竖立道具、红披风小勇者），
 *   canvas 逻辑分辨率很小、CSS 硬边放大；视野外压一层夜色迷雾。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { drawSprite } from '../hero/hero-sprites';
import { CHIBI_MAP, CHIBI_PAL, TILE_PAL, drawProp, drawTile } from './continent-art';
import type { Domain } from './world-copy';
import { useLandingLang } from '../landing-lang';
import { CH_DISCOVER as D, EMBER_NOTES } from './lore-copy';
import { Chapter } from './Chapter';

const W = 11;
const H = 7;
const START = { x: 1, y: 3 };
const T = 14;
const TH = Math.round(T * 0.75);
const PAD = 8;
const CW = W * T + PAD * 2;
const CH = H * TH + PAD * 2 + 10;
const HUE: Record<string, [string, string]> = { cyan: ['#7ff0ff', '#1aa3c2'], violet: ['#d6a8ff', '#7a3cc9'], gold: ['#ffe08a', '#c98a1a'], green: ['#a8ffb0', '#2f9e48'] };
/** 地形：左半草原、右半岩地，中间一道学习法沙带 */
const domainAt = (x: number, y: number): Domain => (x < 4 ? 'bio' : x === 4 || (x === 5 && y % 3 === 0) ? 'learn' : (x + y) % 5 === 0 ? 'chem' : 'phy');
/** 固定的装饰：树与石（不可站） */
const ROCKS = new Set(['3,1', '4,1', '7,5', '8,5', '6,2', '2,5', '9,1']);

function rollFire(prev?: { x: number; y: number }) {
  for (;;) {
    const x = 4 + Math.floor(Math.random() * (W - 5));
    const y = Math.floor(Math.random() * H);
    if (ROCKS.has(`${x},${y}`)) continue;
    if (prev && prev.x === x && prev.y === y) continue;
    return { x, y };
  }
}

export function ChapterDiscover() {
  const { lang } = useLandingLang();
  const [me, setMe] = useState(START);
  const [fire, setFire] = useState(() => ({ x: 8, y: 3 }));
  const [idx, setIdx] = useState(0);
  const [kept, setKept] = useState(false);
  const [thanked, setThanked] = useState(false);
  const note = EMBER_NOTES[idx]!;
  const near = Math.abs(me.x - fire.x) + Math.abs(me.y - fire.y) <= 1;

  const step = useCallback((dx: number, dy: number) => {
    setMe((p) => {
      const n = { x: Math.max(0, Math.min(W - 1, p.x + dx)), y: Math.max(0, Math.min(H - 1, p.y + dy)) };
      if (ROCKS.has(`${n.x},${n.y}`) || (n.x === fire.x && n.y === fire.y)) return p;
      return n;
    });
  }, [fire]);

  const walkTo = (x: number, y: number) => {
    // 一次走一格，朝目标方向（先横后纵），足够示意
    const dx = Math.sign(x - me.x);
    const dy = dx === 0 ? Math.sign(y - me.y) : 0;
    step(dx, dy);
  };

  const night = () => {
    setFire((f) => rollFire(f));
    setIdx((i) => (i + 1) % EMBER_NOTES.length);
    setKept(false);
    setThanked(false);
  };

  useEffect(() => { setKept(false); setThanked(false); }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    const m: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = m[e.key];
    if (d) { e.preventDefault(); step(d[0], d[1]); }
  };

  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current?.getContext('2d');
    if (!c) return;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [h1, h2] = HUE[note.hue] ?? HUE.cyan!;
    let raf = 0;
    const draw = (now: number) => {
      const t = calm ? 0 : now / 1000;
      c.imageSmoothingEnabled = false;
      c.globalAlpha = 1;
      c.fillStyle = '#07050a';
      c.fillRect(0, 0, CW, CH);
      const px = (x: number, y: number) => ({ X: PAD + x * T, Y: PAD + y * TH + 6 });
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const { X, Y } = px(x, y);
        drawTile(c, X, Y, T, TILE_PAL[domainAt(x, y)], y * W + x + 3, 0);
      }
      // 竖立物按 y 排序后画：道具 / 异火 / 勇者
      const items: Array<{ y: number; draw: () => void }> = [];
      for (const k of ROCKS) {
        const [x, y] = k.split(',').map(Number) as [number, number];
        const { X, Y } = px(x, y);
        const seed = (x + y) % 2 ? 7 : 2; // 7→树、2→石（drawProp 按 seed%7 取形）
        items.push({ y: Y + TH, draw: () => drawProp(c, X, Y + TH - 2, seed, domainAt(x, y), t) });
      }
      {
        const { X, Y } = px(fire.x, fire.y);
        const f = Math.floor(t * 8) % 2;
        items.push({ y: Y + TH, draw: () => {
          const glow = near ? 0.5 : 0.3 + 0.1 * f;
          c.globalAlpha = glow;
          c.fillStyle = h2;
          c.fillRect(X - 6, Y - 4, T + 12, TH + 8);
          c.globalAlpha = 1;
          c.fillStyle = '#3b2616';
          c.fillRect(X + 2, Y + TH - 3, T - 4, 2);
          c.fillStyle = h2;
          c.fillRect(X + 4, Y - 1 - f, 6, TH - 1 + f);
          c.fillRect(X + 3, Y + 3, 8, TH - 5);
          c.fillStyle = h1;
          c.fillRect(X + 5 + f, Y + 2 - f, 3, TH - 4);
          c.fillStyle = '#ffffff';
          c.fillRect(X + 6, Y + TH - 5, 2, 2);
          c.fillStyle = h1;
          c.fillRect(X + 3 + ((f * 5) % 8), Y - 6 - ((Math.floor(t * 4)) % 4), 1, 1);
        } });
      }
      {
        const { X, Y } = px(me.x, me.y);
        const bob = calm ? 0 : Math.floor(t * 2) % 2;
        items.push({ y: Y + TH + 1, draw: () => drawSprite(c, CHIBI_MAP, CHIBI_PAL, X + 3, Y - 4 - bob, {}) });
      }
      items.sort((p, q) => p.y - q.y).forEach((i) => i.draw());
      c.globalAlpha = 1;
      // 夜色迷雾：以勇者为圆心的视野
      const { X, Y } = px(me.x, me.y);
      const g = c.createRadialGradient(X + T / 2, Y + TH / 2, 10, X + T / 2, Y + TH / 2, 70);
      g.addColorStop(0, 'rgba(7,5,10,0)');
      g.addColorStop(0.55, 'rgba(7,5,10,0.55)');
      g.addColorStop(1, 'rgba(7,5,10,0.85)');
      c.fillStyle = g;
      c.fillRect(0, 0, CW, CH);
      // 异火穿透迷雾：再点一次它的芯
      const fp = px(fire.x, fire.y);
      c.fillStyle = h1;
      c.globalAlpha = 0.9;
      c.fillRect(fp.X + 5, fp.Y + 2, 3, TH - 4);
      c.globalAlpha = 1;
      if (!calm) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [me, fire, near, note.hue]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const lx = ((e.clientX - r.left) / r.width) * CW;
    const ly = ((e.clientY - r.top) / r.height) * CH;
    walkTo(Math.floor((lx - PAD) / T), Math.floor((ly - PAD - 6) / TH));
  };

  const color = D.colors[lang]![note.hue]!;

  return (
    <Chapter id="discover" title={D.title[lang]} accent={D.accent[lang]} lead={D.lead[lang]}>
      <div className="wd-grid" role="group" aria-label={D.aria[lang]}>
        <div className="wf-frame wd-map-wrap">
                    <canvas ref={cv} className="wd-map" width={CW} height={CH} tabIndex={0} onKeyDown={onKey} onClick={onCanvasClick} aria-hidden="true" />
          <div className="wd-pad" aria-label={D.move[lang]}>
            <button type="button" className="wf-btn" onClick={() => step(0, -1)} aria-label="↑">↑</button>
            <button type="button" className="wf-btn" onClick={() => step(-1, 0)} aria-label="←">←</button>
            <button type="button" className="wf-btn" onClick={() => step(0, 1)} aria-label="↓">↓</button>
            <button type="button" className="wf-btn" onClick={() => step(1, 0)} aria-label="→">→</button>
            <button type="button" className="wf-btn wf-btn-gold wd-night" onClick={night}>{D.reroll[lang]}</button>
          </div>
        </div>

        <div className={`wf-frame wd-note${near ? ' wd-note-open' : ''} wd-hue-${note.hue}`} aria-live="polite">
          {!near ? (
            <p className="wd-far">{D.far[lang].replace('{c}', color)}</p>
          ) : (
            <div className="wd-scroll" key={idx}>
              <p className="wd-kicker">{D.near[lang]}</p>
              <h3 className="wd-term">{note.term[lang]}</h3>
              <p className="wd-body">「{note.body[lang]}」</p>
              <p className="wd-sign">—— {D.sign[lang]} <b>{note.who[lang]}</b> · {note.when[lang]}</p>
              <div className="wd-acts">
                <button type="button" className="wf-btn wf-btn-blood" disabled={kept} onClick={() => setKept(true)}>{kept ? D.kept[lang] : D.keep[lang]}</button>
                <button type="button" className="wf-btn" disabled={thanked} onClick={() => setThanked(true)}>{thanked ? D.thanked[lang] : D.thank[lang]}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="wf-note">{D.note[lang]}</p>
    </Chapter>
  );
}
