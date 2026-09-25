/**
 * usePkInviteQueue — 「AI 主动发起对战」邀请卡的前端状态（契约 docs/PK-SPEC.md §16.9）。
 *
 * 与 `useChoiceQueue` 同法单开文件（`useChatStream` 贴着 400 行红线），但语义有两处**相反**，
 * 都在契约里定过，改之前先读 §16：
 * ① **不阻塞新一轮**：方案选择框挂起的是工具执行，这张卡只是浮层——他不点，AI 照常讲完；
 *    所以本 hook **不参与 `reset()`**（新一轮开始时不能把刚发出的邀请一起清了）。
 * ② **一屏恒一张**：服务端闸门保证同一会话不存在第二张 pending（`pk/invite.ts` 的第一条闸门），
 *    故这里用单值而不是队列——多一套数组语义去处理一个不可能出现的状态，是纯负担。
 *
 * 答复后的去向：接受 = 服务端建房开局 ⇒ 跳 `#/pk?roomId=`（PK 页按 §16.9 从 hash 恢复对局）。
 * ★ 不在前端拼房间状态、也不乐观切态：`pk-invite-decided` 帧才是事实源（另一端点掉这张卡时，
 *   本端要看见），409/404 是最终裁决（与选择框同一条纪律，见 `useChoiceQueue` 的注释）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PkInviteRecord, SseEvent } from '@sb/shared';
import { api, ApiError } from '../../lib/api';

/** 接受成功后的跳转目标（§16.9：PK 页从 hash 认房，与邀请码 `?code=` 同一套解析路子） */
export function pkRoomHash(roomId: string): string {
  return `#/pk?roomId=${encodeURIComponent(roomId)}`;
}

export interface PkInviteQueue {
  /** 当前邀请卡（pending＝可点，accepted/rejected＝回执）；无卡为 null */
  invite: PkInviteRecord | null;
  /** 接受/拒绝进行中的乐观锁（防手抖连点，服务端幂等才是裁决） */
  inviteBusy: boolean;
  /** 消化 SSE 事件：true＝本 hook 已接管（调用方应 return），false＝交回主分发 */
  applyEvent: (ev: SseEvent) => boolean;
  /** 接受并跳进对局；返回是否成功（调用方据此决定要不要留在本页） */
  acceptInvite: () => Promise<boolean>;
  rejectInvite: () => void;
  /** 收起回执卡（纯前端动作） */
  dismissInvite: () => void;
}

export function usePkInviteQueue(sessionId: string | null, onError: (msg: string) => void): PkInviteQueue {
  const [invite, setInvite] = useState<PkInviteRecord | null>(null);
  const inviteRef = useRef<PkInviteRecord | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const commit = useCallback((next: PkInviteRecord | null) => {
    inviteRef.current = next;
    setInvite(next);
  }, []);

  // 换会话（含刷新/重进）：先清掉上一张，再主动捞未答复的卡。
  // 为什么必须捞：SSE 缓冲 60s 无订阅即回收，AI 发完卡的那一瞬间用户不在页上 ⇒ 卡就永久丢了，
  // 而他回到会话时看到的是一段讲完的正文——「它说要跟我打，我没看见」。
  useEffect(() => {
    commit(null);
    if (!sessionId) return;
    let alive = true;
    void api.pkInvites
      .pending(sessionId)
      .then((rows) => {
        if (alive && rows.length > 0) commit(rows[0] ?? null);
      })
      .catch(() => undefined); // 捞不到卡不等于不能聊，静默（同选择框）
    return () => {
      alive = false;
    };
  }, [sessionId, commit]);

  const applyEvent = useCallback(
    (ev: SseEvent): boolean => {
      if (ev.type === 'pk-invite-asked') {
        // 按 id 幂等：断线重连会回放同一帧，覆盖而非二次浮出
        commit(ev.invite);
        return true;
      }
      if (ev.type === 'pk-invite-decided') {
        const cur = inviteRef.current;
        if (!cur || cur.id !== ev.inviteId) return true; // 不是手上这张（别的会话/已收起）：消化掉，不改本地态
        // 别处已答复（另一端点了）⇒ 本端跟着切态，不静默消失——「卡凭空没了」最难排查。
        // roomId 取帧里的：accepted 那支是刚建好的房，回执卡上的「进入对局」全靠它。
        commit({ ...cur, status: ev.status, roomId: ev.roomId ?? cur.roomId });
        return true;
      }
      return false;
    },
    [commit],
  );

  const acceptInvite = useCallback(async (): Promise<boolean> => {
    const cur = inviteRef.current;
    if (!cur || inviteBusy) return false;
    setInviteBusy(true);
    try {
      const r = await api.pkInvites.accept(cur.id);
      // 先跳再清：PkApp 挂载即按 hash 恢复对局，本卡的回执没有观众
      window.location.hash = pkRoomHash(r.state.roomId);
      commit(null);
      return true;
    } catch (e) {
      const code = (e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : '') ?? '';
      if (code === 'INVITE_ROOM_GONE') {
        // 内存房没了（发版重启/TTL 回收）：这张卡已经点不动了，收掉并说明下一步
        commit(null);
        onError('这场对战已经结束或失效了，让 AI 再邀请一局即可');
      } else if (e instanceof ApiError && e.status === 401) {
        onError('登录已过期，重新登录后再点接受');
      } else if (code === 'INVITE_NOT_PENDING') {
        // 已经处理过（多半是另一端点过了）：不改本地态，交给 decided 帧收口
        onError('这张邀请已经处理过了');
      } else {
        onError(e instanceof Error ? e.message : '接受失败，请重试');
      }
      return false;
    } finally {
      setInviteBusy(false);
    }
  }, [commit, inviteBusy, onError]);

  const rejectInvite = useCallback(() => {
    const cur = inviteRef.current;
    if (!cur || inviteBusy) return;
    setInviteBusy(true);
    void api.pkInvites
      .reject(cur.id)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : '拒绝失败，请重试'))
      .finally(() => setInviteBusy(false));
    // 不本地切 rejected：服务端会广播同一条 decided 帧，两边各写一份迟早漂（见文件头纪律）
  }, [inviteBusy, onError]);

  const dismissInvite = useCallback(() => commit(null), [commit]);

  return { invite, inviteBusy, applyEvent, acceptInvite, rejectInvite, dismissInvite };
}
