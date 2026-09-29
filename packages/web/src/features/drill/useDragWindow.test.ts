/**
 * useDragWindow 纯函数回归锁（契约 docs/WAIT-DRILL-SPEC.md §5.6）：
 * 限位——窗至少留 MIN_VISIBLE 像素在视口内、顶边不越出；居中——顶部至少留 12px；窄屏断点常量与 CSS 一致。
 */
import { describe, it, expect } from 'vitest';
import { MIN_VISIBLE, SHEET_MEDIA, centeredPos, clampWindowPos } from './useDragWindow';

const size = { w: 560, h: 500 };
const view = { w: 1440, h: 900 };

describe('clampWindowPos', () => {
  it('视口内原样（取整）', () => {
    expect(clampWindowPos({ x: 100.4, y: 50.6 }, size, view)).toEqual({ x: 100, y: 51 });
  });
  it('左拖到只剩 MIN_VISIBLE，右拖到左边留 MIN_VISIBLE；顶边不越出，下拖到只剩 MIN_VISIBLE', () => {
    expect(clampWindowPos({ x: -9999, y: -50 }, size, view)).toEqual({ x: MIN_VISIBLE - size.w, y: 0 });
    expect(clampWindowPos({ x: 9999, y: 9999 }, size, view)).toEqual({ x: view.w - MIN_VISIBLE, y: view.h - MIN_VISIBLE });
  });
  it('视口比窗还小（极窄）也不会算出负的上限', () => {
    expect(clampWindowPos({ x: 300, y: 300 }, size, { w: 40, h: 40 })).toEqual({ x: 0, y: 0 });
  });
});

describe('centeredPos', () => {
  it('居中；窗比视口高时顶部留 12px 而不是负数', () => {
    expect(centeredPos(size, view)).toEqual({ x: 440, y: 200 });
    expect(centeredPos({ w: 560, h: 2000 }, view)).toEqual({ x: 440, y: 12 });
  });
});

it('窄屏断点与 drill.css 一致', () => {
  expect(SHEET_MEDIA).toBe('(max-width: 640px)');
});
