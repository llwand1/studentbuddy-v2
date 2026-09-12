/**
 * PkApp — AI 出题 PK 独立页（`#/pk`，契约 docs/PK-SPEC.md §5，P0-3a）。
 *
 * 移动优先（≥375px），与桌面主壳互不嵌套：main.tsx 按 hash 二选一渲染。
 * 本组件持有两条状态：登录身份（localStorage 恢复 + /auth/me 校验）与当前房间快照；
 * 房间快照以 SSE `pk-state` 为活水、GET state 为兜底（SSE 连续 3 次重连失败降级
 * 2s 轮询——契约 §2.2，Android 微信 X5 内核 EventSource 不稳）。
 *
 * ★ 动作区（出题/答题）的端点属 P0-2，本批不放假按钮——对局页只有真实数据：
 *   比分、双方昵称、对局时钟（服务端 endsAt，客户端只作展示）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PkIdentity, PkRoomState } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { clearLocalAuth, loadLocalAuth, saveLocalAuth } from '../../lib/auth';
import { PkLobby } from './PkLobby';
import { PkRoom } from './PkRoom';
import './pk.css';

/** SSE 连续重连失败达到该次数即降级轮询（契约 §2.2：3 次） */
const POLL_AFTER_FAILS = 3;
const POLL_INTERVAL_MS = 2000;

export function PkApp() {
  /** undefined = 正在恢复登录态；null = 未登录；PkIdentity = 已登录 */
  const [identity, setIdentity] = useState<PkIdentity | null | undefined>(undefined);
  const [room, setRoom] = useState<PkRoomState | null>(null);
  const [link, setLink] = useState<SseReadyState>('connecting');
  /** 大厅动作错误（建房/入房/开局/登录共用一条错误位，ADR-5 禁静默） */
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 启动恢复登录态：本地记着 userId 就过一遍 /auth/me，账号已不存在则静默清除
  useEffect(() => {
    const local = loadLocalAuth();
    if (!local) {
      setIdentity(null);
      return;
    }
    let alive = true;
    api.pk
      .me(local.userId)
      .then((me) => alive && setIdentity(me))
      .catch(() => {
        clearLocalAuth();
        if (alive) setIdentity(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const roomId = room?.roomId ?? null;

  // 房间事件流：pk-state 全量快照即真相；断线重连 3 次失败 → 降级 2s 轮询（契约 §2.2）
  useEffect(() => {
    if (!roomId) return;
    let fails = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    const client = connectSse(`/api/pk/stream?roomId=${encodeURIComponent(roomId)}`);
    const offState = client.onStateChange((s) => {
      setLink(s);
      if (s === 'open') fails = 0;
      if (s === 'reconnecting') fails += 1;
      if (fails >= POLL_AFTER_FAILS && !poll) {
        client.close();
        poll = setInterval(() => {
          api.pk
            .roomState(roomId)
            .then((r) => setRoom(r.state))
            .catch((e) => {
              // 404 = 房已被 TTL 回收：回大厅并如实告知，轮询跟着 useEffect 清理停止
              if (e instanceof ApiError && e.status === 404) {
                setRoom(null);
                setError('房间已失效，请重新建房或入房');
              }
            });
        }, POLL_INTERVAL_MS);
      }
    });
    const offEvent = client.onEvent((ev) => {
      if (ev.type === 'pk-state' && ev.roomId === roomId) setRoom(ev.state);
    });
    return () => {
      offState();
      offEvent();
      client.close();
      if (poll) clearInterval(poll);
    };
  }, [roomId]);

  const login = useCallback(async (nickname: string) => {
    setBusy(true);
    setError('');
    try {
      const me = await api.pk.login(nickname);
      saveLocalAuth(me);
      setIdentity(me);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  }, []);

  const createRoom = useCallback(async () => {
    if (!identity) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.createRoom(identity.userId);
      setRoom(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : '建房失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [identity]);

  const joinRoom = useCallback(
    async (roomCode: string) => {
      if (!identity) return;
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.joinRoom(roomCode, identity.userId);
        setRoom(r.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : '入房失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [identity],
  );

  const startRoom = useCallback(async () => {
    if (!identity || !room) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.startRoom(room.roomId, identity.userId);
      setRoom(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : '开局失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [identity, room]);

  const backToLobby = useCallback(() => {
    // 只回视图不删房：waiting 房由服务端 TTL 回收；再点「建房」幂等返回原房
    setRoom(null);
    setError('');
  }, []);

  return (
    <div className="sb-pk">
      <header className="sb-pk-head">
        <a className="sb-pk-back" href="#/">
          ← 学习助手
        </a>
        <span className="sb-pk-title">AI 出题 PK</span>
      </header>
      {identity === undefined ? (
        <div className="sb-pk-boot">正在恢复登录态…</div>
      ) : room && identity ? (
        <PkRoom state={room} userId={identity.userId} link={link} onStart={startRoom} onLeave={backToLobby} />
      ) : (
        <PkLobby identity={identity} error={error} busy={busy} onLogin={login} onCreate={createRoom} onJoin={joinRoom} />
      )}
      {room && error && <div className="sb-pk-error">{error}</div>}
    </div>
  );
}
