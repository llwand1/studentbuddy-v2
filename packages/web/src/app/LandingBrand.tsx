/**
 * LandingBrand — 落地页顶栏那块牌子（吉祥物 + 产品名 + 副标题），名字 **打字机** 逐字打出。
 *
 * ★ 老板点单（2026-09-21）：「吉祥物旁边是产品名 studentbuddy，建议把这个名字加大加粗，
 *   然后做成打字机效果，先播放 studentbuddy，然后播放你的专属学习助手」。
 *
 * ★★ 内容不是编的：名字与副标题**就是产品侧栏 logo 的那两块**（`lib/brand.ts` 唯一定义，
 *   产品侧 `App.tsx:186-188` 用同一对常量）⇒ 打完的终态与进产品后看到的那块牌子**逐字一致**。
 *   ★ 换句话说，这段打字机的产品事实是「**终态**」：它是产品里那块牌子的逐字复刻；
 *   而「打字」本身是门面的修辞（产品不会打自己的名字）——故减速设置下整段打字被摘掉，
 *   直接落终态（同 `useDemoPlayer` 的「停在最后一帧」口径，不是停成空白）。
 *
 * ★★ 光标也不是自己画的：直接复用产品的**流式光标** `.chat-caret`（定义在
 *   `features/chat/chat.css:52-60`，产品里挂载它的先例是 `ChatView.tsx:222`：
 *   模型还在吐字时气泡尾巴上就亮它）⇒ 这里亮的是**同一个类**，不是长得像的第二个。
 *   ★ 前提：`chat.css` 由 `ChatView` 引入，且当前**没有代码分割**（全站同一份样式表，
 *     落地页也在其中）。若将来把落地页拆成独立 chunk，这条依赖会**静默失效**——
 *     届时把 `.chat-caret` 的定义搬进 `landing.css`（**搬值不搬文件**，同 `demo.css` 先例），
 *     并把下面那条「光标用的是产品类」的锁一起改。
 *
 * ★ 单一时钟（同 `PkJourney` / `useDemoPlayer`）：一个 `setTimeout` 走一格，
 *   两行各显示几个字**全部由 `tick` 派生**（`typedAt`，纯函数、单独锁矩阵）。
 *   打完那格**不再挂表**——不是靠 `clearInterval` 收尾，而是到点就不再排下一个。
 */
import { useEffect, useState } from 'react';
import { BRAND_NAME, BRAND_TAGLINE } from '../lib/brand';
import { Mascot } from '../features/chat/Mascot';
import { prefersReducedMotion } from './demo/useDemoPlayer';

/** 每字一格（毫秒）。门面修辞，不是产品节奏——产品的流式吐字速度由模型决定，不适用在这里 */
const STEP_MS = 70;
/** 名字打完后停几格再打副标题（4 格 ≈ 280ms）：一口气连打会读成一行，停一下才分得出主次 */
const NAME_HOLD_TICKS = 4;
/** 走完需要的格数（tick 从 1 起，最后一格是终态） */
export const TOTAL_TICKS = BRAND_NAME.length + NAME_HOLD_TICKS + BRAND_TAGLINE.length;

/** 第 `tick` 格时两行各应显示几个字（纯函数：组件只负责把它画出来） */
export function typedAt(tick: number): { name: number; tag: number } {
  return {
    name: Math.min(Math.max(tick, 0), BRAND_NAME.length),
    tag: Math.min(Math.max(tick - BRAND_NAME.length - NAME_HOLD_TICKS, 0), BRAND_TAGLINE.length),
  };
}

export function LandingBrand() {
  // ★ 渲染期只问一次：`prefersReducedMotion` 自带三重防御（无 window / jsdom 无 matchMedia
  //   都恒 false），所以放进惰性初值是安全的——放 effect 里反而会先画一格空牌子再跳终态
  const [reduce] = useState(() => prefersReducedMotion());
  const [tick, setTick] = useState(1);
  const done = tick >= TOTAL_TICKS;

  useEffect(() => {
    if (reduce || done) return;
    const id = window.setTimeout(() => setTick((t) => t + 1), STEP_MS);
    return () => window.clearTimeout(id);
  }, [reduce, tick, done]);

  const shown = reduce ? { name: BRAND_NAME.length, tag: BRAND_TAGLINE.length } : typedAt(tick);
  const typingName = !reduce && shown.name < BRAND_NAME.length;
  const typingTag = !reduce && !typingName && shown.tag < BRAND_TAGLINE.length;

  return (
    <span className="landing-brand">
      <Mascot />
      <span className="landing-brand-text">
        <span className="landing-brand-name">
          {BRAND_NAME.slice(0, shown.name)}
          {typingName && <span className="chat-caret" />}
        </span>
        {/* 副标题那一行**从第一帧就占着位**（landing.css 给 min-height）：
            不占位的话它出现的那一刻顶栏会长高，把下面整页往下推一次 */}
        <span className="landing-brand-tag">
          {BRAND_TAGLINE.slice(0, shown.tag)}
          {typingTag && <span className="chat-caret" />}
        </span>
      </span>
    </span>
  );
}
