/**
 * useDragWindow — 把刷词小窗变成**可拖动的浮窗**（契约 `docs/WAIT-DRILL-SPEC.md` §5.6，2026-09-30 资料溯源批次）。
 *
 * 为什么要拖：右侧现在常驻「资料架」（AI 在看的资料），刷词若还是居中模态就把资料挡个正着。
 * 改成非模态浮窗，学习者按喜好把它拖到左边或中间，资料固定在右边——两个都开着也互不遮挡。
 *
 * 实现口径：
 *  - 位置写在窗元素的 CSS 变量 `--drill-x/--drill-y` 上（`transform: translate(...)`），不走 React state：
 *    拖动每帧一次 setState 会带着整张卡重渲。也不是 `style={{}}`（仓规禁内联样式）。
 *  - 拖柄是头部（`.drill-head`），但头部里的按钮（音效 / 关闭）点下去不算拖。
 *  - 限位：窗永远留至少 `MIN_VISIBLE` 像素在视口内，顶边不越出（头部要一直够得着）；窗口 resize 时重新夹。
 *  - 首次没有记忆位置时居中；拖完把位置存进本机偏好（`drill-prefs.pos`），下次原地出现。
 *  - ≤640px 的窄屏不拖：CSS 侧退回底部抽屉（transform 失效），JS 侧也不进入拖动——否则抽屉上划两下
 *    会把一个看不见的位置写进偏好，回到宽屏时窗就跑到屏幕外。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

export const MIN_VISIBLE = 64;
/** 与 drill.css 的窄屏断点一致 */
export const SHEET_MEDIA = '(max-width: 640px)';
const isSheet = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(SHEET_MEDIA).matches;

export interface WindowPos {
  x: number;
  y: number;
}

/** 把窗夹回视口（纯函数，可单测） */
export function clampWindowPos(pos: WindowPos, size: { w: number; h: number }, view: { w: number; h: number }): WindowPos {
  const maxX = Math.max(0, view.w - MIN_VISIBLE);
  const minX = Math.min(0, MIN_VISIBLE - size.w);
  const maxY = Math.max(0, view.h - MIN_VISIBLE);
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, pos.x))),
    y: Math.round(Math.min(maxY, Math.max(0, pos.y))),
  };
}

/** 默认位置：视口居中（顶部至少留 12px） */
export function centeredPos(size: { w: number; h: number }, view: { w: number; h: number }): WindowPos {
  return { x: Math.max(0, Math.round((view.w - size.w) / 2)), y: Math.max(12, Math.round((view.h - size.h) / 2)) };
}

function apply(el: HTMLElement, pos: WindowPos): void {
  el.style.setProperty('--drill-x', `${pos.x}px`);
  el.style.setProperty('--drill-y', `${pos.y}px`);
}

export function useDragWindow(
  ref: RefObject<HTMLElement | null>,
  opts: { handle: string; initial: WindowPos | null; onSettle: (pos: WindowPos) => void },
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // layout effect：首帧就把位置写上，避免先画在左上角再跳到居中
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opts = optsRef.current;
    const view = () => ({ w: window.innerWidth, h: window.innerHeight });
    const size = () => ({ w: el.offsetWidth, h: el.offsetHeight });
    let pos = opts.initial ? clampWindowPos(opts.initial, size(), view()) : centeredPos(size(), view());
    apply(el, pos);

    let drag: { id: number; dx: number; dy: number } | null = null;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null;
      if (!t || e.button !== 0 || isSheet() || !t.closest(opts.handle) || t.closest('button, a, input')) return;
      drag = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      el.classList.add('dragging');
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      pos = clampWindowPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, size(), view());
      apply(el, pos);
    };
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.classList.remove('dragging');
      optsRef.current.onSettle(pos);
    };
    const onResize = (): void => {
      pos = clampWindowPos(pos, size(), view());
      apply(el, pos);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      window.removeEventListener('resize', onResize);
    };
    // 只在挂载时装一次（依赖只有 ref）：initial 只用于首帧，之后位置由拖动决定；onSettle 经 optsRef 读最新值
  }, [ref, optsRef]);
}
