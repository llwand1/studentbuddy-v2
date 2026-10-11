// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FloatQuiz } from './FloatQuiz';
import type { CampfireOpener } from '@sb/shared';
const opener: CampfireOpener = { id: 'q1', scope: '当前共读网页', question: { topic: '记忆', question: '哪种方法更利于长期记忆？', options: ['集中重复', '间隔检索'], answer: 1, explanation: '间隔检索更利于长期保持。' } };
afterEach(cleanup);
it('keeps the answer hidden, locks repeated submissions and shows immediate feedback without opening App', async () => {
  const finish = vi.fn(async () => {}); const verdict = vi.fn(); render(<FloatQuiz opener={opener} onFinish={finish} onVerdict={verdict} />);
  expect(screen.queryByText(opener.question.explanation)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /B.*间隔检索/ }));
  expect(verdict).toHaveBeenCalledWith(true);
  expect(document.querySelector('.sb-companion-art')?.getAttribute('data-mood')).toBe('celebrate');
  expect(screen.getByText('答对了 · 火花点亮！')).toBeTruthy();
  expect(screen.getByRole('button', { name: /A.*集中重复/ }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /完成/ })); expect(finish).toHaveBeenCalledWith('done');
});
it('snoozes or skips explicitly and reports a failed action without losing the current question', async () => {
  const finish = vi.fn(async () => { throw new Error('本机连接中断'); }); render(<FloatQuiz opener={opener} onFinish={finish} />);
  fireEvent.click(screen.getByRole('button', { name: '两分钟后' }));
  expect(finish).toHaveBeenCalledWith('snooze'); expect(await screen.findByRole('alert')).toHaveProperty('textContent', '本机连接中断');
  expect(screen.getByText(opener.question.question)).toBeTruthy();
});
