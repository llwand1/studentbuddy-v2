/**
 * flow-layout —— 学习流画布的**几何纯逻辑**（契约 docs/STUDY-FLOW-SPEC.md §2.4）。
 *
 * ★ 坐标口径（全仓只此一处定义，改必同步）：`FlowStepDef.position` 是**卡片中心**，不是左上角。
 *   服务端只负责「没给坐标时铺一个不重叠的值」（`80 + i*200, y=80`），
 *   它不关心画布语义 ⇒ 「中心 vs 左上角」这个决定由前端定下来并写在这里，别再散落第二处。
 *
 * ★ 为什么端口要分三个锚点：`correct`/`wrong` 是用户编排分支用的（答对走哪、答错走哪）。
 *   三个出口挤在同一个点上，用户就分不清自己连的是哪条边——分支功能等于白给。
 */
import type { FlowPort } from '@sb/shared';

/** 卡片尺寸（中心对齐） */
export const STEP_BOX = { w: 152, h: 68 } as const;

/** 拖拽吸附网格。16px 是「按 4 的倍数」这套间距体系的自然档位，比 8 更少碎位 */
export const GRID = 16;

/** 画布内容四周留白（给标签、待连线的端口、以及第一张卡片的手感留位） */
export const CANVAS_PAD = 56;

/** 画布内容区的最小尺寸（只有一两个节点时，画布不该塌成一小条） */
export const CANVAS_MIN = { w: 720, h: 360 } as const;

export interface Point {
  x: number;
  y: number;
}

/** 拖拽落点吸附：不吸附的话每次拖动都产生新坐标，落库数据会碎成任意两位小数 */
export function snapGrid(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}

/** 出口锚点：`next` 右侧居中；`correct`/`wrong` 分别偏上/偏下，让分支一眼可分 */
export function portAnchor(center: Point, port: FlowPort, box = STEP_BOX): Point {
  const x = center.x + box.w / 2;
  if (port === 'correct') return { x, y: center.y - box.h / 4 };
  if (port === 'wrong') return { x, y: center.y + box.h / 4 };
  return { x: center.x + box.w / 2, y: center.y };
}

/** 入口锚点：恒在左侧居中（一个步骤只有一个入口，不做多入口端口） */
export function inputAnchor(center: Point, box = STEP_BOX): Point {
  return { x: center.x - box.w / 2, y: center.y };
}

/**
 * 边的贝塞尔路径（SVG `d`）。
 *
 * 控制点水平外推：曲线从出口**先水平走一段**再弯向目标，这样即使目标在左上方（回边），
 * 线也不会贴着卡片边缘切过去；外推量取两点的水平距离的四成，并设 48px 下限
 * （上下相邻的两张卡片水平距离接近 0，没有下限会退化成一条直线）。
 */
export function edgePath(from: Point, to: Point): string {
  const dx = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/**
 * 全部卡片的外接矩形（含留白），用于给 SVG 定 `viewBox`。
 * 宽度/高度各自兜底到 `CANVAS_MIN`，否则单节点流会得到一块小得可怜的画布。
 */
export function contentBounds(
  centers: Point[],
  box = STEP_BOX,
  pad = CANVAS_PAD,
): { x: number; y: number; w: number; h: number } {
  if (centers.length === 0) {
    return { x: 0, y: 0, w: CANVAS_MIN.w, h: CANVAS_MIN.h };
  }
  const xs = centers.map((c) => c.x);
  const ys = centers.map((c) => c.y);
  const minX = Math.min(...xs) - box.w / 2 - pad;
  const maxX = Math.max(...xs) + box.w / 2 + pad;
  const minY = Math.min(...ys) - box.h / 2 - pad;
  const maxY = Math.max(...ys) + box.h / 2 + pad;
  return {
    x: minX,
    y: minY,
    w: Math.max(CANVAS_MIN.w, maxX - minX),
    h: Math.max(CANVAS_MIN.h, maxY - minY),
  };
}

/**
 * 在编排链尾部加一个步骤时给它落在哪。
 * 规则：找**最右侧**那张卡片，放它右边一格、与它同排（水平流向）。
 * ★ 不复制服务端那套 `80 + i*200` 的等距铺位：那是「用户没拖过」时的兜底，
 *   用户已经摆过位置之后再新加节点，按服务端公式会跳到与画布无关的地方。
 */
export function nextFreeCenter(centers: Point[], box = STEP_BOX): Point {
  const first = centers[0];
  if (!first) return { x: 140, y: 160 };
  let rightmost = first;
  for (const c of centers) if (c.x > rightmost.x) rightmost = c;
  return { x: snapGrid(rightmost.x + box.w + 72), y: rightmost.y };
}

/** 端口的中文说明（连线的下拉框、边的悬浮提示用） */
export function portLabel(port: FlowPort): string {
  if (port === 'correct') return '答对';
  if (port === 'wrong') return '答错';
  return '下一步';
}

/** 端口在边上的视觉分档 class（配色在 flow.css 按 port 分档） */
export function portClass(port: FlowPort): string {
  return `fl-port ${port}`;
}
