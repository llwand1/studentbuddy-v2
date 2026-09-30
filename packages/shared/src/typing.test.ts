import { describe, expect, it } from 'vitest';
import {
  TYPING_MAX_CELLS,
  cellVerdicts,
  clampTyped,
  mergeTyped,
  segmentCount,
  spellFriendly,
  typedCount,
  typedOf,
  typingCells,
} from './typing.js';

describe('typing — 打字练习式填空的口径', () => {
  it('字母 / 数字 / 汉字要打，空格与符号是固定格', () => {
    const cells = typingCells('New York-2');
    expect(cells.map((c) => c.typed)).toEqual([true, true, true, false, true, true, true, true, false, true]);
    expect(typedCount(cells)).toBe(8);
    expect(cells[3]?.seg).toBe(-1);
    expect(cells[8]?.seg).toBe(-1);
  });

  it('分段：汉字 2 字一段、字母 3 字一段、尾段只剩 1 字并入前一段', () => {
    expect(typingCells('事件循环').map((c) => c.seg)).toEqual([0, 0, 1, 1]);
    expect(typingCells('光合作用率').map((c) => c.seg)).toEqual([0, 0, 1, 1, 2]);
    // 三字汉词不并段：第一次提示只给两个字，最后一个字留给第二次
    expect(typingCells('原型链').map((c) => c.seg)).toEqual([0, 0, 1]);
    expect(typingCells('photosynthesis').map((c) => c.seg)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4]);
    expect(segmentCount(typingCells('event loop'))).toBe(3);
    expect(typingCells('event loop').map((c) => c.seg)).toEqual([0, 0, 0, 1, 1, -1, 2, 2, 2, 2]);
  });

  it('mergeTyped 把打的字放回带符号的位置：打完给整串，没打完不带尾随符号', () => {
    const cells = typingCells('C++');
    expect(mergeTyped(cells, 'C')).toBe('C++');
    const ny = typingCells('New York');
    expect(mergeTyped(ny, 'New')).toBe('New');
    expect(mergeTyped(ny, 'NewY')).toBe('New Y');
    expect(mergeTyped(ny, 'NewYork')).toBe('New York');
    expect(mergeTyped(ny, '')).toBe('');
    expect(typedOf(ny, 'New Y')).toBe('NewY');
    expect(typedOf(ny, mergeTyped(ny, 'NewYork'))).toBe('NewYork');
  });

  it('clampTyped 丢掉键入的符号、截到格数；cellVerdicts 逐格对错不分大小写', () => {
    const cells = typingCells('New York');
    expect(clampTyped(cells, 'new-yorkers')).toBe('newyork');
    expect(cellVerdicts(cells, 'nEx')).toEqual(['ok', 'ok', 'bad', null, null, null, null, null]);
  });

  it('spellFriendly：满是符号或太长的答案不适合逐格打', () => {
    expect(spellFriendly('事件循环')).toBe(true);
    expect(spellFriendly('New York')).toBe(true);
    expect(spellFriendly('C++')).toBe(false);
    expect(spellFriendly('O(n log n)')).toBe(false);
    expect(spellFriendly('')).toBe(false);
    expect(spellFriendly('a'.repeat(TYPING_MAX_CELLS))).toBe(true);
    expect(spellFriendly('a'.repeat(TYPING_MAX_CELLS + 1))).toBe(false);
  });
});
