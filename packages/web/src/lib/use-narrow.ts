/**
 * use-narrow — 「现在是不是手机宽度」（契约 docs/MOBILE-SPEC.md §2）。
 *
 * 断点只有一个数、只在这里写：700px，与 `pixel-shell.css` / `mobile.css` 的 `@media (max-width: 700px)` 同一条线。
 * 文案类的差异（手机上 placeholder 要短）CSS 做不了，才需要 JS 知道这件事；布局差异一律仍走 CSS。
 * ★ `useSyncExternalStore` 订阅 matchMedia：旋转屏幕 / 拖窄窗口当场切换，不等重渲染；没有 matchMedia（jsdom、SSR）当宽屏。
 */
import { useSyncExternalStore } from 'react';

export const NARROW_QUERY = '(max-width: 700px)';

function mql(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const m = mql();
  if (!m) return () => undefined;
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
}

export const readNarrow = (): boolean => mql()?.matches ?? false;

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, readNarrow, () => false);
}
