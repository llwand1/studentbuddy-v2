/**
 * PkMatch — 对局进行中视图（P0-2/PVE/P0-7/P0-8 + UX 批，契约 docs/PK-SPEC.md §1/§5/§9）。
 *
 * **UX 批（2026-09-15）的核心改动：中央区只放「当前唯一要做的事」**——
 * ① 有题要答 → 答题；② 对方正在出题 → 出题中的过渡提示；③ 都没有 → 出题。
 * 其余（出题入口／已发出的题／已判定／投降）收进底部折叠区。原来七块纵向平铺，
 * 375px 宽下每块都只能压扁，按钮自然挤成一团（老板实测原话「按键都挤在一起」）。
 *
 * ★ 出题入口**永远可达**：它不在主区时就在折叠区里（不做「答题时不能出题」的硬限制——
 *   两件事本来就可以并行，只是不该同时占满屏幕）。
 *
 * 全部计时读服务端时间戳（nextQuizAt/deadlineAt），本组件的 500ms interval 只驱动展示。
 * 判分不在这里算：点选项 → POST answer → 服务端判分 → SSE pk-state 回灌快照（单一事实源）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
  quizPendingLabel,
  quizPendingSec,
  remainingMs,
  retryRemainingMs,
} from './pk-view';
import { PkAnswerBlock } from './PkAnswerBlock';
import { PkArena } from './PkArena';
import { PkForfeit } from './PkForfeit';
import { PkJudgePanel } from './PkJudgePanel';
import { PkQuizBlock } from './PkQuizBlock';
import { PkQuizPending } from './PkQuizPending';
import { PkTopicBar } from './PkTopicBar';
import { PkVerdict } from './PkVerdict';

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

/** 中央反馈（判分或提示）；`kind` 决定图标与动画档位 */
interface Verdict {
  kind: 'correct' | 'wrong' | 'timeout' | 'info';
  text: string;
}

const VERDICT_MS = 2500;

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
  /** UX 批：替代原「一行 flash 文字」——带图标与动画的判分/提示 */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [judge, setJudge] = useState<JudgeView | null>(null);
  /** 底部折叠区（出题入口 / 已发出 / 已判定 / 投降） */
  const [open, setOpen] = useState(false);

  /**
   * 闪光计时句柄。★ 必须存下来：不存的话连点两个选项会挂着两条独立计时器，第一条到点就把
   * 第二条刚亮起来的判定抹掉（第二条只闪零点几秒，等于白答一次没反馈），卸载后还会继续 setState。
   */
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((v: Verdict) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setVerdict(v);
    flashTimer.current = setTimeout(() => setVerdict(null), VERDICT_MS);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const mine = myPendingQuestion(state, userId);
  const sent = pendingToOpponent(state, userId);
  const pending = quizPendingLabel(state, userId);
  const cd = cdRemainingMs(state, userId, now);
  const helpLeft = myHelpLeft(state, userId);
  const retryCd = retryRemainingMs(state, userId, now);
  /** 我答错的题（二次机会的候选）；按 id 建集合避免在渲染里反复过滤 */
  const wrongIds = new Set(myWrongQuestions(state, userId).map((q) => q.id));
  const done = state.questions.filter((q) => q.status !== 'pending');
  /** 出题区是否已在主区（不在主区时，折叠区里必须再给它一个入口） */
  const quizInMain = !mine && !pending;

  const submitQuiz = useCallback(async () => {
    if (!prompt.trim() || quizBusy) return;
    setQuizBusy(true);
    setQuizErr('');
    setJudge(null);
    try {
      await api.pk.submitQuiz(state.roomId, prompt.trim());
      setPrompt('');
    } catch (e) {
      setQuizErr(e instanceof ApiError ? e.message : '出题失败，请重试');
      // 累计跑题到阈值时裁判会给建议——**必须显示出来**：只说「跑题了」，玩家不知道该往哪改
      const advice = adviceOf(e);
      if (advice) setJudge({ title: '裁判建议：这样出题才贴题', advice });
    } finally {
      setQuizBusy(false);
    }
  }, [prompt, quizBusy, state.roomId]);

  const answer = useCallback(
    async (choice: number) => {
      if (answerBusy || !mine) return;
      setAnswerBusy(true);
      try {
        const r = await api.pk.submitAnswer(state.roomId, mine.id, choice);
        flash({ kind: r.correct ? 'correct' : 'wrong', text: r.correct ? `答对 +${r.delta}` : `答错 ${r.delta}` });
      } catch (e) {
        flash({ kind: 'info', text: e instanceof ApiError ? e.message : '提交失败' });
      } finally {
        setAnswerBusy(false);
      }
    },
    [answerBusy, flash, mine, state.roomId],
  );

  /** 求助道具：就某道题请裁判指点（当场联网搜索）。用完按钮自动消失——helpLeft 来自服务端快照 */
  const help = useCallback(async () => {
    if (!mine) return;
    setJudge(null);
    try {
      const r = await api.pk.useHelp(state.roomId, mine.id);
      setJudge({ title: '裁判指点（给思路，不给答案）', advice: r.advice });
    } catch (e) {
      flash({ kind: 'info', text: e instanceof ApiError ? e.message : '求助失败' });
    }
  }, [flash, mine, state.roomId]);

  /** 二次机会：选一道答错的题，换现场解析 + 同主题类似题 */
  const retry = useCallback(
    async (questionId: string) => {
      setJudge(null);
      try {
        const r = await api.pk.requestRetry(state.roomId, questionId);
        setJudge({ title: '二次机会：现场解析', explanation: r.explanation });
        flash({ kind: 'info', text: r.question ? '已出类似题，答对 +2' : '这次没出出题，解析照给' });
      } catch (e) {
        flash({ kind: 'info', text: e instanceof ApiError ? e.message : '二次机会失败' });
      }
    },
    [flash, state.roomId],
  );

  /** 出题区（主区或折叠区共用同一份实例参数，避免两处逻辑分叉） */
  const quizBlock = (
    <PkQuizBlock
      topic={state.currentTopic}
      prompt={prompt}
      cd={cd}
      busy={quizBusy}
      error={quizErr}
      onPrompt={setPrompt}
      onSubmit={() => void submitQuiz()}
    />
  );

  return (
    <PkArena state={state} userId={userId}>
      <PkTopicBar state={state} userId={userId} />

      {verdict && <PkVerdict kind={verdict.kind} text={verdict.text} />}

      {judge && (
        <PkJudgePanel
          title={judge.title}
          advice={judge.advice}
          explanation={judge.explanation}
          onClose={() => setJudge(null)}
        />
      )}

      {/* 中央：当前唯一要做的事（三选一，互斥——不并列堆叠） */}
      {mine ? (
        <PkAnswerBlock
          question={mine}
          helpLeft={helpLeft}
          disabled={answerBusy}
          onAnswer={(i) => void answer(i)}
          onHelp={() => void help()}
          now={now}
        />
      ) : pending ? (
        <PkQuizPending text={pending.text} sec={quizPendingSec(state, now)} />
      ) : (
        quizBlock
      )}

      <div className="sb-pk-fold">
        <button type="button" className="sb-pk-fold-btn" onClick={() => setOpen(!open)}>
          <span className="sb-pk-fold-caret">{open ? '收起' : '展开'}</span>
          <span className="sb-pk-fold-sum">
            {quizInMain ? '' : '出题 · '}
            {sent ? '等待对手作答 · ' : ''}已判定 {done.length}
          </span>
        </button>

        {open && (
          <div className="sb-pk-fold-body">
            {!quizInMain && quizBlock}

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
              {done.length === 0 && <p className="sb-pk-hint">还没有题目被判定</p>}
              {done.map((q) => (
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
          </div>
        )}
      </div>
    </PkArena>
  );
}
