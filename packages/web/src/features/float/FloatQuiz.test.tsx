// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FloatQuiz } from './FloatQuiz';
import type { CampfireOpener } from '@sb/shared';
import { resetRoundMocks, roundMocks } from '../quiz/quiz-round.testkit';
vi.mock('../../lib/api-quiz-rounds', async () => ({ quizRoundsApi: (await import('../quiz/quiz-round.testkit')).roundMocks }));
vi.mock('../../lib/api-quiz-attempts', async () => ({ quizAttemptsApi: (await import('../quiz/quiz-round.testkit')).attemptMocks }));
const opener: CampfireOpener = { id: 'q1', scope: '当前共读网页', question: { topic: '记忆', question: '哪种方法更利于长期记忆？', options: ['集中重复', '间隔检索'], answer: 1, explanation: '间隔检索更利于长期保持。' } };
beforeEach(() => { resetRoundMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps answers editable and feedback hidden until submitting the complete desktop question', async () => {
  const finish = vi.fn(async () => {}); const verdict = vi.fn(); render(<FloatQuiz opener={opener} onFinish={finish} onVerdict={verdict} />);
  expect(screen.queryByText(opener.question.explanation)).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /B.*间隔检索/ }));
  expect(verdict).not.toHaveBeenCalled(); expect(screen.queryByText(opener.question.explanation)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /我的思考/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '我的思考 / 评价' }), { target: { value: '需要主动提取记忆' } });
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ }));
  await waitFor(() => expect(verdict).toHaveBeenCalledWith(true));
  expect(document.querySelector('.sb-companion-art')?.getAttribute('data-mood')).toBe('celebrate');
  expect(screen.getByText(opener.question.explanation)).toBeTruthy();
  expect(roundMocks.submit.mock.calls[0]![1][0].thought).toBe('需要主动提取记忆');
  expect(screen.getByRole('button', { name: /A.*集中重复/ }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /完成/ })); expect(finish).toHaveBeenCalledWith('done');
});
it('snoozes or skips explicitly and reports a failed action without losing the current question', async () => {
  const finish = vi.fn(async () => { throw new Error('本机连接中断'); }); render(<FloatQuiz opener={opener} onFinish={finish} />);
  fireEvent.click(screen.getByRole('button', { name: '两分钟后' }));
  expect(finish).toHaveBeenCalledWith('snooze'); expect(await screen.findByRole('alert')).toHaveProperty('textContent', '本机连接中断');
  expect(await screen.findByText(opener.question.question)).toBeTruthy();
});
