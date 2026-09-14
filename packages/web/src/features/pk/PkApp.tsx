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
 *
 * P0-8（2026-09-14）加两处：① 对局中的**投降**（`PkForfeit` 两段确认 → `forfeit`；
 * 成功后**留在房里**看结算页，不回大厅——双方都该看见这局怎么结束的）；
 * ② **对战历史**（`PkHistory`：大厅入口 → 列表 → 点开回看该局题目）。
 * ★ 历史与房间是**两个视图互斥**：`room` 有值时房间优先（对局永远盖过历史），
 *   历史只在大厅态打开——所以 `historyOpen` 不必与 `room` 做互斥判断。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PkMatchDetail, PkMatchRecord, PkRoomState } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { saveLocalAuth } from '../../lib/auth';
import { usePkIdentity } from './usePkIdentity';
import { PkLobby } from './PkLobby';
import { PkRoom } from './PkRoom';
import { PkHistory } from './PkHistory';
import './pk.css';

/** SSE 连续重连失败达到该次数即降级轮询（契约 §2.2：3 次） */
const POLL_AFTER_FAILS = 3;
const POLL_INTERVAL_MS = 2000;

export function PkApp() {
  /** 登录态（恢复逻辑在 `usePkIdentity`：undefined = 恢复中 / null = 未登录） */
  const [identity, setIdentity] = usePkIdentity();
  const [room, setRoom] = useState<PkRoomState | null>(null);
  const [link, setLink] = useState<SseReadyState>('connecting');
  /** 大厅动作错误（建房/入房/开局/登录共用一条错误位，ADR-5 禁静默） */
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** P0-8：对战历史是否打开。`records === null` = 还没拉到（与「拉到空表」是两件事，不合并） */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [records, setRecords] = useState<PkMatchRecord[] | null>(null);
  const [detail, setDetail] = useState<PkMatchDetail | null>(null);

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

  const createRoom = useCallback(
    async (mode: 'pvp' | 'pve', aiTopic?: string, topic?: string) => {
      if (!identity) return;
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.createRoom(identity.userId, mode, aiTopic, topic);
        setRoom(r.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : '建房失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [identity],
  );

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

  /** P0-7：选定/修改本人的对战主题（仅 waiting 期可改——开局后改主题等于中途改规则） */
  const pickTopic = useCallback(
    async (topic: string) => {
      if (!identity || !room) return;
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.setTopic(room.roomId, identity.userId, topic);
        setRoom(r.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : '选主题失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [identity, room],
  );

  const backToLobby = useCallback(() => {
    // 只回视图不删房：waiting 房由服务端 TTL 回收；再点「建房」幂等返回原房
    setRoom(null);
    setError('');
  }, []);

  /** P0-8：打开历史。**每次打开都重拉**——刚打完的那局必须立刻出现，不在客户端拼缓存 */
  const openHistory = useCallback(async () => {
    if (!identity) return;
    setHistoryOpen(true);
    setDetail(null);
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.matches(identity.userId);
      setRecords(r.matches);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取对战历史失败');
    } finally {
      setBusy(false);
    }
  }, [identity]);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setDetail(null);
    setError('');
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);

  /** 点开某一局看回看（详情按 id + userId 取，服务端对别人的记录一律 404） */
  const openMatch = useCallback(
    async (id: string) => {
      if (!identity) return;
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.matchDetail(id, identity.userId);
        setDetail(r.match);
      } catch (e) {
        setError(e instanceof Error ? e.message : '读取对局详情失败');
      } finally {
        setBusy(false);
      }
    },
    [identity],
  );

  /**
   * P0-8：认输。成功**不回大厅**——留在房里看结算页（双方都该看见这局是怎么结束的）。
   * 失败如实抛给 error 位（409 = 这局其实已经结束了，刷新即见真状态）。
   */
  const forfeit = useCallback(async () => {
    if (!identity || !room) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.forfeit(room.roomId, identity.userId);
      setRoom(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : '认输失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [identity, room]);

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
        <PkRoom
          state={room}
          userId={identity.userId}
          link={link}
          busy={busy}
          onStart={startRoom}
          onSetTopic={pickTopic}
          onForfeit={forfeit}
          onLeave={backToLobby}
        />
      ) : historyOpen && identity ? (
        <PkHistory
          userId={identity.userId}
          records={records}
          detail={detail}
          loading={busy}
          onOpen={openMatch}
          onCloseDetail={closeDetail}
          onBack={closeHistory}
        />
      ) : (
        <PkLobby
          identity={identity}
          error={error}
          busy={busy}
          onLogin={login}
          onCreate={createRoom}
          onJoin={joinRoom}
          onHistory={openHistory}
        />
      )}
      {(room || historyOpen) && error && <div className="sb-pk-error">{error}</div>}
    </div>
  );
}
