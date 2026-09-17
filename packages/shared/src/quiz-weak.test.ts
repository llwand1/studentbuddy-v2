import { describe, it, expect } from 'vitest';
import { normalizeWeakPoints, WEAK_MAX_POINTS, WEAK_TOPIC_MAX, WEAK_REASON_MAX } from './quiz-weak.js';

/** 造一条合法条目；`over` 用来把它改坏 */
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  topic: '定积分换元法',
  questionIndexes: [0, 2],
  reason: '换元后忘了改上下限',
  suggestion: '下次换元先把新上下限写出来再积分',
  ...over,
});

describe('normalizeWeakPoints — 模型输出不可信，本函数是唯一闸门', () => {
  it('合法条目原样通过', () => {
    const out = normalizeWeakPoints([good()], 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.topic).toBe('定积分换元法');
    expect(out[0]?.questionIndexes).toEqual([0, 2]);
  });

  it('非数组输入一律返回空（模型给散文/对象是常态）', () => {
    expect(normalizeWeakPoints(null, 5)).toEqual([]);
    expect(normalizeWeakPoints(undefined, 5)).toEqual([]);
    expect(normalizeWeakPoints('你的薄弱点在于……', 5)).toEqual([]);
    expect(normalizeWeakPoints({ weak: [good()] }, 5)).toEqual([]);
  });

  it('空数组返回空', () => {
    expect(normalizeWeakPoints([], 5)).toEqual([]);
  });

  it('topic / reason / suggestion 三者缺一即丢——半成品条目在屏上就是一句空话', () => {
    expect(normalizeWeakPoints([good({ topic: '' })], 5)).toEqual([]);
    expect(normalizeWeakPoints([good({ topic: '   ' })], 5)).toEqual([]);
    expect(normalizeWeakPoints([good({ reason: undefined })], 5)).toEqual([]);
    expect(normalizeWeakPoints([good({ suggestion: 123 })], 5)).toEqual([]);
  });

  it('题号全部越界即丢——不指向任何题的「薄弱点」用户不知道去练哪几道', () => {
    expect(normalizeWeakPoints([good({ questionIndexes: [5, 9] })], 5)).toEqual([]);
    expect(normalizeWeakPoints([good({ questionIndexes: [-1] })], 5)).toEqual([]);
    expect(normalizeWeakPoints([good({ questionIndexes: 'all' })], 5)).toEqual([]);
  });

  it('题号部分越界只留合法部分（丢整条代价太大，用户仍能照做）', () => {
    const out = normalizeWeakPoints([good({ questionIndexes: [1, 7, 3] })], 5);
    expect(out[0]?.questionIndexes).toEqual([1, 3]);
  });

  it('非整数题号被过滤（模型偶尔给 "第2题" 这类字符串或小数）', () => {
    const out = normalizeWeakPoints([good({ questionIndexes: [1.5, '2', null, 3] })], 5);
    expect(out[0]?.questionIndexes).toEqual([3]);
  });

  it('题号去重且升序——屏上题号顺序应与题目顺序一致，不跟模型书写顺序走', () => {
    const out = normalizeWeakPoints([good({ questionIndexes: [3, 1, 3, 1] })], 5);
    expect(out[0]?.questionIndexes).toEqual([1, 3]);
  });

  it('跨条目去重：一道题只归一个主题（聚类是对错题的划分）', () => {
    const out = normalizeWeakPoints([good({ topic: 'A', questionIndexes: [0, 1] }), good({ topic: 'B', questionIndexes: [1, 2] })], 5);
    expect(out).toHaveLength(2);
    expect(out[0]?.questionIndexes).toEqual([0, 1]);
    expect(out[1]?.questionIndexes).toEqual([2]);
  });

  it('后者被前面吃光题号时整条丢弃（而不是留一条空壳）', () => {
    const out = normalizeWeakPoints([good({ topic: 'A', questionIndexes: [0] }), good({ topic: 'B', questionIndexes: [0] })], 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.topic).toBe('A');
  });

  it(`最多留 ${WEAK_MAX_POINTS} 条——一次抓不住 6 个重点等于没有重点`, () => {
    const many = Array.from({ length: WEAK_MAX_POINTS + 3 }, (_, i) => good({ topic: `T${i}`, questionIndexes: [i] }));
    expect(normalizeWeakPoints(many, 20)).toHaveLength(WEAK_MAX_POINTS);
  });

  it('超长字段按上限截断（防模型灌大 payload）', () => {
    const out = normalizeWeakPoints([good({ topic: 'x'.repeat(200), reason: 'y'.repeat(500) })], 5);
    expect(out[0]?.topic).toHaveLength(WEAK_TOPIC_MAX);
    expect(out[0]?.reason).toHaveLength(WEAK_REASON_MAX);
  });

  it('脏条目与好条目混在一起时，只丢脏的那条', () => {
    const out = normalizeWeakPoints([good({ topic: 'A' }), { topic: 'B' }, good({ topic: 'C', questionIndexes: [4] })], 5);
    expect(out.map((w) => w.topic)).toEqual(['A', 'C']);
  });
});
