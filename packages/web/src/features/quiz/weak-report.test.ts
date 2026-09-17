/**
 * weak-report 回归（契约 docs/QUIZ-WEAK-SPEC.md §6）。
 * 重点锁两件「写错不报错、只是骗用户」的事：
 * ① 降级结果必须如实标注是本地规则版，不得冒充 AI 分析；
 * ② 「还没做题」与「模型没接上」是两句话，不能混。
 */
import { describe, it, expect } from 'vitest';
import type { WeakAnalysis } from '@sb/shared';
import { weakView, indexText } from './weak-report.js';

const base = (over: Partial<WeakAnalysis> = {}): WeakAnalysis => ({
  weak: [{ topic: '二重积分换元', questionIndexes: [0, 2], reason: '漏乘 r', suggestion: '先画区域' }],
  fallback: false,
  analyzed: 3,
  ...over,
});

describe('indexText', () => {
  it('0 基题号转 1 基展示', () => {
    expect(indexText([0, 2])).toBe('第 1、3 题');
  });

  it('空数组给空串（不显示「第 题」）', () => {
    expect(indexText([])).toBe('');
  });
});

describe('weakView — AI 主路径', () => {
  it('非降级时给出 AI 口径行与逐条内容', () => {
    const v = weakView(base());
    expect(v.headNote).toBe('AI 分析（基于 3 道错题）');
    expect(v.fallbackNote).toBeNull();
    expect(v.emptyNote).toBeNull();
    expect(v.points).toHaveLength(1);
    expect(v.points[0]?.indexes).toBe('第 1、3 题');
  });

  it('多主题全部渲染（旧前端只取 weak[0]，多主题白算）', () => {
    const v = weakView(
      base({
        weak: [
          { topic: 'A', questionIndexes: [0], reason: 'r1', suggestion: 's1' },
          { topic: 'B', questionIndexes: [1], reason: 'r2', suggestion: 's2' },
        ],
      }),
    );
    expect(v.points.map((p) => p.topic)).toEqual(['A', 'B']);
  });
});

describe('weakView — 降级必须如实标注（ADR-5）', () => {
  it('no-model → 点明本地规则版并引导去设置页绑模型', () => {
    const v = weakView(base({ fallback: true, failure: 'no-model' }));
    expect(v.fallbackNote).toContain('本地规则版');
    expect(v.fallbackNote).toContain('设置页');
    expect(v.headNote).toBeNull(); // 降级时不得出现「AI 分析」口径行
  });

  it('call-failed → 点明本地规则版且提示可重试', () => {
    const v = weakView(base({ fallback: true, failure: 'call-failed' }));
    expect(v.fallbackNote).toContain('本地规则版');
    expect(v.fallbackNote).toContain('重试');
  });

  it('parse → 点明本地规则版且提示可重试', () => {
    const v = weakView(base({ fallback: true, failure: 'parse' }));
    expect(v.fallbackNote).toContain('本地规则版');
    expect(v.fallbackNote).toContain('重试');
  });

  it('三条真因文案各不相同（否则等于没区分）', () => {
    const texts = (['no-model', 'call-failed', 'parse'] as const).map((f) => weakView(base({ fallback: true, failure: f })).fallbackNote);
    expect(new Set(texts).size).toBe(3);
  });

  it('fallback 但缺 failure 时不出提示（老服务端兼容，不编造原因）', () => {
    expect(weakView(base({ fallback: true })).fallbackNote).toBeNull();
  });
});

describe('weakView — 空态与降级是两件事', () => {
  it('还没做题 → 说「先做题」，且不显示降级提示', () => {
    const v = weakView({ weak: [], fallback: false, analyzed: 0 });
    expect(v.emptyNote).toBe('暂无薄弱点（先做题）');
    expect(v.fallbackNote).toBeNull();
  });

  it('有错题却没分析出结果 → 不说「先做题」（那是误导）', () => {
    const v = weakView({ weak: [], fallback: false, analyzed: 5 });
    expect(v.emptyNote).not.toContain('先做题');
    expect(v.emptyNote).toContain('稍后重试');
  });
});
