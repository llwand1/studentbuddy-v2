/**
 * features/continent/useContinentKeys — 键盘走位（方向键 / WASD）的监听（从 `ContinentPage.tsx` 拆出，2026-09-29）。
 *
 * ★ 拆出的理由只有一个：页面文件贴 `.tsx ≤320` 红线，而这段 effect 与页面的其它逻辑没有耦合
 *   （它只要"现在冻结没有"与"走一步"两个入参）。
 * ★ 弹窗开着时让位（`frozen`）——不然在填空框里打字会变成走路。
 */
import { useEffect } from 'react';

const DIRS: Record<string, [number, number]> = {
  arrowup: [-1, 0],
  arrowdown: [1, 0],
  arrowleft: [0, -1],
  arrowright: [0, 1],
  w: [-1, 0],
  s: [1, 0],
  a: [0, -1],
  d: [0, 1],
};

export function useContinentKeys(frozen: boolean, step: (dr: number, dc: number) => void): void {
  useEffect(() => {
    if (frozen) return;
    const onKey = (e: KeyboardEvent): void => {
      const dir = DIRS[e.key.toLowerCase()];
      if (!dir) return;
      e.preventDefault();
      step(dir[0], dir[1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen, step]);
}
