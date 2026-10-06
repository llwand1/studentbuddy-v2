/**
 * learning/collect-quality — 搜集辨别层的单测（契约 docs/QUIZ-TIER-SPEC.md §3）。
 * 全纯函数：加强 verbatim 的两条新闸各钉一个正例一个反例；考试信号钉「两票才算」；排序钉稳定性。
 */
import { describe, it, expect } from 'vitest';
import type { QuizQuestion } from '@sb/shared';
import { classifyExamSource, knownSourceOf, normalizeForAnchor, rankPicks, strongVerbatim } from './collect-quality.js';

const STEM = '在如图所示的电路中，电源电动势为 12V，内阻为 1Ω，R1=2Ω，R2=3Ω，闭合开关后，通过 R1 的电流是多少？';
const PAGE = normalizeForAnchor(`2023年高考物理真题 一、选择题 1. ${STEM} A. 1A B. 2A C. 3A D. 4A 答案：B 解析略。`);
const q = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  type: 'single', question: STEM, options: ['A. 1A', 'B. 2A', 'C. 3A', 'D. 4A'], answer: [1], ...over,
});

describe('strongVerbatim（尾锚点 + 选项命中率）', () => {
  it('题干完整、选项在页 → 过，并报选项命中数', () => {
    const v = strongVerbatim(q(), PAGE);
    expect(v.ok).toBe(true);
    expect(v.optionHits).toBe(4);
    expect(v.optionTotal).toBe(4);
  });
  it('★ 首句抄、后半编 → 尾锚点不命中，拒', () => {
    const v = strongVerbatim(q({ question: STEM.slice(0, 30) + '，请结合能量守恒定律分析并说明理由，写出完整推导过程。' }), PAGE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('后半段');
  });
  it('★ 题干抄、选项编 → 命中率 < 50%，拒', () => {
    const v = strongVerbatim(q({ options: ['A. 0.5A', 'B. 2A', 'C. 6A', 'D. 9A'] }), PAGE);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('选项');
  });
  it('选项前缀「A.」「B、」「(C)」样式差异不影响比对', () => {
    const v = strongVerbatim(q({ options: ['A、1A', 'B．2A', 'C:3A', 'D）4A'] }), PAGE);
    expect(v.ok).toBe(true);
  });
  it('短题干不做尾锚点校验（只信头锚点，少杀）', () => {
    const page = normalizeForAnchor('1. 光合作用的场所是？ A. 线粒体 B. 叶绿体 答案 B');
    const v = strongVerbatim(q({ question: '光合作用的场所是？', options: ['A. 线粒体', 'B. 叶绿体'] }), page);
    expect(v.ok).toBe(true);
  });
  it('填空/解答无选项 → 只看题干', () => {
    const v = strongVerbatim(q({ type: 'fill', options: undefined, answer: ['2A'] }), PAGE);
    expect(v.ok).toBe(true);
    expect(v.optionTotal).toBe(0);
  });
  it('应试摘录必须完整连续抄题，首尾相同但中间改写不能过', () => {
    const changed = q({ question: STEM.replace('内阻为 1Ω', '内阻为 2Ω') });
    expect(strongVerbatim(changed, PAGE).ok).toBe(true);
    expect(strongVerbatim(changed, PAGE, { strict: true }).reason).toContain('完整题干');
  });
  it('英语常见词散落全页不代表原题有这些选项，不能把填空题冒充选择题', () => {
    const stem = 'The book ____ cover is blue belongs to my sister.';
    const page = normalizeForAnchor(`${stem} 答案 whose；who 和 which 引导其它从句，where 与 that 的用法见另一个专题。`);
    const changed = q({ question: stem, options: ['A. where', 'B. that', 'C. whose', 'D. which'] });
    expect(strongVerbatim(changed, page).ok).toBe(true);
    expect(strongVerbatim(changed, page, { strict: true }).reason).toContain('成组命中');
  });
  it('应试完整选项组在题干附近可通过，带编号或无编号都可', () => {
    expect(strongVerbatim(q(), PAGE, { strict: true }).ok).toBe(true);
    const unlabeled = normalizeForAnchor(`${STEM}\n1A\n2A\n3A\n4A\n答案 2A`);
    expect(strongVerbatim(q(), unlabeled, { strict: true }).ok).toBe(true);
  });
});

describe('classifyExamSource（≥2 票才算真题页）', () => {
  it('标题「2023年高考物理真题」→ 年份 + 高考 + 真题，判真题页', () => {
    const v = classifyExamSource({ title: '2023年高考物理真题及答案', url: 'https://example.com/a' });
    expect(v.exam).toBe(true);
    expect(v.signals).toEqual(expect.arrayContaining(['高考', '真题']));
  });
  it('只有一个「期末」两个字 → 不算（满网都是）', () => {
    expect(classifyExamSource({ title: '期末复习小练习', url: 'https://blog.example.com/x' }).exam).toBe(false);
  });
  it('已登记 exam 题源自带一票，再加年份就够', () => {
    const v = classifyExamSource({ title: '2022 物理 电路计算', url: 'https://zujuan.xkw.com/paper/1' });
    expect(v.exam).toBe(true);
    expect(v.sourceLabel).toBe('组卷网（学科网）');
  });
  it('正文只看前 400 字（页脚导航里的「高考」不算）', () => {
    const text = 'x'.repeat(500) + ' 高考 真题 2021年';
    expect(classifyExamSource({ title: '习题', url: 'https://example.com', text }).exam).toBe(false);
  });
  it('非法 URL 不抛', () => {
    expect(() => classifyExamSource({ title: 't', url: 'not a url' })).not.toThrow();
    expect(knownSourceOf('not a url')).toBeNull();
  });
});

describe('rankPicks（已登记题源 → 带考试信号 → 其余；组内稳定）', () => {
  it('把好页往前挪，但一页不丢', () => {
    const picks = [
      { url: 'https://blog.example.com/1', title: '随手练习' },
      { url: 'https://blog.example.com/2', title: '2020年中考真题' },
      { url: 'https://www.jyeoo.com/p/3', title: '组卷' },
      { url: 'https://blog.example.com/4', title: '另一篇练习' },
    ];
    expect(rankPicks(picks).map((p) => p.url.slice(-1))).toEqual(['3', '2', '1', '4']);
  });
});
