/**
 * world/ChapterBoss — 冒险录「Boss 战就是对战」：对手切换（AI 出题师 / 好友）+ 回合循环演示。
 *
 * ★ 口径（PK-SPEC）：Boss 战由对战功能实现——双方互出题、限时作答、答对计分、积分定胜负；
 *   对手可以是 AI 出题师或经邀请链接加入的好友；AI 也会主动约战。
 *   演示里的回合节奏与分数都是示意；减少动态效果时停在第一步，可手动点步骤查看。
 */
import { useEffect, useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { BOSS_MAP, BOSS_PAL, HERO_MAP, HERO_PAL } from '../hero/hero-sprites';
import { NPC_ART } from './npc-art';
import { CH_BOSS as B } from './world-copy';
import { PixelSprite } from './PixelSprite';
import { Chapter } from './Chapter';

const MAX = 6;

export function ChapterBoss() {
  const { lang } = useLandingLang();
  const [foe, setFoe] = useState(0);
  const [tick, setTick] = useState(0);
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (calm) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 16), 1500);
    return () => window.clearInterval(id);
  }, [calm]);

  const step = tick % 4;
  const round = Math.floor(tick / 4);
  // 每回合：第 3 步判分——你出题他答（偶数回合他答错=你命中），攻守交换后你答对=再命中
  const foeHp = MAX - Math.min(MAX, round * 1 + (step >= 2 ? 1 : 0) + Math.floor(round / 2));
  const youHp = MAX - Math.min(MAX, Math.floor((round + (step >= 3 ? 1 : 0)) / 2));
  const hit = step === 2;
  const f = B.foes[foe]!;
  const friend = f.id === 'friend';

  return (
    <Chapter id="boss" title={B.title[lang]} accent={B.accent[lang]} lead={B.lead[lang]}>
      <div className="wb-foes" role="radiogroup" aria-label={B.aria[lang]}>
        {B.foes.map((x, i) => (
          <button key={x.id} type="button" role="radio" aria-checked={i === foe} className={i === foe ? 'wf-btn wb-foe wn-on' : 'wf-btn wb-foe'} onClick={() => { setFoe(i); setTick(0); }}>
            {x.name[lang]}
          </button>
        ))}
      </div>
      <div className={`wf-frame wb-arena${hit ? ' wb-hit' : ''}`}>
        <div className="wb-side wb-you">
          <div className="wb-hp"><span>{B.you[lang]}</span><i className={`wb-bar wb-v${youHp}`} /></div>
          <PixelSprite map={HERO_MAP} pal={HERO_PAL} className="wb-art" />
        </div>
        <div className="wb-mid">
          <span className="wb-round">ROUND {round + 1}</span>
          <span className="wb-clock">{45 - ((tick * 7) % 40)}s</span>
          <span className={`wb-bolt wb-bolt-${step}`} aria-hidden="true" />
        </div>
        <div className="wb-side wb-foe-side">
          <div className="wb-hp"><span>{f.boss[lang]}</span><i className={`wb-bar wb-v${foeHp}`} /></div>
          <PixelSprite map={friend ? NPC_ART.knight!.map : BOSS_MAP} pal={friend ? NPC_ART.knight!.pal : BOSS_PAL} className={friend ? 'wb-art wb-flip' : 'wb-art wb-big wb-flip'} />
        </div>
      </div>
      <ol className="wb-steps">
        {B.steps.map((s, i) => (
          <li key={s.en}>
            <button type="button" className={i === step ? 'wb-step wn-on' : 'wb-step'} onClick={() => setTick(round * 4 + i)}>
              <span>{i + 1}</span>{s[lang]}
            </button>
          </li>
        ))}
      </ol>
    </Chapter>
  );
}
