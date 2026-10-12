// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuizCard } from './QuizCard';
import { attemptMocks, makeRound, resetRoundMocks, roundMocks } from './quiz-round.testkit';
vi.mock('../../lib/api-quiz-rounds', async () => ({ quizRoundsApi: (await import('./quiz-round.testkit')).roundMocks }));
vi.mock('../../lib/api-quiz-attempts', async () => ({ quizAttemptsApi: (await import('./quiz-round.testkit')).attemptMocks }));
const q = { type: 'single' as const, question: '需要光？', options: ['需要', '不需要'], answer: [0] };
beforeEach(() => { resetRoundMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('retains cumulative objective records without writing another frontend attempt on group submission', async () => {
  attemptMocks.list.mockResolvedValue({ rows: [{ index: 0, attempts: 2, correct: 1, streak: 0, bestStreak: 1, last: { verdict: 'wrong', answer: 'B', at: '2026-10-12' } }] });
  render(<QuizCard title="光" questions={[q]} quizId="q-old" />); await screen.findByText(/刷过 2 遍.*50%/);
  fireEvent.click(await screen.findByRole('button', { name: /A.*需要/ }));
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ })); await screen.findByText('第 1 轮 · 已交卷');
  expect(attemptMocks.record).not.toHaveBeenCalled();
});
it('recovers an unsynced local draft on refresh without requiring optional thinking', async () => {
  const r = makeRound({ title: '光', origin: 'chat', questions: [q] });
  roundMocks.open.mockResolvedValue(r);
  localStorage.setItem(`sb-quiz-round:${r.id}`, JSON.stringify([{ ...r.responses[0], draft: { picked: [0], fills: [''], essay: '' }, thought: '这一句还没有同步' }]));
  render(<QuizCard title="光" questions={[q]} />);
  expect(await screen.findByRole('textbox', { name: '我的思考 / 评价' })).toHaveProperty('value', '这一句还没有同步');
  expect(screen.getByRole('button', { name: /A.*需要/ }).getAttribute('aria-pressed')).toBe('true');
});
it('does not let a delayed autosave overwrite edits made while that save is in flight', async () => {
  const r = makeRound({ title: '光', origin: 'chat', questions: [q] }); roundMocks.open.mockResolvedValue(r);
  let finish!: (v: typeof r.responses[0]) => void;
  roundMocks.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...r.responses[0], revision: 2 });
  render(<QuizCard title="光" questions={[q]} />); await screen.findByRole('button', { name: /A.*需要/ });
  fireEvent.click(screen.getByRole('button', { name: /我的思考/ })); const input = screen.getByRole('textbox', { name: '我的思考 / 评价' });
  fireEvent.change(input, { target: { value: '第一版' } }); await waitFor(() => expect(roundMocks.save).toHaveBeenCalledTimes(1));
  fireEvent.change(input, { target: { value: '第二版，最新思考' } });
  await act(async () => finish({ ...r.responses[0]!, thought: '第一版', revision: 1 }));
  await waitFor(() => expect(roundMocks.save).toHaveBeenCalledTimes(2));
  expect(roundMocks.save.mock.calls[1]![1].thought).toBe('第二版，最新思考');
  expect(input).toHaveProperty('value', '第二版，最新思考');
});
it('keeps unsaved text visible when persistence fails and offers a retry', async () => {
  roundMocks.save.mockRejectedValue(new Error('连接中断，暂未同步'));
  render(<QuizCard title="光" questions={[q]} />); await screen.findByRole('button', { name: /A.*需要/ });
  fireEvent.click(screen.getByRole('button', { name: /我的思考/ })); const input = screen.getByRole('textbox', { name: '我的思考 / 评价' });
  fireEvent.change(input, { target: { value: '不能丢失的思考' } });
  await screen.findByText(/连接中断，暂未同步/); expect(input).toHaveProperty('value', '不能丢失的思考');
  expect(screen.getByRole('button', { name: '重试保存 / 读取' })).toBeTruthy();
});
