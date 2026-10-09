// @vitest-environment jsdom
/**
 * AiGradeNote — 前端判不了的题交给 AI：带齐入参、显示判定/误区、失败说清原因、卸载即取消。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApiError } from '../../lib/api-request';

const grade = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-ai-ops', () => ({ aiOpsApi: { grade } }));
const { AiGradeNote, gradeErrorText } = await import('./AiGradeNote');

afterEach(() => {
  cleanup();
  grade.mockReset();
});

const q = { type: 'fill' as const, question: '光合作用的原料', answer: ['水', '二氧化碳'] };
const result = { question: q.question, answer: 'H2O；CO2', expected: '水；二氧化碳', verdict: 'review' as const, context: '' };

describe('AiGradeNote', () => {
  it('★ 入参：题目、参考、作答、题型、主题；显示判定、分数与误区', async () => {
    grade.mockResolvedValue({ verdict: 'partial', score: 0.6, feedback: '原料对了一半', misconception: '漏了水' });
    const {container} = render(<AiGradeNote q={q} result={result} topic="光合作用" />);
    expect(screen.getByText('AI 正在按要点评分…')).toBeTruthy();
    expect(container.querySelector('.answer-impact')).toBeNull();
    expect(await screen.findByText('◐ AI 判定：部分正确（60 分）')).toBeTruthy();
    expect(container.querySelector('.answer-impact.is-partial')).toBeTruthy();
    expect(container.querySelector('.answer-impact.is-correct, .answer-impact.is-wrong')).toBeNull();
    expect(screen.getByText(/漏了水/)).toBeTruthy();
    expect(grade.mock.calls[0]?.[0]).toEqual({ question: '光合作用的原料', reference: '水；二氧化碳', answer: 'H2O；CO2', qtype: 'fill', topic: '光合作用' });
  });

  it('解答题映射成 essay；答对不显示误区', async () => {
    grade.mockResolvedValue({ verdict: 'correct', score: 1, feedback: '完整', misconception: null });
    render(<AiGradeNote q={{ type: 'essay', question: '解释', answer: '要点' }} result={{ ...result, answer: '我的解释' }} />);
    expect(await screen.findByText('✓ AI 判定：答对了（100 分）')).toBeTruthy();
    expect(screen.queryByText(/可能的误区/)).toBeNull();
    expect(grade.mock.calls[0]?.[0].qtype).toBe('essay');
  });

  it('★ 失败说清原因（没配模型指向设置页）', async () => {
    grade.mockRejectedValue(new ApiError(503, 'no model'));
    render(<AiGradeNote q={q} result={result} />);
    expect(await screen.findByText(/还没有配置模型/)).toBeTruthy();
    expect(gradeErrorText(new ApiError(504, 't'))).toContain('超时');
    expect(gradeErrorText(new Error('x'))).toContain('没有成功');
  });

  it('卸载即取消请求', () => {
    grade.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<AiGradeNote q={q} result={result} />);
    const signal = grade.mock.calls[0]?.[1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
