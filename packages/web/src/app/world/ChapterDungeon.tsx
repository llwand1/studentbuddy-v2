/**
 * world/ChapterDungeon — 冒险录「副本 · 即将开启」：AI 把一个词条（光合作用）的发现史锻造成地图。
 * 五个时代 = 五片区域；每片有一只词条怪物与一道问题之门，答对才点亮通往下一时代的路。
 * 未来玩法预告，不调用模型；锻造过程是定时逐行显示的示意（减少动态效果时直接成形）。
 */
import { useEffect, useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { CH_DUNGEON as G, ERAS } from './lore-copy';
import { Chapter } from './Chapter';

type Phase = 'seed' | 'forging' | 'map';

export function ChapterDungeon() {
  const { lang } = useLandingLang();
  const [phase, setPhase] = useState<Phase>('seed');
  const [lines, setLines] = useState(0);
  const [open, setOpen] = useState(0); // 已解锁到第几个时代（含）
  const [cur, setCur] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (phase !== 'forging') return;
    if (lines >= G.forging.length) {
      const id = window.setTimeout(() => setPhase('map'), calm ? 0 : 500);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setLines((n) => n + 1), calm ? 0 : 520);
    return () => window.clearTimeout(id);
  }, [phase, lines, calm]);

  const era = ERAS[cur]!;
  const solved = open > cur || (pick !== null && pick === era.ok);
  const done = open >= ERAS.length;

  const answer = (i: number) => {
    setPick(i);
    if (i === era.ok && open === cur) setOpen(cur + 1);
  };
  const go = (i: number) => { if (i <= open && i < ERAS.length) { setCur(i); setPick(null); } };
  const reset = () => { setOpen(0); setCur(0); setPick(null); };

  return (
    <Chapter id="dungeon" title={G.title[lang]} accent={G.accent[lang]} lead={G.lead[lang]}>
      <div className="wg-wrap wf-frame" role="group" aria-label={G.aria[lang]}>
        <span className="wg-badge">{G.badge[lang]}</span>

        {phase !== 'map' && (
          <div className="wg-seed">
            <p className="wg-seed-label">{G.seed[lang]}</p>
            <div className="wg-card"><i className="wg-leaf" aria-hidden="true" />{G.seedTerm[lang]}</div>
            {phase === 'seed' ? (
              <button type="button" className="wf-btn wf-btn-blood" onClick={() => { setLines(0); setPhase('forging'); }}>{G.forge[lang]}</button>
            ) : (
              <ol className="wg-log" aria-live="polite">
                {G.forging.slice(0, lines).map((l, i) => <li key={i}>{l[lang]}</li>)}
                {lines < G.forging.length && <li className="wg-cursor" aria-hidden="true">▌</li>}
              </ol>
            )}
          </div>
        )}

        {phase === 'map' && (
          <div className="wg-map">
            <ol className="wg-path">
              {ERAS.map((e, i) => (
                <li key={e.year} className={`wg-node wg-t-${e.tile}${i === cur ? ' wg-cur' : ''}${i < open ? ' wg-clear' : ''}${i > open ? ' wg-lock' : ''}`}>
                  <button type="button" disabled={i > open} onClick={() => go(i)} aria-current={i === cur}>
                    <span className="wg-year">{e.year}</span>
                    <span className="wg-place">{e.place[lang]}</span>
                  </button>
                </li>
              ))}
            </ol>

            {done && cur === ERAS.length - 1 && solved ? (
              <div className="wg-clearall">
                <p>{G.cleared[lang]}</p>
                <button type="button" className="wf-btn wf-btn-gold" onClick={reset}>{G.again[lang]}</button>
              </div>
            ) : null}

            <div className={`wg-room wg-t-${era.tile}`} key={cur}>
              <div className="wg-scene">
                <p className="wg-era">{era.year} · {era.place[lang]}</p>
                <p className="wg-desc">{era.scene[lang]}</p>
                <div className="wg-foe">
                  <i className={`wg-foe-art wg-foe-${era.tile}${solved ? ' wg-foe-down' : ''}`} aria-hidden="true" />
                  <span><small>{G.monster[lang]}</small>{era.monster[lang]}</span>
                </div>
              </div>
              <div className={`wg-gate${solved ? ' wg-gate-open' : ''}`}>
                <p className="wg-gate-h">{G.gate[lang]} · {G.answer[lang]}</p>
                <p className="wg-q">{era.q[lang]}</p>
                <div className="wg-opts">
                  {era.opts.map((o, i) => (
                    <button key={i} type="button" disabled={solved}
                      className={`wf-btn${pick === i ? (i === era.ok ? ' wg-ok' : ' wg-no') : ''}${solved && i === era.ok ? ' wg-ok' : ''}`}
                      onClick={() => answer(i)}>{o[lang]}</button>
                  ))}
                </div>
                {pick !== null && <p className="wg-verdict">{pick === era.ok ? G.right[lang] : G.wrong[lang]}</p>}
                {solved && cur < ERAS.length - 1 && (
                  <button type="button" className="wf-btn wf-btn-blood wg-next" onClick={() => go(cur + 1)}>{G.enter[lang]} → {ERAS[cur + 1]!.year}</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <p className="wf-note">{G.note[lang]}</p>
    </Chapter>
  );
}
