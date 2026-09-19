// @vitest-environment jsdom
/**
 * useConfirmQueue.test — 确认门队列的状态机锁（契约 TOOL-ECOSYSTEM-SPEC §6.4）。
 *
 * 锁的是最容易在真机上咬人的四件事：
 * ① 断线回放同一 request 帧**刷态不二次入队**（否则两张一样的卡叠出来）；
 * ② resolved 只标态不出队（点完卡凭空消失＝以为没点上），新问进来才清旧 settled 卡；
 * ③ 换会话必清场（旧卡在新会话没有裁决通道）且**不捞回**——服务端刻意无 GET 恢复端点；
 * ④ reply 不乐观切态，回执只发请求、状态以广播为准。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SseEvent } from '@sb/shared';

const replyMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../../lib/api-tools', () => ({
  toolsApi: { replyConfirm: (...args: unknown[]) => replyMock(...args) },
}));

const { useConfirmQueue } = await import('./useConfirmQueue');

function reqFrame(over: Partial<Extract<SseEvent, { type: 'tool-confirm-request' }>> = {}): SseEvent {
  return {
    type: 'tool-confirm-request',
    seq: 1,
    sessionId: 's1',
    requestId: 'r1',
    tool: 'delete_terms',
    source: 'builtin',
    actionSummary: '删除 6 条',
    affected: 6,
    items: ['闭包'],
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

function resolvedFrame(requestId: string, decision: 'allow_once' | 'deny' | 'timeout' | 'allow_session'): SseEvent {
  return { type: 'tool-confirm-resolved', seq: 2, sessionId: 's1', requestId, decision };
}

afterEach(() => {
  replyMock.mockClear();
});

describe('useConfirmQueue', () => {
  it('非确认帧一律放行（返回 false 交回 useChatStream 分发）', () => {
    const { result } = renderHook(() => useConfirmQueue('s1', vi.fn()));
    expect(result.current.applyEvent({ type: 'ping' })).toBe(false);
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('request 入队 → resolved 标态不出队；同帧回放只刷不叠', () => {
    const { result } = renderHook(() => useConfirmQueue('s1', vi.fn()));
    act(() => {
      expect(result.current.applyEvent(reqFrame())).toBe(true);
    });
    expect(result.current.pendingConfirm?.requestId).toBe('r1');
    expect(result.current.pendingConfirm?.decision).toBeNull();
    // 回放同一帧（重连）：还是一条
    act(() => result.current.applyEvent(reqFrame()));
    expect(result.current.pendingConfirm?.requestId).toBe('r1');
    act(() => result.current.applyEvent(resolvedFrame('r1', 'deny')));
    // 已裁决仍可见（结果态卡），decision 已落
    expect(result.current.pendingConfirm?.decision).toBe('deny');
  });

  it('新问进来清掉已裁决旧卡：浮层只显示队首，旧结果卡不许压住新确认', () => {
    const { result } = renderHook(() => useConfirmQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(reqFrame({ requestId: 'r1' })));
    act(() => result.current.applyEvent(resolvedFrame('r1', 'allow_once')));
    act(() => result.current.applyEvent(reqFrame({ requestId: 'r2', actionSummary: '再删 3 条' })));
    expect(result.current.pendingConfirm?.requestId).toBe('r2');
    expect(result.current.pendingConfirm?.decision).toBeNull();
  });

  it('换会话即清空且不捞回（无 GET 端点；保守拒绝就是恢复机）', () => {
    const { result, rerender } = renderHook(({ sid }: { sid: string | null }) => useConfirmQueue(sid, vi.fn()), {
      initialProps: { sid: 's1' as string | null },
    });
    act(() => result.current.applyEvent(reqFrame()));
    expect(result.current.pendingConfirm).not.toBeNull();
    rerender({ sid: 's2' });
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('reply 只发请求不乐观切态；reset 清空整队', () => {
    const { result } = renderHook(() => useConfirmQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(reqFrame()));
    act(() => result.current.replyConfirm('r1', 'allow_once'));
    expect(replyMock).toHaveBeenCalledWith('r1', 'allow_once');
    expect(result.current.pendingConfirm?.decision).toBeNull(); // 本地不偷跑，等广播
    act(() => result.current.reset());
    expect(result.current.pendingConfirm).toBeNull();
  });
});
