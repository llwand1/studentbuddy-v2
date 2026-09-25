/**
 * PkApp — AI 出题 PK 独立页（`#/pk`，契约 docs/PK-SPEC.md §5，P0-3a）。
 *
 * 移动优先（≥375px），与桌面主壳互不嵌套：main.tsx 按 hash 二选一渲染。
 * 本组件持有两条状态：登录身份（统一账号会话，`usePkIdentity` 问服务端）与当前房间快照；
 * 房间快照以 SSE `pk-state` 为活水、GET state 为兜底（SSE 连续 3 次重连失败降级
 * 2s 轮询——契约 §2.2，Android 微信 X5 内核 EventSource 不稳）。
 *
 * ★ B1（§14，2026-09-20）：身份并入统一账号——所有请求不再带 userId，401 由 PkLobby
 *   引导「去登录」；新增**邀请链接**（§14.2）：`#/pk?code=<6位>` 从 hash 解析，
 *   已登录自动入房；未登录先记 returnTo（§14.3，sessionStorage）→ 登录成功后跳回原链接。
 *
 * P0-8（2026-09-14）：① 对局中的**投降**（成功后留在房里看结算页）；
 * ② **对战历史**（大厅入口 → 列表 → 点开回看该局题目）。历史与房间两视图互斥。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PkMatchDetail, PkMatchRecord, PkRoomState } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { pkInviteCodeFromHash, pkRoomIdFromHash, sanitizeReturnTo } from './pk-view';
import { usePkIdentity } from './usePkIdentity';
import { PkLobby } from './PkLobby';
import { PkRoom } from './PkRoom';
import { PkHistory } from './PkHistory';
import './pk.css';

/** SSE 连续重连失败达到该次数即降级轮询（契约 §2.2：3 次） */
const POLL_AFTER_FAILS = 3;
const POLL_INTERVAL_MS = 2000;
/** §14.3 returnTo 的 sessionStorage 键（不放 localStorage——跨会话残留会跳到旧链接） */
const RETURN_TO_KEY = 'sb_return_to';

export function PkApp() {
  /** 登录态（恢复逻辑在 `usePkIdentity`：undefined = 恢复中 / null = 未登录）。
   *  ★ B1 起身份只读——登录/登出都发生在主壳（统一账号），PK 页不再改写它。 */
  const [identity] = usePkIdentity();
  const [room, setRoom] = useState<PkRoomState | null>(null);
  const [link, setLink] = useState<SseReadyState>('connecting');
  /** 大厅动作错误（建房/入房/开局共用一条错误位，ADR-5 禁静默） */
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** P0-8：对战历史是否打开。`records === null` = 还没拉到（与「拉到空表」是两件事，不合并） */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [records, setRecords] = useState<PkMatchRecord[] | null>(null);
  const [detail, setDetail] = useState<PkMatchDetail | null>(null);

  const roomId = room?.roomId ?? null;
  /** §14.2：邀请码（只在首挂载解析一次——登录跳回后重挂载会重新解析，效果一致） */
  const inviteCode = useMemo(() => pkInviteCodeFromHash(window.location.hash), []);
  /** 邀请入房只自动尝试一次（404/409 后不该对着死链接反复撞） */
  const inviteTried = useRef(false);
  /** §16.9：AI 邀请接受后带进来的房（`#/pk?roomId=`），同样只解析一次、只认一次 */
  const linkedRoomId = useMemo(() => pkRoomIdFromHash(window.location.hash), []);
  const linkedTried = useRef(false);

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

  const createRoom = useCallback(
    async (mode: 'pvp' | 'pve', aiTopic?: string, topic?: string) => {
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.createRoom(mode, aiTopic, topic);
        setRoom(r.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : '建房失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const joinRoom = useCallback(async (roomCode: string, viaInvite = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.joinRoom(roomCode);
      setRoom(r.state);
    } catch (e) {
      // §14.2：邀请链接失效要能自解释——「房间已过期」优于笼统的「房间不存在」
      if (viaInvite && e instanceof ApiError && e.status === 404) {
        setError('邀请已失效：房间不存在或已过期，请让好友重新建房');
      } else {
        setError(e instanceof Error ? e.message : '入房失败，请重试');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // §14.2 流程 3/4：带邀请码打开本页 → 已登录自动入房；未登录则什么都不做（先登录，跳回后这里再触发）
  useEffect(() => {
    if (!inviteCode || !identity || inviteTried.current) return;
    inviteTried.current = true;
    void joinRoom(inviteCode, true);
  }, [inviteCode, identity, joinRoom]);

  /**
   * §16.9 流程：AI 邀请卡点「接受」⇒ 聊天页把用户送到 `#/pk?roomId=`（房已在服务端建好并开局，
   * 所以这里**取快照进房**，不是建房/入房）。取不到（内存房被 TTL 回收或进程重启）就说清楚：
   * ★ 不能静默停在大厅——那等于「我明明点了接受」，与 `INVITE_ROOM_GONE` 的契约口径同一条。
   */
  useEffect(() => {
    if (!linkedRoomId || !identity || linkedTried.current) return;
    linkedTried.current = true;
    void api.pk
      .roomState(linkedRoomId)
      .then((r) => setRoom(r.state))
      .catch(() => setError('这场对战已经结束或失效了（房间只在服务端留 30 分钟），可以在大厅再开一局'));
  }, [linkedRoomId, identity]);

  const startRoom = useCallback(async () => {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.startRoom(room.roomId);
      setRoom(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : '开局失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [room]);

  /** P0-7：选定/修改本人的对战主题（仅 waiting 期可改——开局后改主题等于中途改规则） */
  const pickTopic = useCallback(
    async (topic: string) => {
      if (!room) return;
      setBusy(true);
      setError('');
      try {
        const r = await api.pk.setTopic(room.roomId, topic);
        setRoom(r.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : '选主题失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const backToLobby = useCallback(() => {
    // 只回视图不删房：waiting 房由服务端 TTL 回收；再点「建房」幂等返回原房
    setRoom(null);
    setError('');
  }, []);

  /** P0-8：打开历史。**每次打开都重拉**——刚打完的那局必须立刻出现，不在客户端拼缓存 */
  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    setDetail(null);
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.matches();
      setRecords(r.matches);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取对战历史失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setDetail(null);
    setError('');
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);

  /** 点开某一局看回看（归属由会话裁定，服务端对别人的记录一律 404） */
  const openMatch = useCallback(async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.matchDetail(id);
      setDetail(r.match);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取对局详情失败');
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * P0-8：认输。成功**不回大厅**——留在房里看结算页（双方都该看见这局是怎么结束的）。
   * 失败如实抛给 error 位（409 = 这局其实已经结束了，刷新即见真状态）。
   */
  const forfeit = useCallback(async () => {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.pk.forfeit(room.roomId);
      setRoom(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : '认输失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [room]);

  /**
   * §14.1/§14.3：去主壳登录。当前 hash（含邀请码）存进 returnTo（sessionStorage），
   * 登录成功后由 main.tsx 按 returnTo 跳回——邀请链路不在「未登录点链接」这一步断掉。
   */
  const goLogin = useCallback(() => {
    const hash = window.location.hash;
    if (sanitizeReturnTo(hash)) sessionStorage.setItem(RETURN_TO_KEY, hash);
    window.location.hash = '#/';
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
          onGoLogin={goLogin}
          onCreate={createRoom}
          onJoin={(c) => void joinRoom(c)}
          onHistory={openHistory}
        />
      )}
      {(room || historyOpen) && error && <div className="sb-pk-error">{error}</div>}
    </div>
  );
}
