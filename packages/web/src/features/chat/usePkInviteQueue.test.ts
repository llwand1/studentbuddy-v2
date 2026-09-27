// @vitest-environment jsdom
/**
 * usePkInviteQueue.test — 邀请卡状态的锁（契约 docs/PK-SPEC.md §16.9）。
 *
 * 与 `useConfirmQueue.test` 逐条对照着看，因为它们**刻意相反**：
 * ① 确认门「换会话不捞回」（服务端没有 GET），这张卡**必须有 GET**：SSE 缓冲 60s 就回收，
 *    AI 发卡的瞬间用户不在页上 ⇒ 不捞回就是「它说要跟我打，我没看见」（契约 §16.5 那条 GET 的全部理由）。
 * ② 确认门挂起的是工具执行，这张卡不阻塞任何人 ⇒ 它不参与轮次 `reset()`，
 *    所以这里锁的是「新一轮的收口动作碰不到它」。
 * ③ 相同的一条：**答复不乐观切态**，`pk-invite-decided` 帧才是事实源（另一端点了本端要看见）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PkInviteRecord, SseEvent } from '@sb/shared';
import { ApiError } from '../../lib/api';

// 默认回空表：mount 即会捞一次，没设返回值的用例会同步抛在 effect 里（`.catch` 接不住同步异常）
const pendingMock = vi.fn().mockResolvedValue([] as PkInviteRecord[]);
const acceptMock = vi.fn();
const rejectMock = vi.fn();
// 只替掉端点那一层：`api.ts` 组的是 `pkInvites: pkInviteApi`，故 ApiError 等仍是真货
vi.mock('../../lib/api-pk-invite', () => ({
  pkInviteApi: {
    pending: (...a: unknown[]) => pendingMock(...a),
    accept: (...a: unknown[]) => acceptMock(...a),
    reject: (...a: unknown[]) => rejectMock(...a),
  },
}));

const { usePkInviteQueue, pkRoomHash } = await import('./usePkInviteQueue');

function record(over: Partial<PkInviteRecord> = {}): PkInviteRecord {
  return {
    id: 'i1',
    sessionId: 's1',
    ownerId: 'o1',
    topic: '牛顿第二定律',
    reason: '值得验一局',
    status: 'pending',
    roomId: null,
    createdAt: 1_000,
    ...over,
  };
}

function askedFrame(invite: PkInviteRecord): SseEvent {
  return { type: 'pk-invite-asked', seq: 1, sessionId: invite.sessionId, invite };
}

function decidedFrame(inviteId: string, status: 'accepted' | 'rejected', roomId: string | null): SseEvent {
  return { type: 'pk-invite-decided', seq: 2, sessionId: 's1', inviteId, status, roomId };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  pendingMock.mockReset().mockResolvedValue([]);
  acceptMock.mockReset();
  rejectMock.mockReset();
  window.location.hash = '';
});

describe('浮出与回收', () => {
  it('非邀请帧一律放行（返回 false 交回 useChatStream 主分发）', () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    expect(result.current.applyEvent({ type: 'ping' })).toBe(false);
    expect(result.current.applyEvent({ type: 'token', seq: 3, sessionId: 's1', content: 'x' })).toBe(false);
    expect(result.current.invite).toBeNull();
  });

  it('asked 浮出；断线回放同一帧只覆盖不叠卡（单值状态：服务端闸门保证一屏最多一张）', () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => expect(result.current.applyEvent(askedFrame(record()))).toBe(true));
    expect(result.current.invite?.id).toBe('i1');
    act(() => result.current.applyEvent(askedFrame(record())));
    expect(result.current.invite?.id).toBe('i1');
  });

  it('换会话：先清掉手上这张，再按新会话捞一次（不捞回＝用户回来看不见卡，本条是硬要求）', async () => {
    pendingMock.mockResolvedValue([record({ id: 'i9', sessionId: 's2' })]);
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => usePkInviteQueue(sid, vi.fn()),
      { initialProps: { sid: 's1' as string | null } },
    );
    act(() => result.current.applyEvent(askedFrame(record())));
    expect(result.current.invite?.id).toBe('i1');
    rerender({ sid: 's2' });
    expect(result.current.invite).toBeNull(); // 清场在捞回来之前，旧会话的卡绝不跨会话挂着
    await flush();
    expect(pendingMock).toHaveBeenCalledWith('s2');
    expect(result.current.invite?.id).toBe('i9');
  });

  it('没会话时不去捞；捞失败静默（捞不到卡不等于不能聊）', async () => {
    const onError = vi.fn();
    pendingMock.mockRejectedValue(new Error('boom'));
    const { rerender } = renderHook(({ sid }: { sid: string | null }) => usePkInviteQueue(sid, onError), {
      initialProps: { sid: null as string | null },
    });
    expect(pendingMock).not.toHaveBeenCalled();
    rerender({ sid: 's1' });
    await flush();
    expect(pendingMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('decided 帧：服务端广播是唯一事实源', () => {
  it('别处接受 ⇒ 本端切 accepted 且拿到 roomId（回执卡的「进入对局」全靠它）', () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(askedFrame(record())));
    act(() => result.current.applyEvent(decidedFrame('i1', 'accepted', 'R-9')));
    expect(result.current.invite?.status).toBe('accepted');
    expect(result.current.invite?.roomId).toBe('R-9');
  });

  it('别处拒绝 ⇒ roomId 恒 null（同名字段不因状态换形状，前端不必分支）', () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(askedFrame(record())));
    act(() => result.current.applyEvent(decidedFrame('i1', 'rejected', null)));
    expect(result.current.invite?.status).toBe('rejected');
    expect(result.current.invite?.roomId).toBeNull();
  });

  it('不是手上这张卡的 decided 帧：消化掉（return true）但不动本地态', () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(askedFrame(record({ id: 'i1' }))));
    act(() => result.current.applyEvent(decidedFrame('i-other', 'accepted', 'R-x')));
    expect(result.current.invite?.id).toBe('i1');
    expect(result.current.invite?.status).toBe('pending');
  });
});

describe('accept / reject', () => {
  it('接受成功：跳到这一局的房间再收卡（PkApp 挂 hash 恢复对局，本卡没有观众）', async () => {
    acceptMock.mockResolvedValue({ invite: record({ status: 'accepted', roomId: 'R-9' }), state: { roomId: 'R-9' } });
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(askedFrame(record())));
    let ok = false;
    await act(async () => {
      ok = await result.current.acceptInvite();
    });
    expect(ok).toBe(true);
    expect(acceptMock).toHaveBeenCalledWith('i1');
    expect(window.location.hash).toBe(pkRoomHash('R-9'));
    expect(result.current.invite).toBeNull();
  });

  it('房间已被回收（404 INVITE_ROOM_GONE）：收掉这张点不动的卡并说明下一步', async () => {
    const onError = vi.fn();
    acceptMock.mockRejectedValue(new ApiError(404, '房间不在了', { code: 'INVITE_ROOM_GONE' }));
    const { result } = renderHook(() => usePkInviteQueue('s1', onError));
    act(() => result.current.applyEvent(askedFrame(record())));
    let ok = true;
    await act(async () => {
      ok = await result.current.acceptInvite();
    });
    expect(ok).toBe(false);
    expect(result.current.invite).toBeNull();
    expect(onError.mock.calls[0]?.[0]).toContain('再邀请一局');
  });

  it('409 INVITE_NOT_PENDING：不改本地态，等 decided 帧收口（另一端正在答复）', async () => {
    const onError = vi.fn();
    acceptMock.mockRejectedValue(new ApiError(409, '已经处理过了', { code: 'INVITE_NOT_PENDING' }));
    const { result } = renderHook(() => usePkInviteQueue('s1', onError));
    act(() => result.current.applyEvent(askedFrame(record())));
    await act(async () => {
      expect(await result.current.acceptInvite()).toBe(false);
    });
    expect(result.current.invite?.status).toBe('pending');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });

  it('没卡时点接受/拒绝都是空操作（不发请求）', async () => {
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    await act(async () => {
      expect(await result.current.acceptInvite()).toBe(false);
    });
    act(() => result.current.rejectInvite());
    expect(acceptMock).not.toHaveBeenCalled();
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('拒绝只发请求、不本地切 rejected（本地各写一份迟早和广播漂）', async () => {
    rejectMock.mockResolvedValue(record({ status: 'rejected' }));
    const { result } = renderHook(() => usePkInviteQueue('s1', vi.fn()));
    act(() => result.current.applyEvent(askedFrame(record())));
    act(() => result.current.rejectInvite());
    expect(rejectMock).toHaveBeenCalledWith('i1');
    expect(result.current.invite?.status).toBe('pending');
    await flush();
    expect(result.current.invite?.status).toBe('pending');
    act(() => result.current.applyEvent(decidedFrame('i1', 'rejected', null)));
    expect(result.current.invite?.status).toBe('rejected');
  });
});
