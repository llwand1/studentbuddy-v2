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
 * ★ 五帧的内容、产品代码对应、三处压缩声明，全部在 `./pk-boards` 的头注里（本文件只管时钟与外框）。
 *
 * ★ 计时口径：整段只有**一个 500ms 的表**（与 `PkMatch.tsx:66-70` 同口径——定时器只驱动展示，
 *   判定与数值一律派生），帧推进、两块屏上那个 45 秒、两侧比分全部由同一个 `tick` 算出来
 *   ⇒ 两块屏的数不可能互相对不上。一帧 2.5 秒 = 5 格 × 500ms（**能被整除是刻意的**：
 *   否则两侧读数会错半格，那正好是这一节最不该出的错）。
 *   `prefers-reduced-motion` 下不挂表 ⇒ 冻结在第 01 帧的双屏静态对照，信息一条不少。
 */
import { useEffect, useState } from 'react';
import { PK_FRAMES, PK_SCORE, PK_STAT, Screen } from './pk-boards';
import { prefersReducedMotion } from './demo/useDemoPlayer';

const TICK_MS = 500;
/** 一帧 5 格 = 2.5s；五帧一圈 = 12.5s（真局 8 分钟，压缩比例写在页面那行注里） */
const FRAME_TICKS = 5;

export function PkJourney() {
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
    <section className="landing-section" aria-label="对战：一道题在两块屏上同时走完">
      <h2 className="landing-h2">
        对战时你看到的，<span className="landing-accent">只是两块屏中的一块</span>
      </h2>
      <p className="landing-section-sub">
        下面左右是同一局里同时开着的两块屏。同一秒钟，一块上写着「等待对手作答」，另一块上写着「轮到你答」——
        它们必须对得上，因为两边读的是服务端同一份快照
      </p>

      <div className="landing-pk-boards" aria-hidden="true">
        <Screen side="我这一侧" score={PK_SCORE.mine(lap, f)} stat={PK_STAT.mine(f)}>
          {frame.mine(live)}
        </Screen>
        <Screen side="对手那一侧" score={PK_SCORE.his(lap, f)} stat={PK_STAT.his(f)}>
          {frame.his(live)}
        </Screen>
      </div>

      <ol className="landing-jsteps landing-pk-steps">
        {PK_FRAMES.map(({ no, title, lead, desc }, i) => (
          <li className={i === f ? 'landing-jstep hot' : 'landing-jstep'} key={no}>
            <div className="landing-jstep-top">
              <span className="landing-jstep-no">{no}</span>
              <h3 className="landing-feature-title">{title}</h3>
              <span className="landing-jtag">已落地</span>
            </div>
            <p className="landing-jstep-lead">{lead}</p>
            <p className="landing-feature-desc">{desc}</p>
          </li>
        ))}
      </ol>

      {/* 诚实标注：这一行不许被当成文案修饰删掉。口径与 `TermJourney` 那一条一致 */}
      <p className="landing-jnote">
        两块屏都是产品的真实屏态：样式就是对战页那份 CSS，「对手正在出题」和「答对 +2」两块用的就是产品组件本身，
        所以这里动的东西（呼吸点、骨架扫光、判定弹入）在真机上一模一样。压缩掉的只有时间——真一局 8 分钟、
        出题冷却 60 秒、答题 45 秒，这里 12.5 秒转一圈，冷却因此只画「冷却中」这个状态、不画剩余秒数。
        另外两处如实交代：折叠区在真机上默认收起，这里为了让人看见「正确答案」那一行画成了展开态；
        第 04 帧跳过了我那 40 多秒的思考，它按同一条规则在跑。演示取双人对局，单人进门时对手是 AI，走同一条出题与答题路径。
      </p>
    </section>
  );
}
