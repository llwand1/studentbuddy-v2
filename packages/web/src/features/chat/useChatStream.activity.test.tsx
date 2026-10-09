// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent } from '@sb/shared';
import { useChatStream } from './useChatStream';

const network = vi.hoisted(() => ({
  emit: (_event: SseEvent) => {},
  send: vi.fn(async () => ({ ok: true })),
  regenerate: vi.fn(async () => ({ ok: true })),
  resend: vi.fn(async () => ({ ok: true })),
  messages: vi.fn(async () => []),
}));
vi.mock('../../lib/api', () => ({
  ApiError: Error,
  api: {
    sessions: { messages: network.messages },
    choices: { pending: async () => [] },
    pkInvites: { pending: async () => [] },
    chat: { send: network.send, regenerate: network.regenerate, resend: network.resend },
  },
}));
vi.mock('../../lib/sse-client', () => ({
  connectSse: () => ({
    onStateChange: (callback: (state: 'open') => void) => { callback('open'); return () => {}; },
    onEvent: (callback: (event: SseEvent) => void) => { network.emit = callback; return () => {}; },
    close: () => {},
  }),
}));

const base = { sessionId: 'session', seq: 1 };
const start = (): SseEvent => ({ ...base, type: 'round-start', startedAt: 10 });
const done = (): SseEvent => ({ ...base, type: 'done' });
const step = (status: 'running' | 'done'): SseEvent => ({ ...base, type: 'step', tool: 'ask_choice', status });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function mount() {
  const hook = renderHook(() => useChatStream('session'));
  await act(async () => {});
  return hook;
}

describe('对话真实 hook 的轮完成边界', () => {
  it('SSE 先连接时仍等待历史，切会话与迟到历史不冒充已确认的空态', async () => {
    let first = () => {}, second = () => {};
    network.messages.mockImplementationOnce(() => new Promise<[]>(resolve => { first = () => resolve([]); }));
    network.messages.mockImplementationOnce(() => new Promise<[]>(resolve => { second = () => resolve([]); }));
    const h = renderHook(({ id }) => useChatStream(id), { initialProps: { id: 'first' } });
    expect(h.result.current.ready).toBe('open');
    expect(h.result.current.historyReady).toBe(false);
    h.rerender({ id: 'second' });
    await act(async () => first());
    expect(h.result.current.historyReady).toBe(false);
    await act(async () => { expect((await h.result.current.send('不要抢在历史前发送')).ok).toBe(false); });
    await act(async () => second());
    expect(h.result.current.historyReady).toBe(true);
    expect(network.send).not.toHaveBeenCalled();
  });
  it('收尾步骤和任务不会重新锁输入区，下一轮与错误状态仍正常', async () => {
    const h = await mount();
    act(() => { network.emit(start()); network.emit(done()); network.emit(step('running')); });
    expect(h.result.current.busy).toBe(false);
    act(() => {
      network.emit({ ...base, type: 'choice-asked', request: {
        id: 'post', sessionId: 'session', question: '接下来？', options: [{ id: 'o1', label: '算例' }],
        allowCustom: true, multi: false, grillPhase: 'post', ts: 10,
        status: 'pending', reply: null, answeredAt: null,
      } });
      network.emit(step('done'));
      network.emit({ ...base, type: 'tasks', items: [] });
    });
    expect(h.result.current.busy).toBe(false);
    expect(h.result.current.pendingChoice?.grillPhase).toBe('post');
    await act(async () => {
      expect(await h.result.current.send('算例', undefined, true, { kind: 'custom', topic: '特征值' })).toEqual({ ok: true });
    });
    expect(network.send).toHaveBeenCalledWith('session', '算例', undefined, true, undefined, { kind: 'custom', topic: '特征值' });
    act(() => { network.emit(start()); network.emit(step('running')); });
    expect(h.result.current.busy).toBe(true);
    act(() => { network.emit({ ...base, type: 'chat-error', message: '已停止' }); network.emit(step('done')); });
    expect(h.result.current.busy).toBe(false);
  });

  it('done 后先排空正文积压，收尾步骤到达也不丢字或重新忙碌', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const h = await mount(), answer = '完整的特征值讲解'.repeat(30);
    act(() => { network.emit(start()); network.emit({ ...base, type: 'token', content: answer }); network.emit(done()); network.emit(step('done')); });
    expect(h.result.current.busy).toBe(true);
    act(() => { while (frames.length) frames.shift()?.(); });
    expect(h.result.current.busy).toBe(false);
    expect(h.result.current.messages.at(-1)?.content).toBe(answer);
  });

  it.each(['send', 'regenerate', 'resend'] as const)('%s 的迟到回执不能覆盖 SSE 已完成状态', async (mode) => {
    let acknowledge = () => {};
    network[mode].mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({ ok: true }); }));
    const h = await mount();
    let request: Promise<{ ok: boolean }>;
    act(() => { request = mode === 'send' ? h.result.current.send('讲解') : mode === 'resend' ? h.result.current.resend('讲解') : h.result.current.regenerate(); });
    expect(h.result.current.busy).toBe(true);
    act(() => { network.emit(start()); network.emit(done()); });
    expect(h.result.current.busy).toBe(false);
    await act(async () => { acknowledge(); await request; });
    expect(h.result.current.busy).toBe(false);
  });
});
