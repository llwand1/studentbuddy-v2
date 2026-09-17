/**
 * use-flow-viewport —— 把「量容器尺寸 + 视口状态 + 滚轮/平移事件」收成一个 hook，
 * 让 FlowCanvas 只管画。几何全在 `flow-viewport.ts`（纯函数，可单测）。
 *
 * ★ 滚轮必须用**原生** `addEventListener(..., { passive: false })`，不能用 React 的 `onWheel`：
 *   React 把 wheel 注册成 passive 监听，`preventDefault()` 会失效（控制台警告 + 不生效）
 *   ⇒ 画布内滚轮会**同时缩放并滚动整个页面**。这条只能靠原生监听解决，没有别的写法。
 *
 * ★ 视口**只在「换了流」或「内容首次到位」时自动定一次**，之后再不自动改——否则会跟用户的平移打架
 *   （用户刚拖到想看的位置，一次 re-render 就被弹回中心）。用户摸过之后一律尊重用户的视角。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  ZOOM_STEP,
  fitViewport,
  initialViewport,
  panBy,
  viewBoxOf,
  wheelFactor,
  zoomAt,
  zoomBy,
  zoomPercent,
  type Bounds,
  type Size,
  type Viewport,
} from './flow-viewport';

export interface FlowViewport {
  /** 直接可用的 viewBox 字符串（宽高比 = 容器，见 flow-viewport 文件头） */
  viewBox: string;
  percent: number;
  /** 正在拖拽平移（给画布加光标 class） */
  panning: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** 回到 100%（以视口中心为锚） */
  resetZoom: () => void;
  fitToContent: () => void;
  startPan: (e: ReactPointerEvent) => void;
  /** 返回 true = 本帧真的产生了位移 */
  movePan: (e: ReactPointerEvent) => boolean;
  endPan: () => void;
}

/**
 * @param resetKey 换流才重置视口的键（传 `steps[0]?.defId`）。`undefined` = 还没有任何步骤，
 *                 此时不定视口，让调用方的兜底视口顶一会——避免「异步拉取步骤」期间
 *                 把视口钉在**空画布**的中心，等步骤到位后节点全在视野外。
 */
export function useFlowViewport(
  svgRef: RefObject<SVGSVGElement | null>,
  bounds: Bounds,
  resetKey: string | undefined,
): FlowViewport {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport | null>(null);
  const [panning, setPanning] = useState(false);

  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  /** 用户是否亲手调过视角（摸过之后就不再自动定视口） */
  const touchedRef = useRef(false);
  /** 已定过视口的键 + 当时有没有内容（用来判「要不要再补一次定视口」） */
  const initedRef = useRef<{ key: string; content: boolean } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  /** 量容器：ResizeObserver 而不是一次性读取——侧栏/窗口一变，viewBox 的宽高比就得跟着变 */
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [svgRef]);

  /**
   * 定视口的四条判据（顺序即优先级）：
   *  ① 换了流 → 必定重定（新流的节点可能在完全不同的坐标区，沿用旧视角就是一片空白）
   *  ② 用户摸过 → 不动
   *  ③ 这个流已经有内容时定过 → 不动（步骤增删不该把画布弹走）
   *  ④ 之前是空流、现在有内容了 → 补定一次（异步拉取的收口）
   */
  useEffect(() => {
    if (size.w === 0 || resetKey === undefined) return;
    const hasContent = bounds.w > 0 && bounds.h > 0;
    const cur = initedRef.current;
    const fresh = !cur || cur.key !== resetKey;
    if (!fresh && (touchedRef.current || cur.content || !hasContent)) return;
    initedRef.current = { key: resetKey, content: hasContent };
    setVp(initialViewport(boundsRef.current));
  }, [size.w, resetKey, bounds.w, bounds.h]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const factor = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey || e.metaKey);
      touchedRef.current = true;
      const rect = { w: el.clientWidth, h: el.clientHeight };
      setVp((v) => zoomAt(rect, v ?? initialViewport(boundsRef.current), factor, {
        x: e.clientX - box.left,
        y: e.clientY - box.top,
      }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [svgRef]);

  /** 每次动作现取容器尺寸：比缓存一份 `size` 更稳（拖窗口的同时点按钮不会用过期值） */
  const rectNow = useCallback((): Size => {
    const el = svgRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
  }, [svgRef]);

  const step = useCallback((factor: number) => {
    const rect = rectNow();
    if (rect.w === 0 || rect.h === 0) return;
    touchedRef.current = true;
    setVp((v) => zoomBy(rect, v ?? initialViewport(boundsRef.current), factor));
  }, [rectNow]);

  const zoomIn = useCallback(() => step(ZOOM_STEP), [step]);
  const zoomOut = useCallback(() => step(1 / ZOOM_STEP), [step]);

  const resetZoom = useCallback(() => {
    const rect = rectNow();
    if (rect.w === 0) return;
    touchedRef.current = true;
    setVp((v) => {
      const cur = v ?? initialViewport(boundsRef.current);
      // 走 zoomBy 让「回 100%」与滚轮/按钮共用同一条锚点逻辑（围绕视口中心，不跳位）
      return zoomBy(rect, cur, 1 / cur.scale);
    });
  }, [rectNow]);

  const fitToContent = useCallback(() => {
    const rect = rectNow();
    if (rect.w === 0 || rect.h === 0) return;
    touchedRef.current = true;
    setVp(fitViewport(rect, boundsRef.current));
  }, [rectNow]);

  const startPan = useCallback((e: ReactPointerEvent) => {
    panRef.current = { x: e.clientX, y: e.clientY };
    setPanning(true);
  }, []);

  const movePan = useCallback((e: ReactPointerEvent): boolean => {
    const p = panRef.current;
    if (!p) return false;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (dx === 0 && dy === 0) return false;
    panRef.current = { x: e.clientX, y: e.clientY };
    touchedRef.current = true;
    setVp((v) => panBy(v ?? initialViewport(boundsRef.current), dx, dy));
    return true;
  }, []);

  const endPan = useCallback(() => {
    panRef.current = null;
    setPanning(false);
  }, []);

  const view = vp ?? initialViewport(bounds);
  return {
    viewBox: viewBoxOf(size, view),
    percent: zoomPercent(view),
    panning,
    zoomIn,
    zoomOut,
    resetZoom,
    fitToContent,
    startPan,
    movePan,
    endPan,
  };
}
