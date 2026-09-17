/**
 * flow-viewport —— 画布**视口**（缩放 / 平移）的几何纯逻辑（契约 docs/STUDY-FLOW-SPEC.md §2.4）。
 *
 * ★ 为什么必须有这个文件（2026-09-17 老板实测反馈：「构建的主图应该自带放大缩小的功能,不然看不清」）：
 *   原实现把 `viewBox` 直接设成 `contentBounds(...)` 再配 `preserveAspectRatio="xMidYMid meet"`，
 *   语义是「**永远把内容整体塞进容器**」——内容一宽就自动缩，10px 的字缩到 6px 就没法读了。
 *   更糟的是**用户没有任何手段拉回来**：缩放权完全在「内容尺寸」手里，不在用户手里。
 *   ⇒ 「自适应」的正确位置是**一个显式按钮（适配窗口）**，不能当默认行为。
 *
 * ★ 坐标口径（全仓只此一处，改必同步）：
 *   `scale` = **1 用户单位占几个屏幕像素**（1 = 100%）。
 *   视口状态记的是**中心点 (cx, cy)**，不是左上角——缩放要绕锚点做，用中心点表达最省推导。
 *   `viewBox` 的宽高恒为 `容器像素 / scale` ⇒ **宽高比与容器严格相等**，
 *   `meet` 永不产生 letterbox，屏幕像素 ↔ 用户坐标是纯线性映射。
 *   这条是硬约束：拖拽换算走 `getScreenCTM()`（见 FlowCanvas.toSvg），
 *   一旦出现 letterbox，「鼠标位置 → 用户坐标」就会整体偏移，拖拽会飘。
 *
 * ★ 默认 100%（不是默认适配）：老板要的是「看得清」。全貌交给「适配窗口」按钮。
 *   两三个步骤的小图 100% 与适配几乎重合；大图 100% 保证字可读，超出部分靠平移看。
 */
import type { Point } from './flow-layout';

/** 视口：中心 + 缩放（1 用户单位 = scale 像素） */
export interface Viewport {
  scale: number;
  cx: number;
  cy: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 外接矩形（`contentBounds` 的返回形状） */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;
/** 按钮一档的缩放倍率（滚轮不走这个，滚轮是连续量） */
export const ZOOM_STEP = 1.2;
/** 适配时四周留的边距（像素） */
export const FIT_MARGIN = 24;

/** 滚轮灵敏度：一档 deltaY=100 的鼠标走 `exp(-100*0.0015)` ≈ 0.86（掉 14%） */
const WHEEL_K = 0.0015;
/** 触控板 pinch（浏览器把双指缩放报成 `ctrlKey=true` 的 wheel）要更跟手 */
const WHEEL_K_PINCH = 0.01;

/** 容器还没量到尺寸时的兜底，防 viewBox 退化成 `0 0 0 0`（渲染不出任何东西） */
const FALLBACK_SIZE: Size = { w: 800, h: 420 };

/** DOM 里的 viewBox 数字保留 2 位小数：平移时不必抖出 1e-14 这种噪声 */
const r2 = (v: number): number => Math.round(v * 100) / 100;

function norm(rect: Size): Size {
  return { w: rect.w > 0 ? rect.w : FALLBACK_SIZE.w, h: rect.h > 0 ? rect.h : FALLBACK_SIZE.h };
}

/** 缩放钳制。非有限值（NaN/Infinity）直接回 1——宁可回默认，也不要把画布搞成空白 */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** 屏幕像素 → 用户坐标。与 `getScreenCTM()` 等价，这里只用于锚点换算（不参与拖拽） */
export function screenToUser(rect: Size, vp: Viewport, px: Point): Point {
  const s = norm(rect);
  return { x: vp.cx + (px.x - s.w / 2) / vp.scale, y: vp.cy + (px.y - s.h / 2) / vp.scale };
}

/** 用户坐标 → 屏幕像素（写用例时用来验「锚点不动」） */
export function userToScreen(rect: Size, vp: Viewport, u: Point): Point {
  const s = norm(rect);
  return { x: s.w / 2 + (u.x - vp.cx) * vp.scale, y: s.h / 2 + (u.y - vp.cy) * vp.scale };
}

/** SVG 的 `viewBox` 字符串（宽高比 = 容器宽高比，见文件头 ★） */
export function viewBoxOf(rect: Size, vp: Viewport): string {
  const s = norm(rect);
  const w = s.w / vp.scale;
  const h = s.h / vp.scale;
  return `${r2(vp.cx - w / 2)} ${r2(vp.cy - h / 2)} ${r2(w)} ${r2(h)}`;
}

/** 初始 / 重置视口：100%，居中在内容外接矩形中心 */
export function initialViewport(bounds: Bounds): Viewport {
  return { scale: 1, cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2 };
}

/**
 * 适配窗口：内容整体（含 `FIT_MARGIN` 边距）塞进容器。
 * ★ 不放大（`Math.min(..., 1)`）：两三个步骤的流被撑成巨图比看不清更怪，
 *   而且「适配」的语义是「看全貌」，不是「尽量占满」。
 */
export function fitViewport(rect: Size, bounds: Bounds): Viewport {
  const s = norm(rect);
  const w = Math.max(1, s.w - FIT_MARGIN * 2);
  const h = Math.max(1, s.h - FIT_MARGIN * 2);
  const scale = clampZoom(Math.min(w / Math.max(1, bounds.w), h / Math.max(1, bounds.h), 1));
  return { scale, cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2 };
}

/**
 * 以屏幕上的某个像素点为锚缩放。
 * ★ 滚轮手感**全押在这一条性质上**：锚点下面的那个用户坐标，缩放前后必须贴在同一个像素上。
 *   少了这一步，滚轮会「越缩越偏」，用户想放大的地方会跑到屏幕外。
 */
export function zoomAt(rect: Size, vp: Viewport, factor: number, anchor: Point): Viewport {
  const scale = clampZoom(vp.scale * factor);
  // 已经顶到上下限：原样返回同一个对象，不产生浮点抖动（也免掉一次无意义的重渲染）
  if (scale === vp.scale) return vp;
  const s = norm(rect);
  const u = screenToUser(rect, vp, anchor);
  return { scale, cx: u.x - (anchor.x - s.w / 2) / scale, cy: u.y - (anchor.y - s.h / 2) / scale };
}

/** 按钮缩放：以视口中心为锚（中心不动，是四个方向里最可预期的一个） */
export function zoomBy(rect: Size, vp: Viewport, factor: number): Viewport {
  const s = norm(rect);
  return zoomAt(rect, vp, factor, { x: s.w / 2, y: s.h / 2 });
}

/**
 * 平移。入参是**屏幕像素**位移（鼠标往右拖 dxPx > 0，画面跟着往右走 ⇒ 视口中心往左移）。
 * ★ 除以 scale：放大到 400% 时，鼠标每移 1 像素只该走 0.25 个用户单位，否则手感是「一拖就飞」。
 */
export function panBy(vp: Viewport, dxPx: number, dyPx: number): Viewport {
  return { scale: vp.scale, cx: vp.cx - dxPx / vp.scale, cy: vp.cy - dyPx / vp.scale };
}

/**
 * 滚轮缩放倍率。
 * ★ `deltaMode` 必须折成像素：火狐与部分鼠标只给「行」（deltaMode=1，一档 deltaY=3），
 *   照像素公式算等于没反应——本仓禁止「功能存在但用户以为不存在」这类静默失效。
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const dy = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-dy * (pinch ? WHEEL_K_PINCH : WHEEL_K));
}

/** 控制条上显示的百分比（100% = 1 用户单位 1 像素） */
export function zoomPercent(vp: Viewport): number {
  return Math.round(vp.scale * 100);
}
