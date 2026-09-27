/**
 * world/ChapterDiscover — 冒险录「荒野里的异火」：俯视小地图上随机出现一簇异色篝火，
 * 走到相邻格即揭开一张其他玩家留下的词条笺（带留笺人名字）。纯示意，不连服务器。
 */
import { useCallback, useEffect, useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { CH_DISCOVER as D, EMBER_NOTES } from './lore-copy';
import { Chapter } from './Chapter';

const W = 11;
const H = 7;
const START = { x: 1, y: 3 };
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

  const tiles = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = `${x},${y}`;
      let cls = 'wd-tile';
      if ((x * 7 + y * 3) % 5 === 0) cls += ' wd-grass2';
      let inner = null;
      if (ROCKS.has(k)) inner = <i className={(x + y) % 2 ? 'wd-tree' : 'wd-rock'} />;
      if (fire.x === x && fire.y === y) inner = <i className={`wd-ember wd-hue-${note.hue}${near ? ' wd-ember-near' : ''}`} />;
      if (me.x === x && me.y === y) inner = <i className="wd-me" />;
      tiles.push(<button key={k} type="button" tabIndex={-1} className={cls} onClick={() => walkTo(x, y)} aria-hidden="true">{inner}</button>);
    }
  }

  const color = D.colors[lang]![note.hue]!;

  return (
    <Chapter id="discover" title={D.title[lang]} accent={D.accent[lang]} lead={D.lead[lang]}>
      <div className="wd-grid" role="group" aria-label={D.aria[lang]}>
        <div className="wf-frame wd-map-wrap">
          {/* gates:style-ok */}
          <div className="wd-map" tabIndex={0} onKeyDown={onKey} style={{ gridTemplateColumns: `repeat(${W}, 1fr)` }}>
            {tiles}
            {/* gates:style-ok */}
            <div className="wd-fog" aria-hidden="true" style={{ '--fx': `${((me.x + 0.5) / W) * 100}%`, '--fy': `${((me.y + 0.5) / H) * 100}%` } as React.CSSProperties} />
          </div>
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
