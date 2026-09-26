/**
 * useInViewIds — 「只在看得见的卡片上放动画」这道闸门（2026-09-26 像素风批新增）。
 *
 * ★ **为什么需要它**：全息扫描线挂的是 SR／SSR 卡，而 SR 档是"有 8 张卡以上"就到的档
 *   （`2^3`），一个认真用了两周的库里 SR+SSR 轻易几十上百张。CSS 动画虽然走合成层，
 *   **但每一张都是一条独立的合成层**——常驻满屏就是"整墙每帧重绘"，滚动先卡给你看。
 *   契约 §8 的频次判据管的是"一天上百次的信号不该播动画"，这条管的是另一个方向：
 *   **同一时刻在跑的动画数量必须有上限**，而唯一的天然上限就是视口。
 *
 * ⚠️ 边界（如实写着，别当成已解决）：
 *   ① 只观察传进来的 `ids`（调用点已经把 N／R 筛掉了），不是给墙上每张卡挂观察器；
 *   ② `rootMargin` 120px 是**提前起跑**，不是缓冲带——滚到看得见那一刻动画已经在相位里，
 *      所以扫描线的周期要 ≥ 3s，短周期会在视口外播完、进屏看到的是静止一半的带子；
 *   ③ 观察器随 `ids` 变化重建并 `disconnect()`，**不做增量 unobserve**：卡墙一次渲染的
 *      SR/SSR 节点数量小，重建比维护一份 id→element 映射便宜，也更不容易漏。
 *   ④ ★★ **视口不是上限**（2026-09-26 无头 Edge 实测，见 `tools/probes/cards-pixel-cdp.mjs` 与本簿 B-022）：
 *      1360×900 一屏铺得下 17 张 SR/SSR，`document.getAnimations()` 当场数到 17 条常驻循环在跑。
 *      所以真正兜底的是下面那个 `MAX_HOLO_LAYERS`——它按**墙上的行序**取前 N 张（不是"离眼睛最近"），
 *      代价如实写着：滚到墙下半部分时，如果上半那几张恰好还在提前起跑的 120px 带里，
 *      新进来的那张要等它们出视口才亮。
 */
import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

/** 命中标记用 `data-tid`（词条 id）写在卡片元素上，观察器靠它把回调里的节点认回来。 */
export const IN_VIEW_ATTR = 'data-tid';

/** ★ 同一时刻最多几张卡带全息层（SR 扫描线／SSR 扫光各算一张）。
 *  取 6 的理由不是玄学：17 是实测一屏的 SR+SSR 上限，而扫描线周期 3.6～4.2s ⇒ 6 层时
 *  合成层与主线程的代价还能被"每 4 秒一次的位移"摊平；再往上就是整墙每帧重绘。 */
export const MAX_HOLO_LAYERS = 6;

export function useInViewIds(
  root: RefObject<HTMLElement | null>,
  ids: readonly string[],
  cap: number = MAX_HOLO_LAYERS,
): ReadonlySet<string> {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    const scope = root.current;
    if (!scope || ids.length === 0) return;
    const nodes = ids
      .map((id) => scope.querySelector<HTMLElement>(`[${IN_VIEW_ATTR}="${id}"]`))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = e.target.getAttribute(IN_VIEW_ATTR);
            if (!id) continue;
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { rootMargin: '120px 0px' },
    );
    for (const n of nodes) io.observe(n);
    return () => io.disconnect();
  }, [root, ids]);

  /** 按 `ids` 的行序裁到 `cap`——裁在这里而不是观察器里，是因为观察器的回调只知道"谁进出了"，
      不知道墙上谁在前；在这儿裁只需要一次线性扫。 */
  return useMemo(() => {
    if (visible.size <= cap) return visible;
    const out = new Set<string>();
    for (const id of ids) {
      if (out.size >= cap) break;
      if (visible.has(id)) out.add(id);
    }
    return out;
  }, [ids, visible, cap]);
}
