// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SCENARIO_REPORT_TYPE } from '@sb/shared';
import { ScenarioPanel } from './ScenarioPanel';
import { resetRoundMocks, roundMocks } from './quiz-round.testkit';
vi.mock('../../lib/api-quiz-rounds', async () => ({ quizRoundsApi: (await import('./quiz-round.testkit')).roundMocks }));
vi.mock('../../lib/api-quiz-attempts', async () => ({ quizAttemptsApi: (await import('./quiz-round.testkit')).attemptMocks }));
const payload = { title: '调节光照', tasks: [{ id: 'light', prompt: '把光照调为亮', criteria: { kind: 'state' as const, value: 'bright' }, hint: '观察变化。' }] };
beforeEach(() => { resetRoundMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const report = (observed: unknown, source?: Window | null) => {
  fireEvent(window, new MessageEvent('message', { source: source === undefined ? document.querySelector('iframe')?.contentWindow : source,
    data: { v: 1, type: SCENARIO_REPORT_TYPE, demoId: 'demo', taskId: 'light', observed } }));
};
it('accepts only its iframe, permits revision before submission and analyzes the final observation with optional thinking', async () => {
  render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} sessionId="s" />);
  await screen.findByText('任务 1 · 把光照调为亮');
  report('dark', window); expect(screen.queryByText('本轮操作："dark"')).toBeNull();
  report('dark'); report('bright');
  expect(screen.queryByText(/判对/)).toBeNull(); expect(roundMocks.submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /我的思考/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '我的思考 / 评价' }), { target: { value: '光照充足时观察颜色，但题目是否指的是自然光？' } });
  fireEvent.click(screen.getByText('提交整组操作 · 逐项分析'));
  await screen.findByText(/判对 · 规则/);
  expect(roundMocks.submit.mock.calls[0]?.[1][0]).toMatchObject({ draft: { essay: '"bright"' }, thought: '光照充足时观察颜色，但题目是否指的是自然光？' });
  expect(screen.getByText('本题分析文字')).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
  fireEvent.click(screen.getByText('再练一遍'));
  await screen.findByText('等待操作'); expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByText('查看上一轮'));
  await screen.findByText('本题分析文字');
});
it('keeps failed autosaves recoverable and does not submit until saving succeeds', async () => {
  roundMocks.save.mockRejectedValueOnce(new Error('保存暂时离线'));
  render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} />);
  await screen.findByText('任务 1 · 把光照调为亮'); report('dark');
  fireEvent.click(screen.getByText('提交整组操作 · 逐项分析'));
  await screen.findByRole('alert'); expect(roundMocks.submit).not.toHaveBeenCalled();
  expect(screen.getByText('本轮操作："dark"')).toBeTruthy();
  fireEvent.click(screen.getByText('重试保存 / 读取'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  fireEvent.click(screen.getByText('提交整组操作 · 逐项分析'));
  await screen.findByText(/判错 · 规则/);
});
it('rejects oversized observations and never allows an empty task group to submit', async () => {
  const view = render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} />);
  await screen.findByText('任务 1 · 把光照调为亮'); report('x'.repeat(4001));
  await screen.findByRole('alert'); expect(roundMocks.save).not.toHaveBeenCalled();
  view.unmount(); render(<ScenarioPanel quizId="empty" demoId="empty" payload={{ title: 'empty', tasks: [] }} />);
  expect(screen.queryByText('提交整组操作 · 逐项分析')).toBeNull();
});
