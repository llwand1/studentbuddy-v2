// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PixelSprite, spriteRuns } from './PixelSprite';
import { HERO_MAP, HERO_PAL } from '../app/hero/hero-sprites';

afterEach(cleanup);

const PAL = { a: '#111111', b: '#222222' };

describe('spriteRuns', () => {
  it('merges same-colour neighbours on a row into one run and keeps rows apart', () => {
    const runs = spriteRuns(['aab.', '.bbb'], PAL);
    expect(runs).toEqual([
      { x: 0, y: 0, w: 2, fill: '#111111' },
      { x: 2, y: 0, w: 1, fill: '#222222' },
      { x: 1, y: 1, w: 3, fill: '#222222' },
    ]);
  });
  it('treats dots, spaces and characters missing from the palette as transparent', () => {
    expect(spriteRuns(['. z a'], PAL)).toEqual([{ x: 4, y: 0, w: 1, fill: '#111111' }]);
    expect(spriteRuns(['....', '    '], PAL)).toEqual([]);
  });
  it('covers every painted cell of the shared hero sprite exactly once', () => {
    const painted = HERO_MAP.reduce((n, row) => n + [...row].filter((c) => c !== '.' && HERO_PAL[c]).length, 0);
    const runs = spriteRuns(HERO_MAP, HERO_PAL);
    expect(runs.reduce((n, r) => n + r.w, 0)).toBe(painted);
    expect(painted).toBeGreaterThan(50);
    // 同一行内的色块首尾相接或有空隙，绝不重叠
    for (let i = 1; i < runs.length; i += 1) {
      const prev = runs[i - 1]!;
      const cur = runs[i]!;
      if (prev.y === cur.y) expect(cur.x).toBeGreaterThanOrEqual(prev.x + prev.w);
    }
  });
});

describe('<PixelSprite>', () => {
  it('renders one crisp rect per run, sized to the map, hidden from assistive tech, colours as fill attributes', () => {
    const { container } = render(<PixelSprite map={HERO_MAP} pal={HERO_PAL} className="chat-hero-px" />);
    const svg = container.querySelector('svg.chat-hero-px');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${HERO_MAP[0]!.length} ${HERO_MAP.length}`);
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges');
    const rects = svg?.querySelectorAll('rect') ?? [];
    expect(rects).toHaveLength(spriteRuns(HERO_MAP, HERO_PAL).length);
    expect(rects[0]?.getAttribute('fill')).toMatch(/^#/);
    expect(container.querySelector('[style]')).toBeNull();
  });
});
