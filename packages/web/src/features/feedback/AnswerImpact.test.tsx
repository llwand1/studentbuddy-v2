// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnswerImpact, AnswerSoundToggle } from './AnswerImpact';

let reduced = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers(); reduced = false; listeners.clear(); localStorage.removeItem('sb:answer:sound');
  window.dispatchEvent(new Event('storage'));
  vi.stubGlobal('matchMedia', () => ({get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)}));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('真实事件仅播放一次；过期后重渲染或隐藏再显示不重播，新事件才重新响应', () => {
  const view = render(<div hidden={false}><AnswerImpact verdict="correct" event={1} /></div>);
  expect(view.container.querySelector('.answer-impact')?.getAttribute('aria-hidden')).toBe('true');
  act(() => { vi.advanceTimersByTime(1100); });
  view.rerender(<div hidden><AnswerImpact verdict="correct" event={1} /></div>);
  view.rerender(<div hidden={false}><AnswerImpact verdict="correct" event={1} /></div>);
  expect(view.container.querySelector('.answer-impact')).toBeNull();
  view.rerender(<div><AnswerImpact verdict="wrong" event={2} /></div>);
  expect(view.container.querySelector('.answer-impact.is-wrong')).toBeTruthy();
  expect(view.container.querySelector('.answer-impact.is-correct')).toBeNull();
});

it('初始减少动态效果不出粒子，中途开启立即清理；卸载取消残余计时器与监听', () => {
  reduced = true; const first = render(<AnswerImpact verdict="review" />);
  expect(first.container.querySelector('.answer-impact')).toBeNull(); first.unmount();
  reduced = false; const second = render(<AnswerImpact verdict="partial" event={1} />);
  expect(second.container.querySelector('.answer-impact.is-partial')).toBeTruthy();
  act(() => { reduced = true; listeners.forEach(fn => fn()); });
  expect(second.container.querySelector('.answer-impact')).toBeNull(); second.unmount();
  expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it('音效默认关，多个入口同步本机偏好；浏览器没有音频能力也不打断操作', () => {
  vi.stubGlobal('AudioContext', undefined);
  render(<><AnswerSoundToggle /><AnswerSoundToggle /></>);
  expect(screen.getAllByRole('button', {name:'答题音效：关'})).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', {name:'答题音效：关'})[0] as HTMLElement);
  expect(localStorage.getItem('sb:answer:sound')).toBe('1');
  expect(screen.getAllByRole('button', {name:'答题音效：开'})).toHaveLength(2);
  localStorage.setItem('sb:answer:sound', '0'); act(() => window.dispatchEvent(new Event('storage')));
  expect(screen.getAllByRole('button', {name:'答题音效：关'})).toHaveLength(2);
});
