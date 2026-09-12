/**
 * PkRoom — 房间视图（waiting / active / finished 三态，契约 docs/PK-SPEC.md §5）。
 *
 * 全部数据来自服务端快照（SSE pk-state 或轮询）：比分、房号、对局时钟都是真数据，
 * 客户端不发明状态。对局动作区（出题/答题）的端点属 P0-2——本批只有一行如实说明，
 * 不放假按钮（ADR-5：禁止静默，也不制造假交互）。
 */
import { useEffect, useState } from 'react';
import type { PkRoomState } from '@sb/shared';
import type { SseReadyState } from '../../lib/sse-client';
import { formatClock, isOwner, remainingMs } from './pk-view';

interface Props {
  state: PkRoomState;
  userId: string;
  link: SseReadyState;
  onStart: () => void;
  onLeave: () => void;
}

const LINK_TEXT: Record<SseReadyState, string> = {
  connecting: '连接中',
  open: '实时同步',
  reconnecting: '重连中',
  closed: '轮询同步',
};

export function PkRoom({ state, userId, link, onStart, onLeave }: Props) {
  // 对局时钟：500ms 一跳足够（展示粒度是秒）；endsAt 是服务端权威，这里只算展示值
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.status]);

  const owner = isOwner(state, userId);
  const full = state.players.length >= 2;

  return (
    <>
      <section className="sb-pk-card">
        <div className="sb-pk-code-row">
          <span className="sb-pk-code-label">房号</span>
          <span className="sb-pk-code">
            {state.roomCode.slice(0, 3)} {state.roomCode.slice(3)}
          </span>
          <span className={link === 'open' ? 'sb-pk-link ok' : 'sb-pk-link'}>{LINK_TEXT[link]}</span>
        </div>
        {state.status === 'waiting' && (
          <p className="sb-pk-hint">把房号念给对手，TA 在大厅「输码入房」即可坐下</p>
        )}
      </section>

      {state.status === 'waiting' && (
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">等待开局</h2>
          {state.players.map((p, i) => (
            <div key={p.userId} className="sb-pk-player">
              <span className="sb-pk-seat">{i === 0 ? '房主' : '对手'}</span>
              <span className="sb-pk-nick">{p.nickname}</span>
            </div>
          ))}
          {!full && <div className="sb-pk-player pending">等待对手进房…</div>}
          {owner ? (
            <button type="button" className="sb-pk-btn primary" disabled={!full} onClick={onStart}>
              {full ? '开局（8 分钟）' : '还要等对手进房'}
            </button>
          ) : (
            <div className="sb-pk-hint">等房主开局</div>
          )}
          <button type="button" className="sb-pk-btn" onClick={onLeave}>
            返回大厅
          </button>
        </section>
      )}

      {state.status === 'active' && (
        <section className="sb-pk-card">
          <div className="sb-pk-clock">{formatClock(remainingMs(state.endsAt, now))}</div>
          <div className="sb-pk-score">
            {state.players.map((p) => (
              <div key={p.userId} className={p.userId === userId ? 'sb-pk-side me' : 'sb-pk-side'}>
                <span className="sb-pk-nick">{p.nickname}</span>
                <span className="sb-pk-score-num">{p.score}</span>
              </div>
            ))}
          </div>
          <div className="sb-pk-todo">出题 / 答题动作区在 P0-2（计分引擎）落地后开放</div>
        </section>
      )}

      {state.status === 'finished' && (
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">{state.winner ? '对局结束' : '平局'}</h2>
          {state.winner && (
            <p className="sb-pk-winner">
              {state.players.find((p) => p.userId === state.winner)?.nickname ?? '对手'} 获胜
            </p>
          )}
          <div className="sb-pk-score">
            {state.players.map((p) => (
              <div key={p.userId} className="sb-pk-side">
                <span className="sb-pk-nick">{p.nickname}</span>
                <span className="sb-pk-score-num">{p.score}</span>
              </div>
            ))}
          </div>
          <button type="button" className="sb-pk-btn" onClick={onLeave}>
            返回大厅
          </button>
        </section>
      )}
    </>
  );
}
