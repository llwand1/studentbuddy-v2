/**
 * bank-view 单测：题库徽标四分（契约 docs/QUIZ-BLEND-SPEC.md §3.5，2026-09-20）。
 * 徽标 wording 锁死——「混合」二字是 D5「混成一个题组」在列表上的唯一可见痕迹，写错就白分了。
 */
import { describe, it, expect } from 'vitest';
import type { QuizMix, QuizSourceMix } from '@sb/shared';
import { bankBadge, mixTipText } from './bank-view';

describe('bankBadge — 题库徽标四分', () => {
  it('四种登记值各给各的徽标（AI / 情景 / 搜集 / 混合）', () => {
    expect(bankBadge('ai')).toBe('AI');
    expect(bankBadge('scenario')).toBe('情景');
    expect(bankBadge('collect')).toBe('搜集');
    expect(bankBadge('blend')).toBe('混合');
  });

  it('未知值 → null（不渲染、不猜，历史值与新值都从服务端来）', () => {
    expect(bankBadge('')).toBeNull();
    expect(bankBadge('mystery')).toBeNull();
  });
});

describe('mixTipText — 配比摘要一行（QUIZ-BLEND-SPEC §3.5/§8.3）', () => {
  const ai: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1, scenario: 0 };
  const realZero: QuizSourceMix = { single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 };

  it('真题 0 → 与旧摘要逐字一致（老用户看到的字不变）', () => {
    expect(mixTipText(ai, realZero)).toBe('单选题 2 · 填空题 1 · 解答题 1');
  });

  it('真题配了 → 并进同一行并预告「会慢」（collect 首版同步无进度条，提示必须如实）', () => {
    const tip = mixTipText(ai, { ...realZero, single: 2 });
    expect(tip).toContain('真题 2 题');
    expect(tip).toContain('可能更久');
  });
});
