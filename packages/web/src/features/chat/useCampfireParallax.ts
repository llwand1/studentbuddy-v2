import { useEffect, type RefObject } from 'react';

/** Local, bounded pointer response. Never schedules a frame while the pointer is idle. */
export function useCampfireParallax(ref: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const world = ref.current;
    const stage = world?.parentElement;
    if (!world || !stage) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia?.('(pointer: fine)');
    let frame = 0;
    let x = 0;
    let y = 0;
    const clear = () => {
      window.cancelAnimationFrame(frame); frame = 0;
      world.style.removeProperty('--cw-x'); world.style.removeProperty('--cw-y');
    };
    const move = (event: PointerEvent) => {
      if (reduce?.matches || fine?.matches === false || event.pointerType === 'touch' || document.hidden || stage.clientWidth < 1160) return;
      const box = stage.getBoundingClientRect();
      x = Math.round(Math.max(-6, Math.min(6, (event.clientX - box.left - box.width / 2) / box.width * 12)));
      y = Math.round(Math.max(-4, Math.min(4, (event.clientY - box.top - box.height / 2) / box.height * 8)));
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        world.style.setProperty('--cw-x', `${x}px`); world.style.setProperty('--cw-y', `${y}px`);
      });
    };
    const preference = () => { if (reduce?.matches) clear(); };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', clear);
    document.addEventListener('visibilitychange', clear);
    reduce?.addEventListener?.('change', preference);
    return () => {
      clear(); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerleave', clear);
      document.removeEventListener('visibilitychange', clear); reduce?.removeEventListener?.('change', preference);
    };
  }, [ref]);
}
