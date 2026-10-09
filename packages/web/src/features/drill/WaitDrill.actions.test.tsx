// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { correctIndex, dismissMock, flush, keepMock, mapMock, markMock, newTermsMock, pressKey, prompt, resetDrillMocks } from './WaitDrill.testkit';
import { DRILL_END_EVENT } from './drill-dock';
import { DRILL_OPEN_EVENT } from './drill-prefs';

vi.mock('../../lib/api-terms-continent', () => ({ termsContinentApi: { map: mapMock } }));
vi.mock('../../lib/api-terms-review', () => ({ termsReviewApi: { mark: markMock } }));
vi.mock('../../lib/api-drill', () => ({ drillApi: { newTerms: newTermsMock, keep: keepMock, dismiss: dismissMock } }));
const { WaitDrill } = await import('./WaitDrill');
const item = { candidateId: 'keep-candidate', term: '尾调用优化', definition: '尾位置调用复用当前栈帧', domain: 'js', source: 'ai' as const };

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); resetDrillMocks({ mode: 'ai', items: [item] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function newReveal() {
  render(<WaitDrill busySessionId="s1" active />);
  await act(async () => vi.advanceTimersByTime(2000)); await flush();
  pressKey(String(correctIndex() + 1));
  await act(async () => vi.advanceTimersByTime(800));
  pressKey('Enter'); pressKey('n'); // even a word not recognised can be kept
  expect(prompt()).toBe(item.term);
}

it('收入在请求及成功停留期间防连按/不要；失败留卡重试，成功后才播放归档并续卡', async () => {
  await newReveal();
  let reject!: (error: Error) => void;
  keepMock.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  pressKey('Enter'); pressKey('Enter'); pressKey('x');
  expect(keepMock).toHaveBeenCalledTimes(1); expect(dismissMock).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: /正在收入/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('.drill-action-keep')).toBeNull();
  await act(async () => reject(new Error('保存暂时失败')));
  expect(screen.getByText(/收入词库没成.*保存暂时失败/)).toBeTruthy(); expect(prompt()).toBe(item.term);
  expect(document.querySelector('.drill-action-keep')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /收入词库/ })); await flush();
  expect(document.querySelector('.drill-action-keep')).not.toBeNull();
  expect(document.querySelector('.drill-archive-book')).not.toBeNull(); expect(document.querySelector('.answer-impact')).toBeNull();
  pressKey('Enter'); pressKey('x'); expect(keepMock).toHaveBeenCalledTimes(2); expect(dismissMock).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(719)); expect(prompt()).toBe(item.term);
  await act(async () => vi.advanceTimersByTime(1)); expect(prompt()).not.toBe(item.term);
});

it('结束本局后迟到的收入结果不跳新卡，不播放旧词反馈', async () => {
  await newReveal();
  let resolve!: (value: { termId: string; term: string; candidateApproved: boolean }) => void;
  keepMock.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  pressKey('Enter');
  act(() => window.dispatchEvent(new Event(DRILL_END_EVENT)));
  newTermsMock.mockResolvedValue({ mode: 'empty', items: [] });
  act(() => window.dispatchEvent(new Event(DRILL_OPEN_EVENT))); await flush();
  const next = prompt();
  await act(async () => resolve({ termId: 'saved-old', term: item.term, candidateApproved: true }));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(prompt()).toBe(next); expect(document.querySelector('.drill-action-keep')).toBeNull();
  expect(screen.queryByText(`「${item.term}」已收入词库`)).toBeNull();
});

it('重复斩只排除一次，不记正确或复习；退场后继续且后续不会再出该词', async () => {
  newTermsMock.mockResolvedValue({ mode: 'empty', items: [] });
  render(<WaitDrill busySessionId="s1" active />);
  await act(async () => vi.advanceTimersByTime(2000)); await flush();
  pressKey('z'); pressKey('z');
  expect(document.querySelector('.drill-action-slay')).not.toBeNull();
  expect(document.querySelector('.drill-cleaved-word')).not.toBeNull();
  expect(document.querySelector('.answer-impact')).toBeNull();
  expect(JSON.parse(localStorage.getItem('sb:drill:stats') ?? '{}').slain).toHaveLength(1);
  expect(document.querySelector('.drill-stats')?.textContent).toContain('答对 0');
  expect(markMock).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(520));
  expect(document.querySelector('.drill-action-slay')).toBeNull();
  expect(JSON.parse(localStorage.getItem('sb:drill:stats') ?? '{}').slain).toHaveLength(1);
});
