/**
 * PkRoom — 房间视图（waiting / active / finished 三态，契约 docs/PK-SPEC.md §5）。
 *
 * 全部数据来自服务端快照（SSE pk-state 或轮询）：比分、房号、对局时钟都是真数据，
 * 客户端不发明状态。active 委派给 PkMatch（出题/答题双动作区）；
 * finished 回看题目——`chosen`/`answerRevealed` 只在判定后由服务端下发。
 */
import { useState } from 'react';
import { isAiUserId } from '@sb/shared';
import type { PkRoomState } from '@sb/shared';
import type { SseReadyState } from '../../lib/sse-client';
import { PkMatch } from './PkMatch';
import { PkResult } from './PkResult';

interface Props {
  state: PkRoomState;
  userId: string;
  link: SseReadyState;
  busy: boolean;
  onStart: () => void;
  /** P0-7：选定本人的对战主题（仅 waiting 期可改——开局后改主题＝中途改规则） */
  onSetTopic: (topic: string) => void;
  /** P0-8：认输（对手胜、比分定格） */
  onForfeit: () => void;
  onLeave: () => void;
}

const LINK_TEXT: Record<SseReadyState, string> = {
  connecting: '连接中',
  open: '实时同步',
  reconnecting: '重连中',
  closed: '轮询同步',
};

export function PkRoom({ state, userId, link, busy, onStart, onSetTopic, onForfeit, onLeave }: Props) {
  const owner = state.players[0]?.userId === userId;
  const full = state.players.length >= 2;
  /** P0-7：我自己还没定主题（AI 座位不需要人填，故除外） */
  const me = state.players.find((p) => p.userId === userId);
  const needTopic = state.status === 'waiting' && !isAiUserId(userId) && !me?.topic.trim();
  const [topicDraft, setTopicDraft] = useState('');

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
        <div className="sb-pk-mode-row">
          <span className={state.mode === 'pve' ? 'sb-pk-mode-pill ai' : 'sb-pk-mode-pill'}>
            {state.mode === 'pve' ? 'AI 对战' : '双人对战'}
          </span>
          {state.aiTopic && <span className="sb-pk-mode-pill">主题：{state.aiTopic}</span>}
        </div>
        {state.status === 'waiting' && (
          <p className="sb-pk-hint">
            {state.mode === 'pve' ? 'AI 对手已入座，随时可以开局' : '把房号念给对手，TA 在大厅「输码入房」即可坐下'}
          </p>
        )}
      </section>

      {state.status === 'waiting' && (
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">等待开局</h2>
          {state.players.map((p, i) => (
            <div key={p.userId} className="sb-pk-player">
              <span className="sb-pk-seat">{i === 0 ? '房主' : '对手'}</span>
              <span className="sb-pk-nick">
                {p.nickname}
                {isAiUserId(p.userId) && <span className="sb-pk-ai-tag">AI</span>}
              </span>
              <span className={p.topic ? 'sb-pk-sub' : 'sb-pk-sub dim'}>
                {p.topic ? `主题：${p.topic}` : '未选主题'}
              </span>
            </div>
          ))}
          {!full && <div className="sb-pk-player pending">等待对手进房…</div>}
          {needTopic && (
            <form
              className="sb-pk-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!topicDraft.trim()) return;
                onSetTopic(topicDraft.trim());
              }}
            >
              <input
                className="sb-pk-input"
                placeholder="你的对战主题（如：光合作用）"
                maxLength={20}
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value)}
              />
              <button type="submit" className="sb-pk-btn primary" disabled={busy || !topicDraft.trim()}>
                选定主题
              </button>
            </form>
          )}
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
        <PkMatch state={state} userId={userId} busy={busy} onForfeit={onForfeit} />
      )}

      {state.status === 'finished' && <PkResult state={state} userId={userId} onLeave={onLeave} />}
    </>
  );
}
