// @vitest-environment jsdom
/**
 * use-narrow：唯一的手机断点（契约 docs/MOBILE-SPEC.md §2）。
 * 锁三条：① 断点常量就是 700px 且与 mobile.css / pixel-shell.css 的 @media 同一个数；② 没有 matchMedia（SSR / 老 jsdom）当宽屏、不抛；
 * ③ 订阅 change：媒体查询翻转时 hook 当场更新，卸载后退订。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NARROW_QUERY, readNarrow, useNarrow } from './use-narrow';

type Listener = (e: MediaQueryListEvent) => void;
function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initial,
    media: NARROW_QUERY,
    addEventListener: (_t: string, l: Listener) => listeners.add(l),
    removeEventListener: (_t: string, l: Listener) => listeners.delete(l),
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    flip(v: boolean) {
      (mql as { matches: boolean }).matches = v;
      listeners.forEach((l) => l({ matches: v } as MediaQueryListEvent));
    },
    size: () => listeners.size,
  };
}
afterEach(() => {
  window.matchMedia = undefined as unknown as typeof window.matchMedia;
});

describe('useNarrow', () => {
  it('① 断点 700px，与 mobile.css / pixel-shell.css 的手机断点同一个数', () => {
    expect(NARROW_QUERY).toBe('(max-width: 700px)');
    const css = readFileSync(path.resolve(__dirname, '../styles/mobile.css'), 'utf8');
    const shell = readFileSync(path.resolve(__dirname, '../styles/pixel-shell.css'), 'utf8');
    expect(css).toContain('@media (max-width: 700px)');
    expect(shell).toContain('@media (max-width: 700px)');
  });

  it('② 没有 matchMedia ⇒ false，不抛', () => {
    expect(readNarrow()).toBe(false);
    const { result } = renderHook(() => useNarrow());
    expect(result.current).toBe(false);
  });

  it('③ 跟随媒体查询翻转；卸载退订', () => {
    const m = fakeMatchMedia(false);
    const { result, unmount } = renderHook(() => useNarrow());
    expect(result.current).toBe(false);
    act(() => m.flip(true));
    expect(result.current).toBe(true);
    act(() => m.flip(false));
    expect(result.current).toBe(false);
    expect(m.size()).toBe(1);
    unmount();
    expect(m.size()).toBe(0);
  });
});
