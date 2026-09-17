/**
 * flow-layout —— 画布几何的回归锁。
 *
 * 这组数全是**肉眼很难发现错在哪**的那类：端口挤在一起、边退化成直线、单节点画布塌掉、
 * 新节点落在画布外。所以用解析式断言（几何量能算出来就该算出来），不靠截图比对。
 */
import { describe, it, expect } from 'vitest';
import {
  CANVAS_MIN,
  CANVAS_PAD,
  GRID,
  STEP_BOX,
  contentBounds,
  edgePath,
  inputAnchor,
  nextFreeCenter,
  portAnchor,
  portClass,
  portLabel,
  snapGrid,
} from './flow-layout';

describe('snapGrid —— 拖拽吸附', () => {
  it('吸到最近的网格线', () => {
    expect(snapGrid(17)).toBe(16);
    expect(snapGrid(25)).toBe(32);
    expect(snapGrid(-9)).toBe(-16);
  });

  it('已在网格上则不动', () => {
    expect(snapGrid(64)).toBe(64);
  });

  it('网格可调（默认 16）', () => {
    expect(GRID).toBe(16);
    expect(snapGrid(7, 8)).toBe(8);
  });
});

describe('portAnchor —— 三个出口必须分开', () => {
  const c = { x: 200, y: 100 };

  it('next 在右侧居中', () => {
    expect(portAnchor(c, 'next')).toEqual({ x: c.x + STEP_BOX.w / 2, y: c.y });
  });

  it('★ correct / wrong 分别偏上偏下，彼此不重合（否则用户分不清连的是哪条分支）', () => {
    const ok = portAnchor(c, 'correct');
    const bad = portAnchor(c, 'wrong');
    expect(ok.y).toBeLessThan(c.y);
    expect(bad.y).toBeGreaterThan(c.y);
    expect(ok.y).not.toBe(bad.y);
    // 三者横向同源（都从右边出去），纵向等距
    expect(ok.x).toBe(bad.x);
    expect(c.y - ok.y).toBe(bad.y - c.y);
  });

  it('入口恒在左侧居中（一个步骤只有一个入口）', () => {
    expect(inputAnchor(c)).toEqual({ x: c.x - STEP_BOX.w / 2, y: c.y });
  });

  it('端口文案三值各不相同', () => {
    expect(new Set([portLabel('next'), portLabel('correct'), portLabel('wrong')]).size).toBe(3);
    expect(portClass('wrong')).toContain('wrong');
  });
});

describe('edgePath —— 边路径', () => {
  it('是三次贝塞尔（M + C），端点与入参一致', () => {
    const d = edgePath({ x: 10, y: 20 }, { x: 300, y: 40 });
    expect(d.startsWith('M 10 20 C ')).toBe(true);
    expect(d.endsWith('300 40')).toBe(true);
  });

  it('★ 水平距离为 0 时控制点仍有 48px 外推（否则上下相邻的边会退化成贴边的直线）', () => {
    const d = edgePath({ x: 100, y: 100 }, { x: 100, y: 300 });
    expect(d).toContain('148 100');
    expect(d).toContain('52 300');
  });

  it('回边（目标在左侧）不产生 NaN，控制点仍在正向', () => {
    const d = edgePath({ x: 400, y: 100 }, { x: 100, y: 100 });
    expect(d).not.toContain('NaN');
    expect(d.startsWith('M 400 100')).toBe(true);
  });
});

describe('contentBounds —— 画布视口', () => {
  it('没有节点：给最小画布', () => {
    const b = contentBounds([]);
    expect(b).toEqual({ x: 0, y: 0, w: CANVAS_MIN.w, h: CANVAS_MIN.h });
  });

  it('单节点：仍不小于最小画布（不许塌成一小条）', () => {
    const b = contentBounds([{ x: 100, y: 100 }]);
    expect(b.w).toBeGreaterThanOrEqual(CANVAS_MIN.w);
    expect(b.h).toBeGreaterThanOrEqual(CANVAS_MIN.h);
  });

  it('多节点：覆盖全部卡片并留出 padding', () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 900, y: 400 },
    ];
    const b = contentBounds(pts);
    expect(b.x).toBe(100 - STEP_BOX.w / 2 - CANVAS_PAD);
    expect(b.y).toBe(100 - STEP_BOX.h / 2 - CANVAS_PAD);
    expect(b.x + b.w).toBe(900 + STEP_BOX.w / 2 + CANVAS_PAD);
    expect(b.y + b.h).toBe(400 + STEP_BOX.h / 2 + CANVAS_PAD);
  });
});

describe('nextFreeCenter —— 新步骤落点', () => {
  it('空画布：给一个可用的起点', () => {
    expect(nextFreeCenter([])).toEqual({ x: 140, y: 160 });
  });

  it('★ 落在最右节点的右边、与它同排，且吸附到网格', () => {
    const p = nextFreeCenter([
      { x: 100, y: 200 },
      { x: 460, y: 88 },
    ]);
    expect(p.x).toBeGreaterThan(460);
    expect(p.y).toBe(88); // 取最右那张的 y，而不是第一张
    expect(p.x % GRID).toBe(0);
  });

  it('不与最右卡片重叠', () => {
    const right = { x: 460, y: 88 };
    const p = nextFreeCenter([right]);
    expect(p.x - right.x).toBeGreaterThan(STEP_BOX.w);
  });
});
