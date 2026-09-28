// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PixelSpriteDefs, PixelSpriteUse, spriteRuns } from './PixelSprite';
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

describe('<PixelSpriteDefs> + <PixelSpriteUse>', () => {
  it('defines the sprite once as a zero-size, hidden <symbol>: one crisp rect per run, colours as fill attributes', () => {
    const { container } = render(<PixelSpriteDefs id="t-hero" map={HERO_MAP} pal={HERO_PAL} />);
    const defs = container.querySelector('svg.px-sprite-defs');
    expect(defs?.getAttribute('aria-hidden')).toBe('true');
    const sym = defs?.querySelector('symbol#t-hero');
    expect(sym?.getAttribute('viewBox')).toBe(`0 0 ${HERO_MAP[0]!.length} ${HERO_MAP.length}`);
    expect(sym?.getAttribute('shape-rendering')).toBe('crispEdges');
    const rects = sym?.querySelectorAll('rect') ?? [];
    expect(rects).toHaveLength(spriteRuns(HERO_MAP, HERO_PAL).length);
    expect(rects[0]?.getAttribute('fill')).toMatch(/^#/);
    expect(container.querySelector('[style]')).toBeNull();
  });
  it('each use is two nodes pointing at that symbol — no rect copies, hidden from assistive tech', () => {
    const { container } = render(
      <>
        <PixelSpriteDefs id="t-hero" map={HERO_MAP} pal={HERO_PAL} />
        <PixelSpriteUse id="t-hero" className="chat-hero-px" />
        <PixelSpriteUse id="t-hero" className="chat-hero-px" />
      </>,
    );
    const uses = container.querySelectorAll('svg.chat-hero-px');
    expect(uses).toHaveLength(2);
    uses.forEach((svg) => {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.children).toHaveLength(1);
      expect(svg.querySelector('use')?.getAttribute('href')).toBe('#t-hero');
      expect(svg.querySelectorAll('rect')).toHaveLength(0);
    });
    expect(container.querySelectorAll('symbol#t-hero')).toHaveLength(1);
  });
});
