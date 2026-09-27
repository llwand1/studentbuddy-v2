/**
 * world/ChapterCards — 冒险录「每一次相遇都会凝成卡牌」：四档稀有度卡面 + 每日宝箱开箱仪式（示意）。
 * ★ 稀有度 N/R/SR/SSR 与"卡数从流水派生"的口径见 TERM-CARDS-SPEC；这里的卡数只是示意。
 */
import { useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { CH_CARDS as K } from './world-copy';
import { PixelSprite } from './PixelSprite';
import { Chapter } from './Chapter';

const STARS: Record<string, number> = { N: 1, R: 2, SR: 3, SSR: 5 };
const CHEST = [
  '..kkkkkkkkkk..',
  '.kGgggggggggk.',
  'kGgWWWWWWWWggk',
  'kkkkkkkkkkkkkk',
  'kBbbbbkkbbbbBk',
  'kBbbbkYYkbbbBk',
  'kBbbbbkkbbbbBk',
  'kBbbbbbbbbbbBk',
  'kkkkkkkkkkkkkk',
];
const CHEST_PAL = { k: '#07050a', G: '#6a4a1a', g: '#8a6a2a', W: '#b89a5a', B: '#5a3a1a', b: '#7a5228', Y: '#ffd27a' };

export function ChapterCards() {
  const { lang } = useLandingLang();
  const [state, setState] = useState<'shut' | 'shake' | 'open'>('shut');
  const [pull, setPull] = useState(3);
  const open = () => {
    if (state === 'shake') return;
    setState('shake');
    window.setTimeout(() => { setPull((p) => (p + 1) % K.cards.length); setState('open'); }, 700);
  };
  const got = K.cards[pull]!;

  return (
    <Chapter id="cards" title={K.title[lang]} accent={K.accent[lang]} lead={K.lead[lang]}>
      <div className="wk-row">
        <ul className="wk-fan">
          {K.cards.map((c) => (
            <li key={c.r} className={`wk-card wk-${c.r}`}>
              <span className="wk-r">{c.r}</span>
              <span className="wk-stars" aria-label={`${STARS[c.r]}★`}>{'★'.repeat(STARS[c.r]!)}</span>
              <strong>{c.name[lang]}</strong>
              <span className="wk-n">×{c.n} {K.countLabel[lang]}</span>
            </li>
          ))}
        </ul>
        <div className={`wf-frame wk-chest wk-chest-${state}`}>
          <div className="wk-rays" aria-hidden="true" />
          {state === 'open' ? (
            <div className={`wk-card wk-got wk-${got.r}`} key={pull} role="status">
              <span className="wk-r">{got.r}</span>
              <span className="wk-stars">{'★'.repeat(STARS[got.r]!)}</span>
              <strong>{got.name[lang]}</strong>
              <span className="wk-n">+1</span>
            </div>
          ) : (
            <PixelSprite map={CHEST} pal={CHEST_PAL} className="wk-box" />
          )}
          <button type="button" className="wf-btn wf-btn-gold" onClick={open} disabled={state === 'shake'}>
            {state === 'open' ? K.again[lang] : K.open[lang]}
          </button>
        </div>
      </div>
    </Chapter>
  );
}
