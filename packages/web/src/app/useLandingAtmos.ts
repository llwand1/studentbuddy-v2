/**
 * useLandingAtmos — 落地页「暗夜篇章」的两条氛围行为（样式见 `landing-dark.css`）。
 *
 * ① 火把：指针位置写进根节点的 `--mx/--my`，暗幕跟着挖出一圈光（走 `style.setProperty`，
 *    不是 JSX 内联样式；rAF 节流，一帧最多写一次）。
 * ② 篇章浮现：根节点挂 `lx-armed` 后，顶层区块进入视口才加 `lx-seen`。
 *    ★ 默认态即终态：不支持 IntersectionObserver / 减少动态效果时**不武装**，区块直接可见。
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useLandingAtmos(root: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty('--mx', `${e.clientX}px`);
        el.style.setProperty('--my', `${e.clientY}px`);
      });
    };
    if (!calm) window.addEventListener('pointermove', onMove, { passive: true });
    let io: IntersectionObserver | null = null;
    if (!calm && typeof IntersectionObserver === 'function') {
      el.classList.add('lx-armed');
      io = new IntersectionObserver(
        (entries) => entries.forEach((en) => {
          if (en.isIntersecting) { en.target.classList.add('lx-seen'); io?.unobserve(en.target); }
        }),
        { rootMargin: '0px 0px -12% 0px' },
      );
      el.querySelectorAll('.landing-body > section').forEach((s) => io?.observe(s));
    }
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      el.classList.remove('lx-armed');
    };
  }, [root]);
}
