// @vitest-environment jsdom
/**
 * useQuickStart.test —— 空会话直接开聊的暂存 / 放行 / 重试 / 放弃口径（契约 CHAT-UX-SPEC §2.9）。
 *
 * ChatView.test 锁的是接线（点卡 / 回车 ⇒ 开会话 ⇒ 就绪后发一次）；这里锁 hook 自己的分支：
 * 有会话直通、连按判重、就绪门（ready/busy）、「历史加载中」重试、非瞬态错误不重试、
 * 开会话超时放弃、卸载即丢。★ 最要紧的一条：send 成功后 busy 翻真会先触发 effect cleanup，
 * 暂存必须在 cleanup 之后仍被清掉——否则轮末 busy 回落，同一问会再发一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SseReadyState } from '../../lib/sse-client';
import { HISTORY_LOADING_ERROR } from './useSendActions';
import { QUICK_START_RETRY_MS, QUICK_START_TIMEOUT_MS, useQuickStart } from './useQuickStart';

type Props = { sessionId: string | null; ready: SseReadyState; busy: boolean };

function setup(initial: Props = { sessionId: null, ready: 'connecting', busy: false }) {
  const send = vi.fn(async (_t: string, _i?: unknown) => ({ ok: true }) as { ok: boolean; error?: string });
  const onNewSession = vi.fn();
  const onError = vi.fn();
  const hook = renderHook((p: Props) => useQuickStart({ ...p, onNewSession, send, onError }), { initialProps: initial });
  return { ...hook, send, onNewSession, onError };
}

const flush = () => act(async () => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useQuickStart 空会话直接开聊', () => {
  it('有会话 ⇒ 直接发，不开新会话、不进 starting；被拒原话上报', async () => {
    const h = setup({ sessionId: 's1', ready: 'open', busy: false });
    h.send.mockResolvedValueOnce({ ok: false, error: '生成中，请先停止' });
    act(() => h.result.current.fire('a'));
    await flush();
    expect(h.send).toHaveBeenCalledWith('a', undefined);
    expect(h.onNewSession).not.toHaveBeenCalled();
    expect(h.result.current.starting).toBe(false);
    expect(h.onError).toHaveBeenCalledWith('生成中，请先停止');
  });

  it('没会话 ⇒ 暂存 + 请 App 开会话 + starting；连按只开一间；会话到了但未就绪不发，就绪即发一次并收尾', async () => {
    const h = setup();
    const imgs = [{ dataUrl: 'data:image/png;base64,AA', name: 'x.png' }];
    act(() => h.result.current.fire('第一问', imgs));
    act(() => h.result.current.fire('连按'));
    expect(h.onNewSession).toHaveBeenCalledTimes(1);
    expect(h.result.current.starting).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    h.rerender({ sessionId: 's-new', ready: 'connecting', busy: false });
    await flush();
    expect(h.send).not.toHaveBeenCalled(); // SSE 没 open：send 的前置门不跳过
    h.rerender({ sessionId: 's-new', ready: 'open', busy: false });
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith('第一问', imgs); // 发的是第一问（连按那句被忽略），图也带上
    expect(h.result.current.starting).toBe(false);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('★ send 成功 ⇒ busy 翻真触发 cleanup 之后暂存仍被清：轮末 busy 回落不会再发一遍', async () => {
    const h = setup();
    let resolveSend: (r: { ok: boolean }) => void = () => {};
    h.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res; }));
    act(() => h.result.current.fire('q'));
    h.rerender({ sessionId: 's', ready: 'open', busy: false });
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    // 真实时序：api.chat.send 返回 → setBusy(true) 先渲染（effect cleanup）→ 之后 promise 的 then 才跑
    h.rerender({ sessionId: 's', ready: 'open', busy: true });
    await act(async () => resolveSend({ ok: true }));
    expect(h.result.current.starting).toBe(false);
    h.rerender({ sessionId: 's', ready: 'open', busy: false }); // 轮末
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('「历史加载中」是瞬态：按间隔重试直到通过；其它被拒不重试、上报并收尾', async () => {
    const h = setup();
    h.send
      .mockResolvedValueOnce({ ok: false, error: HISTORY_LOADING_ERROR })
      .mockResolvedValueOnce({ ok: false, error: HISTORY_LOADING_ERROR });
    act(() => h.result.current.fire('q'));
    h.rerender({ sessionId: 's', ready: 'open', busy: false });
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(QUICK_START_RETRY_MS); });
    expect(h.send).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(QUICK_START_RETRY_MS); });
    expect(h.send).toHaveBeenCalledTimes(3); // 第三次默认 ok
    expect(h.result.current.starting).toBe(false);
    expect(h.onError).not.toHaveBeenCalled();

    const g = setup();
    g.send.mockResolvedValueOnce({ ok: false, error: '上游 502' });
    act(() => g.result.current.fire('q'));
    g.rerender({ sessionId: 's', ready: 'open', busy: false });
    await flush();
    await act(async () => { vi.advanceTimersByTime(QUICK_START_RETRY_MS * 10); });
    expect(g.send).toHaveBeenCalledTimes(1); // 不重试：那时用户气泡已上屏，重发＝发两遍
    expect(g.onError).toHaveBeenCalledWith('上游 502');
    expect(g.result.current.starting).toBe(false);
  });

  it('开会话超时（App 建会话失败，新 id 永远不来）⇒ 放弃暂存、解锁输入区、说一句', async () => {
    const h = setup();
    act(() => h.result.current.fire('q'));
    await act(async () => { vi.advanceTimersByTime(QUICK_START_TIMEOUT_MS - 1); });
    expect(h.result.current.starting).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(h.result.current.starting).toBe(false);
    expect(h.onError).toHaveBeenCalledWith('开新对话没成功，请重试');
    expect(h.send).not.toHaveBeenCalled();
    // 放弃之后再发：又能开一间（不是永久锁死）
    act(() => h.result.current.fire('再来'));
    expect(h.onNewSession).toHaveBeenCalledTimes(2);
  });

  it('卸载即丢：开会话期间视图卸载，之后不发、不报错、不留定时器', async () => {
    const h = setup();
    act(() => h.result.current.fire('q'));
    h.unmount();
    await act(async () => { vi.advanceTimersByTime(QUICK_START_TIMEOUT_MS * 2); });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
