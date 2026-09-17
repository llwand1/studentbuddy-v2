/**
 * flow-viewport —— 画布视口（缩放/平移）几何的回归锁。
 *
 * 这组全是**肉眼极难定位**的错误：滚轮「越缩越偏」、放大后一拖就飞、内容缩成一个点、
 * viewBox 与容器宽高比不等导致拖拽整体偏移（最阴的一条——画布看着正常，就是拖不准）。
 * 所以一律用解析式断言，不做截图比对。
 */
import { describe, it, expect } from 'vitest';
import {
  FIT_MARGIN,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  fitViewport,
  initialViewport,
  panBy,
  screenToUser,
  userToScreen,
  viewBoxOf,
  wheelFactor,
  zoomAt,
  zoomBy,
  zoomPercent,
  type Bounds,
  type Size,
  type Viewport,
} from './flow-viewport';

const RECT: Size = { w: 800, h: 420 };
const BOUNDS: Bounds = { x: 100, y: 60, w: 600, h: 300 };
const centered: Viewport = { scale: 1, cx: 400, cy: 210 };

/**
 * 拆 viewBox 字符串。
 * ★ 不用解构 + `!`：本仓 `noUncheckedIndexedAccess` 下下标访问是 `number | undefined`，
 *   而「越界就默认 0」会把「返回了一堆垃圾」伪装成「值恰好是 0」——这里直接抛，让失败长在正确的用例上。
 */
function parseViewBox(s: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = s.trim().split(/\s+/).map(Number);
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    throw new Error(`viewBox 应含 4 个数字，实得「${s}」`);
  }
  return { x, y, w, h };
}

describe('clampZoom —— 缩放上下限', () => {
  it('钳到 [0.2, 4]', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(12)).toBe(ZOOM_MAX);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it('非有限值回 1（宁可回默认，也不能把画布算成空白）', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('initialViewport —— 默认 100% 居中', () => {
  it('缩放为 1、中心等于内容外接矩形中心', () => {
    expect(initialViewport(BOUNDS)).toEqual({ scale: 1, cx: 400, cy: 210 });
  });

  it('★ 默认不缩放：老板要的是「看得清」，全貌交给适配按钮', () => {
    expect(initialViewport({ x: 0, y: 0, w: 4000, h: 3000 }).scale).toBe(1);
  });
});

describe('屏幕 ↔ 用户坐标换算', () => {
  it('中心点互为原点，往返一致', () => {
    const vp: Viewport = { scale: 2, cx: 400, cy: 210 };
    expect(screenToUser(RECT, vp, { x: 400, y: 210 })).toEqual({ x: 400, y: 210 });
    const u = { x: 733, y: -18 };
    const back = screenToUser(RECT, vp, userToScreen(RECT, vp, u));
    expect(back.x).toBeCloseTo(u.x, 6);
    expect(back.y).toBeCloseTo(u.y, 6);
  });

  it('缩放 2 时，屏幕上 1 像素 = 0.5 用户单位', () => {
    const vp: Viewport = { scale: 2, cx: 0, cy: 0 };
    expect(screenToUser(RECT, vp, { x: 401, y: 210 }).x).toBeCloseTo(0.5, 6);
  });
});

describe('zoomAt —— 锚点不动（滚轮手感全在这一条）', () => {
  const anchors = [
    { x: 0, y: 0 },
    { x: 800, y: 420 },
    { x: 137, y: 389 },
    { x: 400, y: 210 },
  ];

  it.each(anchors)('放大后锚点下的用户坐标仍贴在原像素 %o', (anchor) => {
    const before = screenToUser(RECT, centered, anchor);
    const next = zoomAt(RECT, centered, 1.3, anchor);
    const after = userToScreen(RECT, next, before);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it.each(anchors)('缩小后同样不偏 %o', (anchor) => {
    const vp: Viewport = { scale: 3, cx: 1200, cy: -80 };
    const before = screenToUser(RECT, vp, anchor);
    const next = zoomAt(RECT, vp, 1 / 1.3, anchor);
    const after = userToScreen(RECT, next, before);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it('缩放值按因子相乘', () => {
    expect(zoomAt(RECT, centered, 2, { x: 0, y: 0 }).scale).toBe(2);
  });

  it('顶到上下限时原样返回同一个对象（避免浮点抖动与无意义重渲染）', () => {
    const maxed: Viewport = { scale: ZOOM_MAX, cx: 0, cy: 0 };
    expect(zoomAt(RECT, maxed, 2, { x: 10, y: 10 })).toBe(maxed);
    const minned: Viewport = { scale: ZOOM_MIN, cx: 0, cy: 0 };
    expect(zoomAt(RECT, minned, 0.5, { x: 10, y: 10 })).toBe(minned);
  });
});

describe('zoomBy —— 按钮缩放以视口中心为锚', () => {
  it('中心点下的用户坐标不动', () => {
    const before = screenToUser(RECT, centered, { x: RECT.w / 2, y: RECT.h / 2 });
    const next = zoomBy(RECT, centered, 1.2);
    const after = userToScreen(RECT, next, before);
    expect(after.x).toBeCloseTo(RECT.w / 2, 6);
    expect(after.y).toBeCloseTo(RECT.h / 2, 6);
  });
});

describe('panBy —— 平移', () => {
  it('往右拖，视口中心往左移（画面跟着鼠标走）', () => {
    const next = panBy(centered, 100, -40);
    expect(next.cx).toBe(300);
    expect(next.cy).toBe(250);
    expect(next.scale).toBe(1);
  });

  it('★ 位移要除以 scale：放大到 4 倍时，鼠标移 1px 只走 0.25 用户单位', () => {
    const next = panBy({ scale: 4, cx: 0, cy: 0 }, 100, 100);
    expect(next.cx).toBe(-25);
    expect(next.cy).toBe(-25);
  });
});

describe('viewBoxOf —— 与容器严格同宽高比（拖拽准不准看这条）', () => {
  it('宽高 = 容器 / scale，中心落在 (cx, cy)', () => {
    const { x, y, w, h } = parseViewBox(viewBoxOf(RECT, { scale: 2, cx: 400, cy: 210 }));
    expect(w).toBeCloseTo(400, 6);
    expect(h).toBeCloseTo(210, 6);
    expect(x).toBeCloseTo(200, 6);
    expect(y).toBeCloseTo(105, 6);
  });

  it.each([0.2, 0.5, 1, 1.7, 4])('scale=%s 时宽高比恒等于容器宽高比（2 位小数舍入内）', (scale) => {
    const { w, h } = parseViewBox(viewBoxOf(RECT, { scale, cx: 0, cy: 0 }));
    // viewBox 数字收敛到 2 位小数（见 flow-viewport 的 r2），所以留 1e-4 的余量；
    // 这一点的失配折算到屏幕上不到 0.001px，对 getScreenCTM 的拖拽换算无影响
    expect(Math.abs(w / h - RECT.w / RECT.h)).toBeLessThan(1e-4);
  });

  it('宽度不同的容器也各自吻合（防写死 800×420）', () => {
    const rect: Size = { w: 1231, h: 640 };
    const { w, h } = parseViewBox(viewBoxOf(rect, { scale: 1.5, cx: 0, cy: 0 }));
    expect(Math.abs(w - 1231 / 1.5)).toBeLessThan(0.01);
    expect(Math.abs(h - 640 / 1.5)).toBeLessThan(0.01);
  });

  it('容器还没量到尺寸时回落到兜底尺寸，不产生 0×0 的退化 viewBox', () => {
    const { w, h } = parseViewBox(viewBoxOf({ w: 0, h: 0 }, centered));
    expect(w).toBe(800);
    expect(h).toBe(420);
  });

  it('输出固定 4 个数字、且已收敛到 2 位小数（平移不抖噪声）', () => {
    const parts = viewBoxOf(RECT, { scale: 3, cx: 1000 / 3, cy: 7 / 3 }).split(' ');
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p).toMatch(/^-?\d+(\.\d{1,2})?$/);
  });
});

describe('fitViewport —— 适配窗口', () => {
  it('大内容缩到装得下（含边距）', () => {
    const big: Bounds = { x: 0, y: 0, w: 2000, h: 1000 };
    const vp = fitViewport(RECT, big);
    expect(vp.scale).toBeLessThan(1);
    expect(big.w * vp.scale).toBeLessThanOrEqual(RECT.w - FIT_MARGIN * 2 + 1e-6);
    expect(big.h * vp.scale).toBeLessThanOrEqual(RECT.h - FIT_MARGIN * 2 + 1e-6);
  });

  it('中心对齐内容中心', () => {
    const vp = fitViewport(RECT, BOUNDS);
    expect(vp.cx).toBe(400);
    expect(vp.cy).toBe(210);
  });

  it('★ 不放大：两三个步骤的小图保持 100%（撑成巨图比看不清更怪）', () => {
    expect(fitViewport(RECT, { x: 0, y: 0, w: 160, h: 80 }).scale).toBe(1);
  });

  it('超大内容也守住下限，不会缩成一个点', () => {
    expect(fitViewport(RECT, { x: 0, y: 0, w: 100000, h: 100000 }).scale).toBe(ZOOM_MIN);
  });

  it('空内容（宽高为 0）不产生除零', () => {
    const vp = fitViewport(RECT, { x: 0, y: 0, w: 0, h: 0 });
    expect(Number.isFinite(vp.scale)).toBe(true);
    expect(vp.scale).toBe(1);
  });
});

describe('wheelFactor —— 滚轮倍率', () => {
  it('往下滚（deltaY > 0）＝缩小，往上滚＝放大', () => {
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
  });

  it('对称：反向滚同样的量能回到原位', () => {
    expect(wheelFactor(100, 0, false) * wheelFactor(-100, 0, false)).toBeCloseTo(1, 9);
  });

  it('★ deltaMode=1（行）要折成像素：火狐一档只给 deltaY=3，照像素算等于没反应', () => {
    // 同为 deltaY=3：按像素算只变 0.4%（用户感知不到，会以为滚轮坏了）；按行算（×16）变 7%
    expect(1 - wheelFactor(3, 0, false)).toBeLessThan(0.01);
    expect(1 - wheelFactor(3, 1, false)).toBeGreaterThan(0.05);
  });

  it('触控板 pinch（ctrlKey）比滚轮更跟手', () => {
    expect(1 - wheelFactor(20, 0, true)).toBeGreaterThan(1 - wheelFactor(20, 0, false));
  });
});

describe('zoomPercent —— 控制条显示', () => {
  it('1 = 100%，0.866 显示 87%', () => {
    expect(zoomPercent({ scale: 1, cx: 0, cy: 0 })).toBe(100);
    expect(zoomPercent({ scale: 0.866, cx: 0, cy: 0 })).toBe(87);
  });
});
