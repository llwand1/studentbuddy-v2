// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import type { DesktopStudyState } from '@sb/shared';
import { StudyClock } from '../../../../server/src/desktop/study-clock';
import { resetRoundMocks } from '../quiz/quiz-round.testkit';
import { CAPTURE_RESULT, discardDesktopCapture, HOST_QUICK_INPUT, receiveDesktopInput } from '../desktop/desktop-input';
vi.mock('../../lib/api-quiz-rounds', async () => ({ quizRoundsApi: (await import('../quiz/quiz-round.testkit')).roundMocks }));
vi.mock('../../lib/api-quiz-attempts', async () => ({ quizAttemptsApi: (await import('../quiz/quiz-round.testkit')).attemptMocks }));
const host = vi.hoisted(() => ({ handlers: [] as Array<(event: { data: string }) => void>, sent: [] as string[] }));
const server = vi.hoisted(() => ({ clock: null as StudyClock | null }));
const probe = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('../../app/App', () => ({ App: () => {
  const [draft, setDraft] = useState('');
  useEffect(() => { probe.mounts++; return () => { probe.unmounts++; }; }, []);
  return <div>APP_MUST_NOT_OPEN<input aria-label="测试草稿" value={draft} onChange={e => setDraft(e.target.value)} /></div>;
} }));
vi.mock('../desktop/desktop-api', () => ({ desktopApi: {
  browser: async () => ({ page: null }),
  tick: async (eligible: boolean) => server.clock!.tick(eligible),
  dismiss: async (action: 'done' | 'skip' | 'snooze') => { server.clock!.dismiss(action); return server.clock!.state(); },
  settings: async (settings: DesktopStudyState['settings']) => { server.clock!.configure(settings); return server.clock!.state(); },
} }));
const { FloatApp } = await import('./FloatApp');
afterEach(() => { cleanup(); discardDesktopCapture(); vi.useRealTimers(); delete (window as unknown as { chrome?: unknown }).chrome; host.handlers = []; host.sent = []; });
it('native background ticks deliver a timed question without mounting App, then return to the mascot after answering', async () => {
  resetRoundMocks(); localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T05:00:00Z'));
  (window as unknown as { chrome: unknown }).chrome = { webview: {
    postMessage: (value: string) => host.sent.push(value),
    addEventListener: (_type: string, fn: (event: { data: string }) => void) => host.handlers.push(fn),
    removeEventListener: (_type: string, fn: (event: { data: string }) => void) => { host.handlers = host.handlers.filter(h => h !== fn); },
  } };
  server.clock = new StudyClock({ enabled: true, intervalMinutes: 3, scope: 'learning' }, async () => ({
    id: 'q1', scope: '', question: { topic: '数学', question: '2 加 3 是多少？', options: ['4', '5'], answer: 1, explanation: '2 加 3 等于 5。' },
  }), () => 'learning');
  await act(async () => { render(<FloatApp />); });
  expect(document.documentElement.dataset.float).toBe('ball');
  vi.setSystemTime(new Date('2026-10-11T05:03:00Z'));
  await act(async () => { host.handlers.forEach(fn => fn({ data: 'sb-float:tick' })); });
  expect(screen.queryByText('APP_MUST_NOT_OPEN')).toBeNull(); expect(screen.getByText('2 加 3 是多少？')).toBeTruthy();
  expect(host.sent).toContain('sb-float:quiz');
  fireEvent.click(screen.getByRole('button', { name: /B\s*5/ }));
  await act(async () => { fireEvent.click(screen.getByText('提交整组答案 · 逐题分析')); });
  expect(screen.getByText('✓ 答案吻合')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /完成/ })); });
  expect(document.documentElement.dataset.float).toBe('ball'); expect(host.sent).toContain('sb-float:collapse');
  expect(screen.getByRole('button', { name: /打开 StudentBuddy/ }).dataset.mood).toBe('celebrate');
  expect(server.clock.state().nextAt).toBe(Date.now() + 180000);
});
it('collapsing and reopening keeps the same app, draft and mounted conversation', async () => {
  probe.mounts = 0; probe.unmounts = 0;
  server.clock = new StudyClock({ enabled: false, intervalMinutes: 3, scope: 'learning' }, async () => { throw new Error('disabled'); }, () => 'learning');
  location.hash = '#/float';
  await act(async () => { render(<FloatApp />); });
  fireEvent.click(screen.getByRole('button', { name: /打开 StudentBuddy/ }));
  fireEvent.change(screen.getByLabelText('测试草稿'), { target: { value: '把上一题接着讲完' } });
  fireEvent.click(screen.getByRole('button', { name: '收成吉祥物' }));
  expect(document.querySelector('.sb-float-screen')?.hasAttribute('hidden')).toBe(true);
  expect(probe.unmounts).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: /打开 StudentBuddy/ }));
  expect((screen.getByLabelText('测试草稿') as HTMLInputElement).value).toBe('把上一题接着讲完');
  expect(probe.mounts).toBe(1);
  expect(document.querySelector('.sb-float-bar-name')).toBeNull();
});
it('quick input and a native capture reveal the existing App without recreating its conversation',async()=>{
  probe.mounts=0;probe.unmounts=0;location.hash='#/float';
  server.clock=new StudyClock({enabled:false,intervalMinutes:3,scope:'learning'},async()=>{throw new Error('disabled');},()=> 'learning');
  await act(async()=>{render(<FloatApp/>);});
  act(()=>receiveDesktopInput(HOST_QUICK_INPUT));expect(document.documentElement.dataset.float).toBe('screen');
  fireEvent.change(screen.getByLabelText('测试草稿'),{target:{value:'保留现场'}});fireEvent.click(screen.getByRole('button',{name:'收成吉祥物'}));
  act(()=>receiveDesktopInput(CAPTURE_RESULT+JSON.stringify({id:'test',dataUrl:'data:image/png;base64,AAAA',name:'截图.png',width:100,height:80})));
  expect(document.documentElement.dataset.float).toBe('screen');expect((screen.getByLabelText('测试草稿') as HTMLInputElement).value).toBe('保留现场');expect(probe.mounts).toBe(1);
});
