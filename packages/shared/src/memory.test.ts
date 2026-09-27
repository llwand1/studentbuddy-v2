/**
 * shared/memory 契约层单测：类别白名单、归一函数的边界、常量不变式。
 *
 * 只钉**两侧共用的判定**——切点/淘汰/协议解析那些服务端逻辑在
 * `server/src/chat/compact.test.ts` 与 `memory.test.ts` 里测，不在此重复。
 */
import { describe, it, expect } from 'vitest';
import {
  MEMORY_CONTENT_MAX,
  MEMORY_DIGEST_FULL_MENTIONS,
  MEMORY_DIGEST_MIN_IMPORTANCE,
  MEMORY_DIGEST_TOP_DOMAINS,
  MEMORY_DIGEST_TOP_TERMS,
  MEMORY_INJECT_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_MAX_ITEMS,
  MEMORY_MIN_IMPORTANCE,
  isMemoryKind,
  mentionsToImportance,
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

/**
 * 提及次数 → `importance`（契约 `docs/MEMORY-TREND-SPEC.md` §3）。
 * 这是「长期记忆要根据词条库使用次数改变」的**可执行含义**：不是让模型再总结一遍，
 * 而是把这个**行为数字**直接映射成权重，故它必须是**单调、有界、饱和**的。
 */
describe('mentionsToImportance（提及次数 → importance）', () => {
  it('0 与负数一律 0——**0 表示「不构成偏好」**，调用方应据此丢弃该条而不是写一条 0 分记忆', () => {
    expect(mentionsToImportance(0)).toBe(0);
    expect(mentionsToImportance(-5)).toBe(0);
  });

  it('非有限数一律 0（宁可少一条，也不写一条算不出强度的记忆）', () => {
    expect(mentionsToImportance(NaN)).toBe(0);
    expect(mentionsToImportance(Infinity)).toBe(0);
  });

  it('单调：提及越多分越高', () => {
    const seq = [1, 2, 5, 10, 29].map(mentionsToImportance);
    // 不用 `!` 非空断言（仓库禁用）：`?? 0` 兜住索引越界，比较本身照旧成立
    expect(seq.every((v, i) => i === 0 || v > (seq[i - 1] ?? 0))).toBe(true);
  });

  it('**饱和**：达到 MEMORY_DIGEST_FULL_MENTIONS 即满分，再多也不涨', () => {
    expect(mentionsToImportance(MEMORY_DIGEST_FULL_MENTIONS)).toBe(1);
    expect(mentionsToImportance(MEMORY_DIGEST_FULL_MENTIONS * 1000)).toBe(1);
  });

  it('★ 下限必须够得到注入门槛——低门槛就白写：不注入、还占 MEMORY_MAX_ITEMS 的名额', () => {
    expect(MEMORY_DIGEST_MIN_IMPORTANCE).toBeGreaterThanOrEqual(MEMORY_MIN_IMPORTANCE);
  });

  it('次数 ≥1 时恒 ≥ 门槛：「被提过一次」就已经算一次可注入的偏好', () => {
    expect(mentionsToImportance(1)).toBeGreaterThanOrEqual(MEMORY_MIN_IMPORTANCE);
  });

  it('结果落在 [0,1] 且只保留 3 位小数（浮点尾差会让「幂等」这条断言没法写）', () => {
    for (const n of [1, 3, 7, 13, 30, 99]) {
      const v = mentionsToImportance(n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBe(Math.round(v * 1000) / 1000);
    }
  });

  it('名额上限都为正（取 0 会让偏好画像整体失效）', () => {
    expect(MEMORY_DIGEST_TOP_DOMAINS).toBeGreaterThan(0);
    expect(MEMORY_DIGEST_TOP_TERMS).toBeGreaterThan(0);
  });
});
