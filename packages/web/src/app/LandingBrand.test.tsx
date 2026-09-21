// @vitest-environment jsdom
/**
 * LandingBrand.test — 顶栏品牌牌打字机的回归锁（2026-09-21 品牌牌打字机批）。
 *
 * ★ 锁什么：① 打字**矩阵**（哪一格出几个字，纯函数 `typedAt`）；
 *   ② 光标用的是**产品那个类**（`.chat-caret`），且它会跟着往下走（名字打完挪到副标题）；
 *   ③ 减速设置下**直接落终态**、且**一个计时器都不挂**；
 *   ④ 副标题那一行**从第一帧就占着位**（不许等它出现才长高）。
 *
 * ★ 刻意不锁：字号/字重（CSS 值 jsdom 读不到，它是样式不是行为，真机截图核）、
 *   顶栏总高度「全程不变」（同上——但这两条对应的真实风险是「换字时整页被推一下」，
 *   在 jsdom 里能锁的只有④那条结构面，故④必须留着）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { LandingBrand, TOTAL_TICKS, typedAt } from './LandingBrand';
import { BRAND_NAME, BRAND_TAGLINE } from '../lib/brand';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * 逐格推进假时钟。★ 不能一次 `advanceTimersByTime(70 * n)` 了事：下一格的表是在
 * React 提交上一次更新之后才挂的，一次推到底只会烧掉**第一格**（实测就是这样：
 * 推 70*24 之后名字只出到 'st'）。每一格用一次 `act` 夹住，提交与挂表才会交替发生。
 */
function advance(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    act(() => {
      vi.advanceTimersByTime(70);
    });
  }
}

/** 把 matchMedia 换成「要求减少动态效果」，返回还原函数 */
function stubReduceMotion(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe('LandingBrand — 打字矩阵（纯函数）', () => {
  it('名字先满、停 4 格、副标题再满；过头了不再涨', () => {
    expect(typedAt(1)).toEqual({ name: 1, tag: 0 });
    expect(typedAt(BRAND_NAME.length)).toEqual({ name: BRAND_NAME.length, tag: 0 });
    // 停格期间名字已满、副标题仍是 0（这 4 格就是「一口气连打」与「分主次」的差别）
    expect(typedAt(BRAND_NAME.length + 4)).toEqual({ name: BRAND_NAME.length, tag: 0 });
    expect(typedAt(BRAND_NAME.length + 5)).toEqual({ name: BRAND_NAME.length, tag: 1 });
    expect(typedAt(TOTAL_TICKS)).toEqual({ name: BRAND_NAME.length, tag: BRAND_TAGLINE.length });
    expect(typedAt(TOTAL_TICKS + 9)).toEqual({ name: BRAND_NAME.length, tag: BRAND_TAGLINE.length });
  });

  it('总格数就是两段字加停格（少了会把尾巴截掉，多了会多打 4 格空转）', () => {
    expect(TOTAL_TICKS).toBe(BRAND_NAME.length + 4 + BRAND_TAGLINE.length);
  });
});

describe('LandingBrand — 挂载与推进', () => {
  it('第一帧：名字已经出一个字、副标题行**已在位**但还空着、光标在名字行', () => {
    vi.useFakeTimers();
    const { container } = render(<LandingBrand />);
    expect(container.querySelector('.landing-brand-name')?.textContent).toBe(BRAND_NAME.slice(0, 1));
    // ★ 占位那一行：元素必须在（landing.css 靠 min-height 撑住它的高度）
    const tag = container.querySelector('.landing-brand-tag');
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe('');
    // ★ 光标是产品的流式光标类，不是落地页自绘的第二个
    expect(container.querySelector('.landing-brand-name .chat-caret')).not.toBeNull();
    expect(container.querySelector('.landing-brand-tag .chat-caret')).toBeNull();
  });

  it('光标跟着打字走：名字打完挪到副标题行，两行都打完就摘掉（产品里流式结束也摘）', () => {
    vi.useFakeTimers();
    const { container } = render(<LandingBrand />);
    advance(BRAND_NAME.length - 1);
    expect(container.querySelector('.landing-brand-name')?.textContent).toBe(BRAND_NAME);
    expect(container.querySelector('.landing-brand-name .chat-caret')).toBeNull();
    expect(container.querySelector('.landing-brand-tag .chat-caret')).not.toBeNull();

    advance(TOTAL_TICKS - BRAND_NAME.length);
    expect(container.querySelector('.landing-brand-name')?.textContent).toBe(BRAND_NAME);
    expect(container.querySelector('.landing-brand-tag')?.textContent).toBe(BRAND_TAGLINE);
    expect(container.querySelector('.chat-caret')).toBeNull();
  });

  it('打完就**不再挂表**：不是靠收尾清一次，而是到点不再排下一个', () => {
    vi.useFakeTimers();
    render(<LandingBrand />);
    advance(TOTAL_TICKS + 20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('两行文案取自 lib/brand.ts（与产品侧栏 logo 同一对常量，不是在这里另抄一遍）', () => {
    vi.useFakeTimers();
    const { container } = render(<LandingBrand />);
    advance(TOTAL_TICKS);
    expect(container.querySelector('.landing-brand-name')?.textContent).toBe(BRAND_NAME);
    expect(container.querySelector('.landing-brand-tag')?.textContent).toBe(BRAND_TAGLINE);
  });
});

describe('LandingBrand — 减少动态效果', () => {
  it('直接落**终态**（不是空白、也不是停在第一格），且一个计时器都不挂', () => {
    const restore = stubReduceMotion();
    try {
      vi.useFakeTimers();
      const { container } = render(<LandingBrand />);
      expect(container.querySelector('.landing-brand-name')?.textContent).toBe(BRAND_NAME);
      expect(container.querySelector('.landing-brand-tag')?.textContent).toBe(BRAND_TAGLINE);
      expect(container.querySelector('.chat-caret')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      const before = container.innerHTML;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(container.innerHTML).toBe(before);
    } finally {
      restore();
    }
  });
});
