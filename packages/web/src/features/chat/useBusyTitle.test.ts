// @vitest-environment jsdom
/**
 * useBusyTitle：生成中标题带「● 回复中」；后台标签页里完成 ⇒ 「✓ 回答完成」直到切回来。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useBusyTitle, BUSY_PREFIX, DONE_PREFIX, stripTitlePrefix } from './useBusyTitle';

let hidden = false;
beforeEach(() => {
  hidden = false;
  document.title = 'StudentBuddy';
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  hidden = false;
});

const mount = (busy: boolean) => renderHook(({ b }) => useBusyTitle(b), { initialProps: { b: busy } });

describe('useBusyTitle', () => {
  it('不忙时挂载不碰标题', () => {
    mount(false);
    expect(document.title).toBe('StudentBuddy');
  });

  it('忙 ⇒ 前缀「● 回复中」；前台完成 ⇒ 复原', () => {
    const { rerender } = mount(false);
    rerender({ b: true });
    expect(document.title).toBe(`${BUSY_PREFIX}StudentBuddy`);
    rerender({ b: false });
    expect(document.title).toBe('StudentBuddy');
  });

  it('后台完成 ⇒ 「✓ 回答完成」，切回前台（visibilitychange）才复原', () => {
    const { rerender } = mount(true);
    hidden = true;
    rerender({ b: false });
    expect(document.title).toBe(`${DONE_PREFIX}StudentBuddy`);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange')); // 仍在后台：不复原
    });
    expect(document.title).toBe(`${DONE_PREFIX}StudentBuddy`);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(document.title).toBe('StudentBuddy');
  });

  it('「完成」态还挂着就又开始忙：直接换成「回复中」，不叠前缀', () => {
    const { rerender } = mount(true);
    hidden = true;
    rerender({ b: false });
    rerender({ b: true });
    expect(document.title).toBe(`${BUSY_PREFIX}StudentBuddy`);
    hidden = false;
    rerender({ b: false });
    expect(document.title).toBe('StudentBuddy');
  });

  it('忙态中途卸载（切页）⇒ 标题复原，不把「回复中」留给别的页面', () => {
    const { unmount } = mount(true);
    expect(document.title).toBe(`${BUSY_PREFIX}StudentBuddy`);
    unmount();
    expect(document.title).toBe('StudentBuddy');
  });

  it('stripTitlePrefix 只剥本 hook 加过的前缀', () => {
    expect(stripTitlePrefix(`${BUSY_PREFIX}X`)).toBe('X');
    expect(stripTitlePrefix(`${DONE_PREFIX}X`)).toBe('X');
    expect(stripTitlePrefix('● 别的 · X')).toBe('● 别的 · X');
  });
});
