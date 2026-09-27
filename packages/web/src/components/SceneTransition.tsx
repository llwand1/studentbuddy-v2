/**
 * SceneTransition —— 像素场景转场（2026-09-27）。
 *
 * 用在两处：应用壳 `<main>` 里的五个视图切换（`App.tsx`），以及根层落地页 ↔ 应用 ↔ 对战页换根（`main.tsx`）。
 * 它只做两件事，样式全在 `styles/pixel-motion.css`：
 *   ① 场景层按 `scene` 换 key ⇒ 新场景的根节点重挂、CSS 入场动画重播（与原先 `view === x && <X/>` 的
 *      挂载语义一致——旧场景本来就会被卸载，这里没有多卸一次）；
 *   ② 每次 `scene` **变化**时铺一块幕布压在舞台上、由 CSS 从上到下掀开露出新场景。
 *
 * ★ 内容**同步**换、幕布只是盖在上面：不做「先播出场再换内容」那种两段式——那会让点击到上屏之间
 *   凭空多出一拍延迟，而且要用计时器持状态；这里零计时器、零 effect，状态只有「第几块幕布」。
 * ★ 首次挂载不铺幕布：打开应用不该先看见一块布再看见界面。
 * ★ 减少动态效果：渲染期问一次 `prefersReducedMotion()`（与 `LandingBrand` 同一取法），命中就**根本不渲染**
 *   幕布节点——不靠 CSS 兜底。CSS 那边另有一条保险（幕布默认态就是裁到零高），两层互不依赖。
 * ★ 幕布 `aria-hidden` ＋ `pointer-events: none`（CSS），不进辅助技术、不挡点击；动画播完自行卸载，
 *   连续快速切换时 key 递增 ⇒ 旧幕布直接被新幕布替换，不会叠出多块。
 * ★ `animationend` 在这里只管**收尸**，不管时机（本仓 `demo/registry.ts` 记过它不可靠）：万一它不来，
 *   留下的节点也是裁到零高、不接指针的一层，下一次切换又会被换掉——最坏情况是多一个空节点，不是多一块布。
 */
import { useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../app/demo/useDemoPlayer';

export function SceneTransition({
  scene,
  full = false,
  children,
}: {
  /** 场景标识：变化即视为一次转场（同值重渲染不转场） */
  scene: string;
  /** 根层转场：幕布改为 `position: fixed` 盖整个视口（默认只盖舞台自身） */
  full?: boolean;
  children: ReactNode;
}) {
  /** 渲染期只问一次：命中「减少动态效果」的用户整个会话都不该看见幕布 */
  const [reduce] = useState(() => prefersReducedMotion());
  /** 第几块幕布；0 ＝ 没有幕布在场。首次挂载为 0，所以打开应用不铺布 */
  const [wipe, setWipe] = useState(0);
  // 「派生自 props 的状态在渲染期就地校正」——React 官方推荐的写法（不用 effect，避免多一帧空窗）
  const [prevScene, setPrevScene] = useState(scene);
  if (prevScene !== scene) {
    setPrevScene(scene);
    setWipe(wipe + 1);
  }

  return (
    <div className={full ? 'sb-scene-stage is-full' : 'sb-scene-stage'}>
      <div key={scene} className="sb-scene" data-scene={scene}>
        {children}
      </div>
      {wipe > 0 && !reduce && (
        <div
          key={wipe}
          className={full ? 'sb-scene-wipe is-full' : 'sb-scene-wipe'}
          aria-hidden="true"
          onAnimationEnd={() => setWipe(0)}
        />
      )}
    </div>
  );
}
