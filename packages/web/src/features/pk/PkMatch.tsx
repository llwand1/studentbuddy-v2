/**
 * PkMatch — 对局进行中视图（P0-2/PVE/P0-7，契约 docs/PK-SPEC.md §1/§5/§9）。
 *
 * 双动作区（人机对称，PVP 同一套 UI）：出题（提示词 + CD 倒计时）与答题（四选项 + 45s 时限）。
 * 全部计时读服务端时间戳（nextQuizAt/deadlineAt），本组件的 500ms interval 只驱动展示。
 * 判分不在这里算：点选项 → POST answer → 服务端判分 → SSE pk-state 回灌快照（单一事实源）。
 *
 * P0-7 加三块：① 主题条（本轮考谁的领域，出题必须贴合）；
 * ② 求助道具（每局 1 个，裁判当场联网搜索给思路，不给答案）；
 * ③ 错题二次机会（选一道答错的题换现场解析 + 同主题类似题，3 分钟 CD）。
 */
import { useCallback, useEffect, useState } from 'react';
import { isAiUserId, type PkJudgeAdvice, type PkRoomState } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import {
  cdRemainingMs,
  formatClock,
  myHelpLeft,
  myPendingQuestion,
  myWrongQuestions,
  optionLetter,
  pendingToOpponent,
  remainingMs,
  retryRemainingMs,
} from './pk-view';
import { PkTopicBar } from './PkTopicBar';
import { PkJudgePanel } from './PkJudgePanel';
import { PkForfeit } from './PkForfeit';

interface Props {
  state: PkRoomState;
  userId: string;
  /** P0-8：投降请求在途（PkApp 的全局 busy）——按钮据此防重复提交 */
  busy: boolean;
  /** P0-8：认输（对手胜、本局比分定格）；两段确认在 `PkForfeit` 内部 */
  onForfeit: () => void;
}

/** 裁判面板三态之一（跑题建议 / 求助结果 / 二次机会解析，一次只显示一个） */
interface JudgeView {
  title: string;
  advice?: PkJudgeAdvice;
  explanation?: string;
}

/**
 * 从错误响应体里取裁判建议（域层塞在 `extra.advice`，见 match.ts 抛 TOPIC_MISMATCH 处）。
 * ★ 拿不到就返回 null、不造假建议——宁可只显示「跑题了」，也不能编一句看起来像裁判说的话。
 */
function adviceOf(e: unknown): PkJudgeAdvice | null {
  if (!(e instanceof ApiError)) return null;
  const extra = (e.body as { extra?: { advice?: PkJudgeAdvice } } | undefined)?.extra;
  return extra?.advice ?? null;
}

export function PkMatch({ state, userId, busy, onForfeit }: Props) {
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
  const [judge, setJudge] = useState<JudgeView | null>(null);

  const mine = myPendingQuestion(state, userId);
  const sent = pendingToOpponent(state, userId);
  const cd = cdRemainingMs(state, userId, now);
  const helpLeft = myHelpLeft(state, userId);
  const retryCd = retryRemainingMs(state, userId, now);
  /** 我答错的题（二次机会的候选）；按 id 建集合避免在渲染里反复过滤 */
  const wrongIds = new Set(myWrongQuestions(state, userId).map((q) => q.id));

  const submitQuiz = useCallback(async () => {
    if (!prompt.trim() || quizBusy) return;
    setQuizBusy(true);
    setQuizErr('');
    setJudge(null);
    try {
      await api.pk.submitQuiz(state.roomId, userId, prompt.trim());
      setPrompt('');
    } catch (e) {
      setQuizErr(e instanceof ApiError ? e.message : '出题失败，请重试');
      // 累计跑题到阈值时裁判会给建议——**必须显示出来**：只说「跑题了」，玩家不知道该往哪改
      const advice = adviceOf(e);
      if (advice) setJudge({ title: '裁判建议：这样出题才贴题', advice });
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

  /** 求助道具：就某道题请裁判指点（当场联网搜索）。用完按钮自动消失——helpLeft 来自服务端快照 */
  const help = useCallback(
    async (questionId: string) => {
      setJudge(null);
      try {
        const r = await api.pk.useHelp(state.roomId, userId, questionId);
        setJudge({ title: '裁判指点（给思路，不给答案）', advice: r.advice });
      } catch (e) {
        setFlash(e instanceof ApiError ? e.message : '求助失败');
        setTimeout(() => setFlash(''), 2500);
      }
    },
    [state.roomId, userId],
  );

  /** 二次机会：选一道答错的题，换现场解析 + 同主题类似题 */
  const retry = useCallback(
    async (questionId: string) => {
      setJudge(null);
      try {
        const r = await api.pk.requestRetry(state.roomId, userId, questionId);
        setJudge({ title: '二次机会：现场解析', explanation: r.explanation });
        setFlash(r.question ? '已出类似题，答对 +2' : '这次没出出题，解析照给');
        setTimeout(() => setFlash(''), 2500);
      } catch (e) {
        setFlash(e instanceof ApiError ? e.message : '二次机会失败');
        setTimeout(() => setFlash(''), 2500);
      }
    },
    [state.roomId, userId],
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
                答对 {p.correct}/{p.answered} · 求助 {p.helpLeft}
              </span>
            </div>
          ))}
        </div>
        {flash && <div className="sb-pk-flash">{flash}</div>}
        <PkTopicBar state={state} userId={userId} />
      </section>

      {judge && (
        <PkJudgePanel
          title={judge.title}
          advice={judge.advice}
          explanation={judge.explanation}
          onClose={() => setJudge(null)}
        />
      )}

      {mine && (
        <section className="sb-pk-card">
          <div className="sb-pk-q-head">
            <span className="sb-pk-h2">{mine.isRetry ? '补救题（答对 +2）' : '轮到你答'}</span>
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
          {helpLeft > 0 && (
            <button type="button" className="sb-pk-btn ghost" onClick={() => void help(mine.id)}>
              用求助道具（还剩 {helpLeft} 个）
            </button>
          )}
        </section>
      )}

      <section className="sb-pk-card">
        <div className="sb-pk-q-head">
          <span className="sb-pk-h2">出题给对手</span>
          {cd > 0 && <span className="sb-pk-deadline">冷却 {formatClock(cd)}</span>}
        </div>
        <p className="sb-pk-hint">
          题目必须贴合本轮主题「{state.currentTopic || '（待定）'}」，跑题会被裁判判失败；成功 +1（60s 冷却）
        </p>
        <form
          className="sb-pk-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitQuiz();
          }}
        >
          <input
            className="sb-pk-input"
            placeholder="如：出一道关于浮力的题（≤300 字）"
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
              <span className="sb-pk-stem">
                {q.isRetry && <span className="sb-pk-retry-tag">补救</span>}
                {q.stem}
              </span>
              <span className={q.chosen === q.answerRevealed ? 'sb-pk-verdict ok' : 'sb-pk-verdict'}>
                {q.status === 'timeout' ? '超时 −1' : q.chosen === q.answerRevealed ? '答对 +2' : '答错 −1'}
                {' · '}
                正确答案 {optionLetter(q.answerRevealed ?? -1)}
              </span>
              {wrongIds.has(q.id) && (
                <button
                  type="button"
                  className="sb-pk-btn ghost"
                  disabled={retryCd > 0}
                  onClick={() => void retry(q.id)}
                >
                  {retryCd > 0 ? `二次机会 ${formatClock(retryCd)}` : '二次机会（+2）'}
                </button>
              )}
            </div>
          ))}
      </section>

      <PkForfeit busy={busy} onForfeit={onForfeit} />
    </>
  );
}
