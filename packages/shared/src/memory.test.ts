/**
 * shared/memory 契约层单测：类别白名单、归一函数的边界、常量不变式。
 *
 * 只钉**两侧共用的判定**——切点/淘汰/协议解析那些服务端逻辑在
 * `server/src/chat/compact.test.ts` 与 `memory.test.ts` 里测，不在此重复。
 */
import { describe, it, expect } from 'vitest';
import {
  MEMORY_CONTENT_MAX,
  MEMORY_INJECT_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_MAX_ITEMS,
  MEMORY_MIN_IMPORTANCE,
  isMemoryKind,
  normalizeImportance,
  normalizeMemoryContent,
} from './memory.js';

describe('isMemoryKind（白名单）', () => {
  it('四个合法类别都认', () => {
    for (const k of MEMORY_KINDS) expect(isMemoryKind(k)).toBe(true);
  });

  it('非法值一律 false（**不回落成某一类**——猜错的类别比没类别更糟）', () => {
    for (const v of ['nonsense', '', 'Profile', 'PROFILE', null, undefined, 42, {}]) {
      expect(isMemoryKind(v)).toBe(false);
    }
  });
});

describe('normalizeImportance（逐字段归一，不作废整条）', () => {
  it('非数字 → 0.5', () => {
    expect(normalizeImportance(Number.NaN)).toBe(0.5);
    expect(normalizeImportance('高')).toBe(0.5);
    expect(normalizeImportance(undefined)).toBe(0.5);
  });

  it('★ 空值（null / 空白串）回落 0.5 而**不是 0**', () => {
    // `Number(null) === 0`、`Number('') === 0`——直接过 Number() 会把「模型没给字段」
    // 变成「最不重要」，那条记忆会被淘汰且永不注入（实测踩到，不是纸上推演）
    expect(normalizeImportance(null)).toBe(0.5);
    expect(normalizeImportance('')).toBe(0.5);
    expect(normalizeImportance('   ')).toBe(0.5);
  });

  it('越界 → clamp 到 [0,1]', () => {
    expect(normalizeImportance(99)).toBe(1);
    expect(normalizeImportance(-3)).toBe(0);
  });

  it('数字字符串按数字解（模型常给 "0.7" 这种）', () => {
    expect(normalizeImportance('0.7')).toBe(0.7);
  });

  it('区间内的数原样保留', () => {
    expect(normalizeImportance(0.35)).toBe(0.35);
  });
});

describe('normalizeMemoryContent', () => {
  it('压平换行与连续空白、去首尾（注入段按行排版，内容里不能有换行）', () => {
    expect(normalizeMemoryContent('  喜欢\n先看   例子  ')).toBe('喜欢 先看 例子');
  });

  it('非字符串 → 空串（调用方据此丢弃该条）', () => {
    expect(normalizeMemoryContent(undefined)).toBe('');
    expect(normalizeMemoryContent(123)).toBe('');
  });

  it('超长按 MEMORY_CONTENT_MAX 截断而不是丢弃', () => {
    expect(normalizeMemoryContent('字'.repeat(MEMORY_CONTENT_MAX + 100)).length).toBe(MEMORY_CONTENT_MAX);
  });
});

describe('常量不变式（改这些数要连带想清楚，不是随手调）', () => {
  it('注入上限必须装得下若干条完整记忆，否则一条都注入不了', () => {
    expect(MEMORY_INJECT_MAX_CHARS).toBeGreaterThan(MEMORY_CONTENT_MAX);
  });

  it('门槛落在 (0,1) 开区间——等于 1 就只剩满分记忆能注入，等于关掉了', () => {
    expect(MEMORY_MIN_IMPORTANCE).toBeGreaterThan(0);
    expect(MEMORY_MIN_IMPORTANCE).toBeLessThan(1);
  });

  it('容量上限为正', () => {
    expect(MEMORY_MAX_ITEMS).toBeGreaterThan(0);
  });
});
