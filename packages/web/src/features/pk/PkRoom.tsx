/**
 * PkRoom — 房间视图（waiting / active / finished 三态，契约 docs/PK-SPEC.md §5）。
 *
 * 全部数据来自服务端快照（SSE pk-state 或轮询）：比分、房号、对局时钟都是真数据，
 * 客户端不发明状态。active 委派给 PkMatch（出题/答题双动作区）；
 * finished 回看题目——`chosen`/`answerRevealed` 只在判定后由服务端下发。
 */
import { isAiUserId } from '@sb/shared';
import type { PkRoomState } from '@sb/shared';
import type { SseReadyState } from '../../lib/sse-client';
import { optionLetter } from './pk-view';
import { PkMatch } from './PkMatch';

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
  const owner = state.players[0]?.userId === userId;
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

      {state.status === 'active' && <PkMatch state={state} userId={userId} />}

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
                <span className="sb-pk-nick">
                  {p.nickname}
                  {isAiUserId(p.userId) && <span className="sb-pk-ai-tag">AI</span>}
                </span>
                <span className="sb-pk-score-num">{p.score}</span>
                <span className="sb-pk-sub">
                  答对 {p.correct}/{p.answered}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {state.status === 'finished' && state.questions.length > 0 && (
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">回看题目</h2>
          {state.questions.map((q, qi) => (
            <div key={q.id} className="sb-pk-review">
              <div className="sb-pk-q-head">
                <span className="sb-pk-seat">第 {qi + 1} 题 · {isAiUserId(q.fromUserId) ? 'AI 出' : '对手出'}</span>
                <span className={q.chosen === q.answerRevealed ? 'sb-pk-verdict ok' : 'sb-pk-verdict'}>
                  {q.status === 'timeout' ? '超时 −1' : q.chosen === q.answerRevealed ? '答对 +2' : '答错 −1'}
                </span>
              </div>
              <p className="sb-pk-stem">{q.stem}</p>
              <div className="sb-pk-review-opts">
                {q.options.map((opt, i) => (
                  <div
                    key={i}
                    className={
                      i === q.answerRevealed
                        ? 'sb-pk-review-opt correct'
                        : i === q.chosen
                          ? 'sb-pk-review-opt wrong'
                          : 'sb-pk-review-opt'
                    }
                  >
                    {optionLetter(i)}. {opt}
                    {i === q.chosen && ' ← 已选'}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button type="button" className="sb-pk-btn" onClick={onLeave}>
            返回大厅
          </button>
        </section>
      )}
    </>
  );
}
