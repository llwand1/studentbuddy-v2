/**
 * PkJourney — 落地页的「一道题在两块屏上同时走完」段（老板 2026-09-21 点单：
 * 「对战模式的过程式动画没有加进这个正式版里，直接加一节吧」）。
 *
 * ★ 为什么不塞进 hero 那一格：hero 只有 302px 高，装得下**一块屏的五个先后屏态**，
 *   装不下这段真正要说的事——对战是**两块屏同时在跑**。同一秒钟，我这侧写着
 *   「等待对手作答 · 41s」，他那侧写着「轮到你答 · 41s」（`PkMatch.tsx:251-261` 与
 *   `PkAnswerBlock.tsx:28-56` 是同一份快照在两处渲染）。这个对照只有整幅宽才画得开，
 *   所以它是一节，不是演示窗的第四个 Tab。
 *
 * ★ 五帧的屏态在 `./pk-frames`、屏态积木与产品代码对应在 `./pk-boards`、文案在 `./pk-copy`
 *   （本文件只管时钟、外框与那句诚实标注）。
 *
 * ★ 计时口径：整段只有**一个 500ms 的表**（与 `PkMatch.tsx:66-70` 同口径——定时器只驱动展示，
 *   判定与数值一律派生），帧推进、两块屏上那个 45 秒、两侧比分全部由同一个 `tick` 算出来
 *   ⇒ 两块屏的数不可能互相对不上。一帧 2.5 秒 = 5 格 × 500ms（**能被整除是刻意的**：
 *   否则两侧读数会错半格，那正好是这一节最不该出的错）。
 *   `prefers-reduced-motion` 下不挂表 ⇒ 冻结在第 01 帧的双屏静态对照，信息一条不少。
 */
import { useEffect, useState } from 'react';
import { PK_SCORE, PK_STAT, Screen } from './pk-boards';
import { PK_FRAMES } from './pk-frames';
import { LAND_TAG } from './landing-copy';
import { SECTION, T } from './pk-copy';
import { useLandingLang } from './landing-lang';
import { prefersReducedMotion } from './demo/useDemoPlayer';

const TICK_MS = 500;
/** 一帧 5 格 = 2.5s；五帧一圈 = 12.5s（真局 8 分钟，压缩比例写在页面那行注里） */
const FRAME_TICKS = 5;

export function PkJourney() {
  const { lang } = useLandingLang();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return; // 静态：停在第 01 帧
    const iv = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  const f = Math.floor(tick / FRAME_TICKS) % PK_FRAMES.length;
  const lap = Math.floor(tick / (FRAME_TICKS * PK_FRAMES.length));
  const k = tick % FRAME_TICKS;
  const live = { left: 45 - k, sec: k };
  const frame = PK_FRAMES[f];
  if (!frame) return null; // noUncheckedIndexedAccess ⇒ 不写 `!`

  return (
    <section className="landing-section" aria-label={SECTION.aria[lang]}>
      <h2 className="landing-h2">
        {SECTION.h2Pre[lang]}
        <span className="landing-accent">{SECTION.h2Accent[lang]}</span>
      </h2>
      <p className="landing-section-sub">{SECTION.sub[lang]}</p>

      <div className="landing-pk-boards" aria-hidden="true">
        <Screen side={T.mineSide} score={PK_SCORE.mine(lap, f)} stat={PK_STAT.mine(f, lang)}>
          {frame.mine(live)}
        </Screen>
        <Screen side={T.rivalSide} score={PK_SCORE.his(lap, f)} stat={PK_STAT.his(f, lang)}>
          {frame.his(live)}
        </Screen>
      </div>

      <ol className="landing-jsteps landing-pk-steps">
        {PK_FRAMES.map(({ no, title, lead, desc }, i) => (
          <li className={i === f ? 'landing-jstep hot' : 'landing-jstep'} key={no}>
            <div className="landing-jstep-top">
              <span className="landing-jstep-no">{no}</span>
              <h3 className="landing-feature-title">{title[lang]}</h3>
              <span className="landing-jtag">{LAND_TAG.shipped[lang]}</span>
            </div>
            <p className="landing-jstep-lead">{lead[lang]}</p>
            <p className="landing-feature-desc">{desc[lang]}</p>
          </li>
        ))}
      </ol>

      {/* 诚实标注：这一行不许被当成文案修饰删掉。口径与 `TermJourney` 那一条一致 */}
      <p className="landing-jnote">{SECTION.note[lang]}</p>
    </section>
  );
}
