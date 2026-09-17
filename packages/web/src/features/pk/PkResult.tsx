/**
 * PkResult — 对局结算面板（UX 批，2026-09-15 老板点单「胜利失败等事件的 UI、动画效果太少」）。
 *
 * 三层信息依次入场（`sb-pk-result` 的 CSS 用递增 `animation-delay` 做逐条淡入）：
 * ① 胜负徽章（弹入）② 双方终分（跳入）③ 统计与原因。
 *
 * ★ 认输必须说清是谁认输：`finishTitle` / `reasonLabel` 会把「对方认输」与「自己认输」
 *   分开写——只显示「对局结束」，投降的人不确定自己那一步到底生效了没有
 *   （他会原地怀疑按钮坏了，P0-8 契约里就为这条专门加了 `endReason`）。
 *
 * ★ 题目回看默认收起：结算的第一诉求是「我赢了还是输了」，不是立刻复盘。
 *   收起不等于藏起来——一行「回看题目（N）」就在这里。
 */
import { useState } from 'react';
import { isAiUserId, type PkRoomState } from '@sb/shared';
import { finishTitle, myOutcome, reasonLabel } from './pk-view';
import { PkReviewList } from './PkReviewList';

interface Props {
  state: PkRoomState;
  userId: string;
  onLeave: () => void;
}

const BADGE_TEXT = { win: '胜', lose: '负', draw: '平' } as const;

export function PkResult({ state, userId, onLeave }: Props) {
  const outcome = myOutcome(state, userId);
  const reason = reasonLabel(state.endReason ?? 'timeup', outcome);
  const winner = state.players.find((p) => p.userId === state.winner);
  const [review, setReview] = useState(false);

  return (
    <>
      <section className={`sb-pk-result ${outcome}`}>
        <div className="sb-pk-result-badge">
          {outcome === 'win' && (
            <svg className="sb-pk-cup" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
              <path d="M12 14v3M8.5 20h7" />
            </svg>
          )}
          <span>{BADGE_TEXT[outcome]}</span>
        </div>

        <h2 className="sb-pk-result-title">{finishTitle(state, userId)}</h2>
        <p className="sb-pk-result-reason">{reason}</p>

        <div className="sb-pk-result-score">
          {state.players.map((p) => (
            <div key={p.userId} className={p.userId === state.winner ? 'sb-pk-result-side won' : 'sb-pk-result-side'}>
              <span className="sb-pk-nick">
                {p.nickname}
                {isAiUserId(p.userId) && <span className="sb-pk-ai-tag">AI</span>}
              </span>
              <span className="sb-pk-result-num">{p.score}</span>
              <span className="sb-pk-sub">
                答对 {p.correct}/{p.answered}
              </span>
            </div>
          ))}
        </div>

        {winner && <p className="sb-pk-winner">{winner.nickname} 获胜</p>}

        {state.questions.length > 0 && (
          <button type="button" className="sb-pk-btn ghost" onClick={() => setReview(!review)}>
            {review ? '收起题目' : `回看题目（${state.questions.length}）`}
          </button>
        )}

        <button type="button" className="sb-pk-btn primary" onClick={onLeave}>
          返回大厅
        </button>
      </section>

      {review && state.questions.length > 0 && (
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">回看题目</h2>
          <PkReviewList questions={state.questions} userId={userId} />
        </section>
      )}
    </>
  );
}
