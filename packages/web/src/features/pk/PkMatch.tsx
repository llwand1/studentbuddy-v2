/**
 * PkMatch — 对局进行中视图（P0-2/PVE，契约 docs/PK-SPEC.md §1/§5）。
 *
 * 双动作区（人机对称，PVP 同一套 UI）：出题（提示词 + CD 倒计时）与答题（四选项 + 45s 时限）。
 * 全部计时读服务端时间戳（nextQuizAt/deadlineAt），本组件的 500ms interval 只驱动展示。
 * 判分不在这里算：点选项 → POST answer → 服务端判分 → SSE pk-state 回灌快照（单一事实源）。
 */
import { useCallback, useEffect, useState } from 'react';
import { isAiUserId, type PkRoomState } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { cdRemainingMs, formatClock, myPendingQuestion, optionLetter, pendingToOpponent, remainingMs } from './pk-view';

interface Props {
  state: PkRoomState;
  userId: string;
}

export function PkMatch({ state, userId }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const [prompt, setPrompt] = useState('');
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizErr, setQuizErr] = useState('');
  /** 刚收到的判分反馈（本地短暂展示；分数真值以 SSE 快照为准） */
  const [flash, setFlash] = useState('');
  const [answerBusy, setAnswerBusy] = useState(false);

  const mine = myPendingQuestion(state, userId);
  const sent = pendingToOpponent(state, userId);
  const cd = cdRemainingMs(state, userId, now);

  const submitQuiz = useCallback(async () => {
    if (!prompt.trim() || quizBusy) return;
    setQuizBusy(true);
    setQuizErr('');
    try {
      await api.pk.submitQuiz(state.roomId, userId, prompt.trim());
      setPrompt('');
    } catch (e) {
      setQuizErr(e instanceof ApiError ? e.message : '出题失败，请重试');
    } finally {
      setQuizBusy(false);
    }
  }, [prompt, quizBusy, state.roomId, userId]);

  const answer = useCallback(
    async (questionId: string, choice: number) => {
      if (answerBusy) return;
      setAnswerBusy(true);
      try {
        const r = await api.pk.submitAnswer(state.roomId, userId, questionId, choice);
        setFlash(r.correct ? `答对 +${r.delta}` : `答错 ${r.delta}`);
        setTimeout(() => setFlash(''), 2500);
      } catch (e) {
        setFlash(e instanceof ApiError ? e.message : '提交失败');
        setTimeout(() => setFlash(''), 2500);
      } finally {
        setAnswerBusy(false);
      }
    },
    [answerBusy, state.roomId, userId],
  );

  return (
    <>
      <section className="sb-pk-card">
        <div className="sb-pk-clock">{formatClock(remainingMs(state.endsAt, now))}</div>
        <div className="sb-pk-score">
          {state.players.map((p) => (
            <div key={p.userId} className={p.userId === userId ? 'sb-pk-side me' : 'sb-pk-side'}>
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
        {flash && <div className="sb-pk-flash">{flash}</div>}
      </section>

      {mine && (
        <section className="sb-pk-card">
          <div className="sb-pk-q-head">
            <span className="sb-pk-h2">轮到你答</span>
            <span className="sb-pk-deadline">{Math.ceil(remainingMs(mine.deadlineAt, now) / 1000)}s</span>
          </div>
          <p className="sb-pk-stem">{mine.stem}</p>
          <div className="sb-pk-options">
            {mine.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                className="sb-pk-option"
                disabled={answerBusy}
                onClick={() => void answer(mine.id, i)}
              >
                <span className="sb-pk-option-letter">{optionLetter(i)}</span>
                {opt}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="sb-pk-card">
        <div className="sb-pk-q-head">
          <span className="sb-pk-h2">出题给对手</span>
          {cd > 0 && <span className="sb-pk-deadline">冷却 {formatClock(cd)}</span>}
        </div>
        <p className="sb-pk-hint">写提示词让 AI 给对手出一道单选题；成功 +1（60s 冷却）</p>
        <form
          className="sb-pk-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitQuiz();
          }}
        >
          <input
            className="sb-pk-input"
            placeholder="如：出初二物理浮力相关的题（≤300 字）"
            maxLength={300}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" className="sb-pk-btn primary" disabled={quizBusy || cd > 0 || !prompt.trim()}>
            {quizBusy ? 'AI 出题中…' : cd > 0 ? '冷却中' : '出题'}
          </button>
        </form>
        {quizErr && <div className="sb-pk-error">{quizErr}</div>}
      </section>

      {sent && (
        <section className="sb-pk-card">
          <div className="sb-pk-q-head">
            <span className="sb-pk-hint">
              {isAiUserId(sent.toUserId) ? 'AI 对手思考中…' : '等待对手作答…'}
            </span>
            <span className="sb-pk-deadline">{Math.ceil(remainingMs(sent.deadlineAt, now) / 1000)}s</span>
          </div>
          <p className="sb-pk-stem">{sent.stem}</p>
        </section>
      )}

      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">已判定</h2>
        {state.questions.filter((q) => q.status !== 'pending').length === 0 && (
          <p className="sb-pk-hint">还没有题目被判定</p>
        )}
        {state.questions
          .filter((q) => q.status !== 'pending')
          .map((q) => (
            <div key={q.id} className="sb-pk-done">
              <span className="sb-pk-stem">{q.stem}</span>
              <span className={q.chosen === q.answerRevealed ? 'sb-pk-verdict ok' : 'sb-pk-verdict'}>
                {q.status === 'timeout' ? '超时 −1' : q.chosen === q.answerRevealed ? '答对 +2' : '答错 −1'}
                {' · '}
                正确答案 {optionLetter(q.answerRevealed ?? -1)}
              </span>
            </div>
          ))}
      </section>
    </>
  );
}
