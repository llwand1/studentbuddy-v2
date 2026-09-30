// @vitest-environment jsdom
/**
 * QuizCard.attempts.test — 题卡的作答记录（QUIZ-REVIEW-SPEC「作答记录」节）：
 * 带 quizId 的卡读回记录 ⇒ 顶部汇总行 + 每题「上次」小标；答一题就记一笔并乐观更新；
 * 老卡（无 quizId）零请求、提示照旧；读不到 / 记不上只多一行字，答题不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QuizAttemptRow } from '@sb/shared';
import { QuizCard } from './QuizCard';

const apiMock = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn() }));
vi.mock('../../lib/api-quiz-attempts', () => ({ quizAttemptsApi: apiMock }));
vi.mock('../../lib/api', () => ({ api: { request: vi.fn() } }));
vi.mock('../../lib/api-ai-ops', async (orig) => {
  const real = await orig<typeof import('../../lib/api-ai-ops')>();
  return { ...real, aiOpsApi: { ...real.aiOpsApi, reportAnswer: vi.fn(), grade: () => new Promise(() => undefined) } };
});

const questions = [
  { type: 'single' as const, question: '叶绿体的作用？', options: ['光合作用', '吸收矿物质'], answer: [0] },
  { type: 'essay' as const, question: '解释过程', answer: '能量转化' },
];
const rows: QuizAttemptRow[] = [
  { index: 0, attempts: 2, correct: 1, streak: 0, bestStreak: 1, last: { verdict: 'wrong', answer: 'B. 吸收矿物质', at: '2026-09-30T06:00:00.000Z' } },
  { index: 1, attempts: 1, correct: 0, streak: 0, bestStreak: 0, last: { verdict: 'review', answer: '略', at: '2026-09-30T06:01:00.000Z' } },
];
beforeEach(() => {
  apiMock.list.mockReset();
  apiMock.record.mockReset();
  apiMock.list.mockResolvedValue({ quizId: 'q-1', rows });
  apiMock.record.mockImplementation(async (_id: string, input: { questionIndex: number }) => ({
    quizId: 'q-1',
    row: { index: input.questionIndex, attempts: 3, correct: 2, streak: 1, bestStreak: 1, last: { verdict: 'correct', answer: 'A. 光合作用', at: '2026-09-30T07:00:00.000Z' } },
  }));
});
afterEach(cleanup);

const q1 = () => screen.getByRole('region', { name: '第 1 题' });

describe('带 quizId 的题卡', () => {
  it('读回记录 ⇒ 汇总行（解答题不进正确率）+ 每题「上次」小标带上次作答；答一题记一笔、汇总乐观更新、小标随本轮作答收起', async () => {
    render(<QuizCard title="光合作用" sessionId="s" quizId="q-1" questions={questions} />);
    expect(apiMock.list).toHaveBeenCalledWith('q-1');
    await waitFor(() => expect(screen.getByText(/刷过 2 遍/).textContent).toContain('刷过 2 遍 · 客观题正确率 50%（1/2）'));
    const chip = within(q1()).getByText(/上次 ↗/);
    expect(chip.getAttribute('title')).toBe('上次答：B. 吸收矿物质');
    expect(within(screen.getByRole('region', { name: '第 2 题' })).getByText(/上次 ◇/)).toBeTruthy();

    fireEvent.click(within(q1()).getByRole('button', { name: /光合作用/ }));
    fireEvent.click(within(q1()).getByText('确认作答'));
    expect(apiMock.record).toHaveBeenCalledWith('q-1', { questionIndex: 0, verdict: 'correct', answer: 'A. 光合作用' });
    // 乐观更新：服务端还没回，汇总已经按同一口径变了
    expect(screen.getByText(/刷过 3 遍/).textContent).toContain('客观题正确率 67%（2/3）');
    // 本轮答过的题不再显「上次」（当前反馈行就在下面，两个符号叠着会打架）
    expect(within(q1()).queryByText(/上次/)).toBeNull();
    await waitFor(() => expect(apiMock.record).toHaveResolved());
  });

  it('读不到 ⇒ 一行说明，题照答；记不上 ⇒ 点名第几题没记上，判分反馈仍在', async () => {
    apiMock.list.mockRejectedValue(new Error('服务端 500'));
    apiMock.record.mockRejectedValue(new Error('断网了'));
    render(<QuizCard title="光合作用" sessionId="s" quizId="q-1" questions={questions} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('以前的作答记录没读到：服务端 500'));
    fireEvent.click(within(q1()).getByRole('button', { name: /光合作用/ }));
    fireEvent.click(within(q1()).getByText('确认作答'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('第 1 题的作答没记上（页面上的判分不受影响）：断网了'));
    expect(within(q1()).getByText(/答案吻合/)).toBeTruthy();
    // 记不上不回滚：这题确实答了
    expect(screen.getByText(/刷过 1 遍/)).toBeTruthy();
  });
});

describe('老卡（无 quizId）', () => {
  it('零请求、没有汇总行；完成后的提示仍是「刷新后需重新作答」；带 quizId 的完成提示改口', async () => {
    const { unmount } = render(<QuizCard title="光合作用" sessionId="s" questions={[questions[0] as (typeof questions)[0]]} />);
    expect(apiMock.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /光合作用/ }));
    fireEvent.click(screen.getByText('确认作答'));
    expect(apiMock.record).not.toHaveBeenCalled();
    expect(screen.getByText(/刷新后需重新作答/)).toBeTruthy();
    expect(screen.queryByText(/刷过/)).toBeNull();
    unmount();

    apiMock.list.mockResolvedValue({ quizId: 'q-2', rows: [] });
    render(<QuizCard title="光合作用" sessionId="s" quizId="q-2" questions={[questions[0] as (typeof questions)[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: /光合作用/ }));
    fireEvent.click(screen.getByText('确认作答'));
    expect(screen.getByText(/对错已记在这组题上/)).toBeTruthy();
    await waitFor(() => expect(apiMock.record).toHaveBeenCalledTimes(1));
  });
});
