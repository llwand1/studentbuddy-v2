/**
 * grade-eval-metrics — AI 阅卷评测口径：失败留在分母、误放率只看 wrong→correct、误区检出只看非 correct。
 */
import { describe, it, expect } from 'vitest';
import { renderGradeSummary, summarizeGrade, type GradeEvalRecord } from './grade-eval-metrics.js';

const r = (expected: GradeEvalRecord['expected'], got: GradeEvalRecord['got'], misconception: string | null = null): GradeEvalRecord => ({
  id: `${expected}-${got}`, expected, got, score: null, misconception,
});

describe('summarizeGrade', () => {
  it('空集 ⇒ 全部 null（不假装 0% 或 100%）', () => {
    const s = summarizeGrade([]);
    expect(s).toMatchObject({ n: 0, accuracy: null, binaryAccuracy: null, falsePass: null, diagnosis: null });
  });

  it('★ 失败留在分母，按判错计', () => {
    const s = summarizeGrade([r('correct', 'correct'), r('correct', null)]);
    expect(s.failures).toBe(1);
    expect(s.accuracy).toBe(0.5);
    expect(s.binaryAccuracy).toBe(0.5);
    expect(s.confusion.correct.fail).toBe(1);
  });

  it('二分类：partial 与 wrong 同属「不对」', () => {
    const s = summarizeGrade([r('wrong', 'partial'), r('partial', 'wrong')]);
    expect(s.accuracy).toBe(0);
    expect(s.binaryAccuracy).toBe(1);
  });

  it('★ 误放率 = wrong 判成 correct / wrong 总数；partial→correct 不算', () => {
    const s = summarizeGrade([r('wrong', 'correct'), r('wrong', 'wrong'), r('partial', 'correct', null)]);
    expect(s.falsePass).toBe(0.5);
  });

  it('误区检出只数非 correct 样本，空白串不算', () => {
    const s = summarizeGrade([r('wrong', 'wrong', '把光反应当成暗反应'), r('partial', 'partial', '  '), r('correct', 'correct', '多余')]);
    expect(s.diagnosis).toBe(0.5);
  });

  it('渲染：写出分母与混淆矩阵', () => {
    const md = renderGradeSummary(summarizeGrade([r('wrong', 'correct')]), { model: 'm', dataset: 'd', date: '2026-09-29', replay: true });
    expect(md).toContain('n=1');
    expect(md).toContain('误放率（wrong→correct，越低越好） | 100.0%');
    expect(md).toContain('| wrong | 1 | 0 | 0 | 0 |');
  });
});
