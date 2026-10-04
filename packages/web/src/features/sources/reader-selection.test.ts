// @vitest-environment jsdom
/**
 * reader-selection：选区读取与浮条夹取（契约 `docs/SOURCE-TRACE-SPEC.md` §14.3）。
 *
 * ★ 诚实的覆盖边界：jsdom **没有布局引擎**，`Range.getBoundingClientRect()` 恒为全 0，
 *   `document.getSelection()` 的行为也与真实浏览器有差。所以"拖选一段文字能不能正确拿到
 *   起止块"这件事**这里测不了**，只能靠人眼验收——登记为欠账，不假装已覆盖。
 *   本文件钉的是两件 jsdom 能可靠回答的事：
 *     ① 没有选区 / 选区塌缩 / root 为空时**一律返回 null**（否则浮条会在没选中时冒出来）；
 *     ② `clampToolbar` 的夹取数学——浮条不能飘出视口，下方放不下要翻到上方。
 */
import { describe, expect, it } from 'vitest';
import { clampToolbar, readReaderSelection } from './reader-selection';

describe('readReaderSelection：没选中就不该亮', () => {
  it('root 为 null ⇒ null', () => {
    expect(readReaderSelection(null)).toBeNull();
  });

  it('没有选区 ⇒ null', () => {
    document.getSelection()?.removeAllRanges();
    const root = document.createElement('div');
    root.innerHTML = '<p data-rb="b0">一些文字</p>';
    document.body.appendChild(root);
    expect(readReaderSelection(root)).toBeNull();
    root.remove();
  });

  it('选区塌缩（只是点了一下）⇒ null', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p data-rb="b0">一些文字</p>';
    document.body.appendChild(root);
    const sel = document.getSelection();
    const range = document.createRange();
    const node = root.querySelector('p')?.firstChild;
    if (node) {
      range.setStart(node, 2);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    expect(readReaderSelection(root)).toBeNull();
    root.remove();
  });
});

describe('clampToolbar：浮条不许飘出视口', () => {
  const VW = 1000;
  const VH = 800;

  it('正常位置：横向居中不动，纵向落在选区下方', () => {
    expect(clampToolbar(500, 300, VW, VH)).toEqual({ x: 500, y: 308 });
  });

  it('贴左边 ⇒ 右推到半宽 + 8', () => {
    expect(clampToolbar(10, 300, VW, VH).x).toBe(118);
  });

  it('贴右边 ⇒ 左推，保证整条在视口内', () => {
    expect(clampToolbar(995, 300, VW, VH).x).toBe(VW - 110 - 8);
  });

  it('贴底 ⇒ 翻到选区上方（下方放不下）', () => {
    const { y } = clampToolbar(500, VH - 10, VW, VH);
    expect(y).toBeLessThan(VH - 10);
  });

  it('极窄视口也不会算出负坐标', () => {
    const { x, y } = clampToolbar(5, 5, 100, 60);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
