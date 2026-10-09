// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CampfireOpener } from '@sb/shared';

const h = vi.hoisted(() => ({ request: vi.fn(), scope: { on: false, summary: '', loaded: true, loading: false } }));
vi.mock('../../lib/api', () => ({ api: { request: h.request } }));
vi.mock('../exam/useExamScope', () => ({ useExamScope: () => h.scope }));
const { Welcome } = await import('./Welcome');
const { CampfireWorld } = await import('./CampfireWorld');
const sample = (id: string, stem: string): CampfireOpener => ({ id, scope: '', question: { topic: '概率', question: stem, options: ['25%', '50%', '75%'], answer: 1, explanation: '每次抛掷独立。' } });
function pending() {
  let resolve!: (value: CampfireOpener) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CampfireOpener>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const advance = async (ms = 100) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => { vi.useFakeTimers(); h.request.mockReset(); h.scope = { on: false, summary: '', loaded: true, loading: false }; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('像素营地现场开场题', () => {
  it('两处场景入口带正确目的地，旅行中禁重复点击，不召新题', () => {
    const enter = vi.fn();
    const view = render(<CampfireWorld onEnter={enter} />);
    fireEvent.click(screen.getByRole('button', { name: '魔法图书馆，前往词条库' }));
    expect(enter).toHaveBeenLastCalledWith('terms', expect.objectContaining({ x: 0, y: 0 }));
    fireEvent.click(screen.getByRole('button', { name: '遗迹入口，前往知识大陆' }));
    expect(enter).toHaveBeenLastCalledWith('continent', expect.objectContaining({ x: 0, y: 0 }));
    view.rerender(<CampfireWorld onEnter={enter} travelling="terms" />);
    fireEvent.click(screen.getByRole('button', { name: '遗迹入口，前往知识大陆' }));
    expect(enter).toHaveBeenCalledTimes(2);
    expect(h.request).not.toHaveBeenCalled();
  });
  it('可跳过入场直接答本次新题，不换题；减少动态效果可中途生效', async () => {
    let reduce = false;
    let listener: (() => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({ get matches() { return reduce; }, addEventListener: (_: string, fn: () => void) => { listener = fn; }, removeEventListener: vi.fn() }));
    h.request.mockResolvedValueOnce(sample('skip', '跳过动画仍是本次新题？'));
    const view = render(<Welcome onPick={vi.fn()} />); await advance();
    fireEvent.click(screen.getByRole('button', { name: '直接作答 ↓' }));
    expect((screen.getByRole('button', { name: /B.*50%/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('跳过动画仍是本次新题？')).toBeTruthy();
    expect(h.request).toHaveBeenCalledOnce();
    view.unmount();
    h.request.mockResolvedValueOnce(sample('reduce-change', '本次新的减少动态效果题？'));
    render(<Welcome onPick={vi.fn()} />); await advance();
    expect((screen.getByRole('button', { name: /B.*50%/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { reduce = true; listener?.(); });
    expect((screen.getByRole('button', { name: /B.*50%/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it('范围读取慢于合并窗口也不提前召题，读完只发一次；读取失败也能召题', async () => {
    h.request.mockReturnValue(pending().promise);
    h.scope = { on: false, summary: '', loaded: false, loading: true };
    const view = render(<Welcome onPick={vi.fn()} />);
    await advance(2000); expect(h.request).not.toHaveBeenCalled();
    h.scope = { on: true, summary: '考研', loaded: true, loading: false };
    view.rerender(<Welcome onPick={vi.fn()} />); await advance();
    expect(h.request).toHaveBeenCalledTimes(1);
    view.unmount(); h.request.mockClear();
    h.scope = { on: false, summary: '', loaded: false, loading: false };
    render(<Welcome onPick={vi.fn()} />); await advance();
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it('加载时没有题或选项；完整结果到达才入场，结束后可答并带完整题开聊', async () => {
    const p = pending(); h.request.mockReturnValue(p.promise);
    const pick = vi.fn(); const { container } = render(<Welcome onPick={pick} />);
    expect(container.querySelector('.opener-option')).toBeNull();
    expect(container.querySelector('.pixel-scene')?.getAttribute('aria-hidden')).toBe('true');
    await advance();
    await act(async () => p.resolve(sample('one', '抛硬币下一次出现正面的概率是多少？')));
    expect(container.querySelector('.opener-arriving')).toBeTruthy();
    expect((screen.getByRole('button', { name: /B.*50%/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.opener-explanation')).toBeNull();
    await advance(2900);
    fireEvent.click(screen.getByRole('button', { name: /B.*50%/ }));
    expect(screen.getByText('每次抛掷独立。')).toBeTruthy();
    expect(container.querySelector('.answer-impact.is-correct')).toBeTruthy();
    expect((screen.getByRole('button', {name: /A.*25%/}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: /A.*25%/}));
    expect(container.querySelector('.answer-impact.is-wrong')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /聊聊为什么/ }));
    expect(pick).toHaveBeenCalledOnce();
    expect(pick.mock.calls[0]?.[0]).toContain('抛硬币下一次');
    expect(pick.mock.calls[0]?.[0]).toContain('我选了 B');
  });
  it('换题立即撤掉旧题；新请求失败只显示重试，不能复用旧题', async () => {
    h.request.mockResolvedValueOnce(sample('one', '第一道现场题？'));
    const p = pending(); h.request.mockReturnValueOnce(p.promise);
    const { container } = render(<Welcome onPick={vi.fn()} />);
    await advance(3100);
    fireEvent.click(screen.getByRole('button', { name: /换一道/ }));
    expect(screen.queryByText('第一道现场题？')).toBeNull();
    expect(container.querySelector('.opener-option')).toBeNull();
    await advance();
    expect(JSON.parse(h.request.mock.calls[1]?.[1].body).exclude).toContain('第一道现场题？');
    await act(async () => p.reject(new Error('上游暂时不可用')));
    expect(screen.getByText('上游暂时不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新召题' })).toBeTruthy();
    expect(screen.queryByText('第一道现场题？')).toBeNull();
  });
  it('切换范围取消旧请求，迟到结果不能覆盖本次新题', async () => {
    const old = pending(); const fresh = pending(); h.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const view = render(<Welcome onPick={vi.fn()} />);
    await advance();
    const oldSignal = h.request.mock.calls[0]?.[1].signal as AbortSignal;
    h.scope = { on: true, summary: '考研', loaded: true, loading: false };
    view.rerender(<Welcome onPick={vi.fn()} />);
    expect(oldSignal.aborted).toBe(true);
    await advance();
    await act(async () => fresh.resolve(sample('fresh', '本次考研新题？')));
    await act(async () => old.resolve(sample('late', '已经过期的题？')));
    expect(screen.getByText('本次考研新题？')).toBeTruthy();
    expect(screen.queryByText('已经过期的题？')).toBeNull();
  });
  it('重新挂载不回显上一题并发起独立请求，卸载取消在途请求', async () => {
    h.request.mockResolvedValueOnce(sample('one', '上次进入的题？'));
    const first = render(<Welcome onPick={vi.fn()} />); await advance();
    first.rerender(<Welcome onPick={vi.fn()} blocked />);
    first.rerender(<Welcome onPick={vi.fn()} />);
    expect(screen.queryByText('上次进入的题？')).toBeNull();
    first.unmount();
    const p = pending(); h.request.mockReturnValueOnce(p.promise);
    const next = render(<Welcome onPick={vi.fn()} />);
    expect(screen.queryByText('上次进入的题？')).toBeNull();
    await advance(); expect(h.request).toHaveBeenCalledTimes(2);
    const signal = h.request.mock.calls[1]?.[1].signal as AbortSignal; next.unmount();
    expect(signal.aborted).toBe(true);
  });
  it('减少动态效果时到题即可作答；自己的问题入口可在等待时使用', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const p = pending(); h.request.mockReturnValue(p.promise);
    const ask = vi.fn(); render(<Welcome onPick={vi.fn()} onAsk={ask} />);
    fireEvent.click(screen.getByRole('button', { name: /我有自己的问题/ })); expect(ask).toHaveBeenCalledOnce();
    await advance(); await act(async () => p.resolve(sample('reduced', '减少动态效果的题？')));
    expect((screen.getByRole('button', { name: /B.*50%/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
