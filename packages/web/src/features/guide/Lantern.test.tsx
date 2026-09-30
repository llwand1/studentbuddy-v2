// @vitest-environment jsdom
/**
 * Lantern 单测：提灯点阵与外壳（同 Mascot 的点阵校验思路）。
 *
 * 锁四条：
 *  ① `lanternSpriteErrors()` 为空：每行 16 宽、共 16 行、字母都登记了类名、火苗只压在灯罩玻璃上（点歪一格就红）；
 *  ② 渲染：一个 16×16 的 svg，灯体 + 两帧火苗各成一组，全是 `rect`、零图片资源；
 *  ③ 三个状态只换外层类名（静 / 亮 / 开），组件不懂「为什么亮」；默认 idle；整个图标对读屏隐藏；
 *  ④ ★ CSS 对得上：点阵用到的每个类名在 `guide.css` 里都有 `fill`，并且火苗两帧的交替动画与「默认第二帧隐藏」都在
 *     ——减动效时 pixel-ui 会关掉全站动画，这两条是「默认态即终态」的前提。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lantern } from './Lantern';
import { BODY, FLAME_A, FLAME_B, LEGEND, SIZE, lanternSpriteErrors } from './lantern-sprite';

afterEach(cleanup);

describe('点阵', () => {
  it('① 没有任何格位错误', () => {
    expect(lanternSpriteErrors()).toEqual([]);
    expect(SIZE).toBe(16);
  });

  it('① 校验器自己会红：火苗画到金属框上 / 字母没登记 / 宽度不对，都被点名', () => {
    const bad = [...FLAME_A];
    bad[7] = 'R...............'; // 第 7 行第 0 格：BODY 那里是空白 '.'
    const probe = (rows: string[]): string[] => {
      const errs: string[] = [];
      rows.forEach((row, y) => {
        if (row.length !== SIZE) errs.push(`宽 ${y}`);
        row.split('').forEach((ch, x) => {
          if (ch === '.') return;
          if (!LEGEND[ch]) errs.push(`字母 ${ch}`);
          const under = BODY[y]?.[x] ?? '.';
          if (under !== 'G' && under !== 'g') errs.push(`压在非玻璃 ${y},${x}`);
        });
      });
      return errs;
    };
    expect(probe(FLAME_A)).toEqual([]);
    expect(probe(bad)).toEqual(['压在非玻璃 7,0']);
    expect(probe(['Z'.padEnd(16, '.')])).toEqual(['字母 Z', '压在非玻璃 0,0']);
    expect(probe(['..'])).toEqual(['宽 0']);
  });

  it('两帧火苗的形状不同（否则「闪」是假的）但像素数一样（火苗大小不跳）', () => {
    expect(FLAME_A).not.toEqual(FLAME_B);
    const count = (rows: string[]): number => rows.join('').replace(/\./g, '').length;
    expect(count(FLAME_A)).toBe(count(FLAME_B));
  });
});

describe('渲染', () => {
  it('② 一个 16×16 svg：灯体 + 两帧火苗，全是 rect', () => {
    const { container } = render(<Lantern />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(container.querySelectorAll('svg > rect').length).toBeGreaterThan(20);
    expect(container.querySelectorAll('.lantern-flame-a rect').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.lantern-flame-b rect').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('image, img, path')).toHaveLength(0);
  });

  it('③ 三个状态只换类名；默认 idle；对读屏隐藏', () => {
    const { container, rerender } = render(<Lantern />);
    const root = (): Element => container.firstElementChild as Element;
    expect(root().className).toBe('lantern lantern--idle');
    expect(root().getAttribute('aria-hidden')).toBe('true');
    rerender(<Lantern state="lit" />);
    expect(root().className).toBe('lantern lantern--lit');
    rerender(<Lantern state="open" />);
    expect(root().className).toBe('lantern lantern--open');
  });
});

describe('④ CSS 对得上', () => {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'guide.css'), 'utf8');

  it('点阵图例里的每个类名都有 fill 规则', () => {
    for (const cls of Object.values(LEGEND)) {
      expect(css, cls).toMatch(new RegExp(`\\.lantern-px \\.${cls}\\s*\\{[^}]*fill:`));
    }
  });

  it('火苗：第二帧默认隐藏、两帧交替都用 steps()（默认态即终态，像素风不用缓动）', () => {
    expect(css).toMatch(/\.lantern-flame-b\s*\{\s*opacity:\s*0;/);
    expect(css).toMatch(/@keyframes lt-flame-a/);
    expect(css).toMatch(/@keyframes lt-flame-b/);
    const animations = css.match(/animation:[^;]+;/g) ?? [];
    for (const a of animations) {
      // 只允许 steps(…) 计时，或者只有 animation-duration 的覆盖（那条不带计时函数）
      expect(a, a).toMatch(/steps\(|sb-rise-in/);
    }
  });
});
