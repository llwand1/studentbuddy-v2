/**
 * guide-layout —— 提灯在主区里的落位口径（契约 `docs/GUIDE-SPEC.md` §8「位置」）。
 *
 * 提灯是 `position: fixed`，不改任何页面自己的盒子。但通栏页（卡牌 / 知识大陆）的内容顶着主区左边缘，
 * 没有空白可借——这两页在 `.sb-main` 左侧让出一条「灯笼轨」（`guide.css` 里的 `padding-left`）。
 * 窄屏（701–1199px）所有页都让出这条轨，那一档由 CSS 媒体查询管，不在这里。
 */
import type { View } from '../../app/nav';

/** 内容顶着主区左边缘的视图 */
export const GUIDE_RAIL_VIEWS: readonly View[] = ['cards', 'continent'];

/** `<main>` 的类名：`has-guide` 让窄屏档生效，`guide-rail` 让通栏页生效 */
export function guideMainClass(view: View): string {
  return ['sb-main', 'has-guide', GUIDE_RAIL_VIEWS.includes(view) ? 'guide-rail' : ''].filter(Boolean).join(' ');
}
