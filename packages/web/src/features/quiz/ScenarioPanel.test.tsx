// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SCENARIO_REPORT_TYPE } from '@sb/shared';
import { ScenarioPanel } from './ScenarioPanel';
const apiMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: apiMock }));
const payload = { title: '调节光照', tasks: [{ id: 'light', prompt: '把光照调为亮', criteria: { kind: 'state' as const, value: 'bright' }, hint: '观察变化。' }] };
beforeEach(() => apiMock.request.mockReset());
afterEach(cleanup);
const report = (observed: unknown, source?: Window | null) => {
  fireEvent(window, new MessageEvent('message', { source: source === undefined ? document.querySelector('iframe')?.contentWindow : source,
    data: { v: 1, type: SCENARIO_REPORT_TYPE, demoId: 'demo', taskId: 'light', observed } }));
};
it('只接受当前 iframe；等待服务端确认才完成，并保留首次实际操作用于讲解', async () => {
  let resolve: (v: unknown) => void = () => undefined;
  apiMock.request.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} sessionId="s" />);
  report('bright', window);
  expect(apiMock.request).not.toHaveBeenCalled();
  report('dark'); report('bright');
  expect(apiMock.request).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('本轮探索完成')).toBeNull();
  await act(async () => resolve({ ok: true, correct: false }));
  await screen.findByText('本轮探索完成');
  report('bright');
  expect(apiMock.request).toHaveBeenCalledTimes(1);
  apiMock.request.mockRejectedValueOnce(new Error('测试模型不可用'));
  fireEvent.click(screen.getByText('一键讲解 · 图文复盘'));
  await screen.findByRole('alert');
  const sent = JSON.parse(apiMock.request.mock.calls[1]?.[1].body);
  expect(sent.kind).toBe('scenario');
  expect(sent.items[0]).toMatchObject({ answer: '"dark"', verdict: 'wrong' });
  expect(sent.items[0].context).toBe('观察变化。');
  fireEvent.click(screen.getByText('重开情景'));
  expect(screen.getByText('本轮探索完成')).toBeTruthy();
  expect(screen.getByText('沙箱连接中…')).toBeTruthy();
});
it('回传失败不算完成，同一操作可重试', async () => {
  apiMock.request.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, correct: true });
  render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} sessionId="s" />);
  report('bright');
  await screen.findByRole('alert');
  expect(screen.queryByText('本轮探索完成')).toBeNull();
  await waitFor(() => expect(apiMock.request).toHaveBeenCalledTimes(1));
  report('bright');
  await screen.findByText('本轮探索完成');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('沙箱拒绝评分不能解锁讲解，空任务也不能解锁', async () => {
  apiMock.request.mockResolvedValue({ ok: false });
  const view = render(<ScenarioPanel quizId="q" demoId="demo" payload={payload} sessionId="s" />);
  report('bright');
  await screen.findByRole('alert');
  expect(screen.queryByText('本轮探索完成')).toBeNull();
  view.unmount();
  render(<ScenarioPanel quizId="empty" demoId="empty" payload={{ title: 'empty', tasks: [] }} sessionId="s" />);
  expect(screen.queryByText('一键讲解 · 图文复盘')).toBeNull();
});
