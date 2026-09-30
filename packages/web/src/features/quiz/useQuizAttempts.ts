/**
 * useQuizAttempts — 题卡的作答记录（契约 `docs/QUIZ-REVIEW-SPEC.md`「作答记录」节，2026-09-30）。
 *
 * ★ 有 `quizId` 的卡才记（2026-09-23 之后出的题都有；老卡没有 ⇒ `enabled=false`，行为与从前一样）。
 * ★ 乐观更新：答完立刻用 shared `applyQuizAttempt` 在本地算出新行（与服务端同一函数），再把服务端回的那行覆盖上——
 *   网络慢时顶部那行字也不会滞后一拍；失败**不回滚**（用户确实答了这题，页面上的判分是真的），只把没记上这件事说出来。
 * ★ 读不到 / 记不上都不打断答题：错误只是一行字（ADR-5：不静默）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QuizAttemptInput, QuizAttemptRow, QuizQuestion, QuizReviewItem } from '@sb/shared';
import { applyQuizAttempt, summarizeQuizAttempts } from '@sb/shared';
import { quizAttemptsApi } from '../../lib/api-quiz-attempts';

const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

/** 同题号的行只留最新那份；按题号排好，顶部汇总与每题小标都按它读 */
function merge(rows: QuizAttemptRow[], row: QuizAttemptRow): QuizAttemptRow[] {
  return [...rows.filter((r) => r.index !== row.index), row].sort((a, b) => a.index - b.index);
}

export function useQuizAttempts(quizId: string | undefined, questions: readonly QuizQuestion[]) {
  const [rows, setRows] = useState<QuizAttemptRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!quizId) return;
    let alive = true;
    quizAttemptsApi
      .list(quizId)
      .then((v) => {
        if (alive) setRows(v.rows);
      })
      .catch((e: unknown) => {
        if (alive) setError(`这组题以前的作答记录没读到：${errText(e, '稍后刷新再看')}`);
      });
    return () => {
      alive = false;
    };
  }, [quizId]);

  /** 题卡判完一题就调它；老卡（无 quizId）是空操作 */
  const record = useCallback(
    (index: number, item: QuizReviewItem) => {
      if (!quizId) return;
      const input: QuizAttemptInput = { questionIndex: index, verdict: item.verdict, answer: item.answer };
      const at = new Date().toISOString();
      setRows((prev) => merge(prev, applyQuizAttempt(prev.find((r) => r.index === index), input, at)));
      setError('');
      quizAttemptsApi
        .record(quizId, input)
        .then(({ row }) => setRows((prev) => merge(prev, row)))
        .catch((e: unknown) => setError(`第 ${index + 1} 题的作答没记上（页面上的判分不受影响）：${errText(e, '网络或服务端出错')}`));
    },
    [quizId],
  );

  const types = useMemo(() => questions.map((q) => q.type), [questions]);
  const summary = useMemo(() => summarizeQuizAttempts(rows, types), [rows, types]);
  const lastOf = useCallback((index: number) => rows.find((r) => r.index === index)?.last ?? null, [rows]);
  return { enabled: !!quizId, rows, summary, error, record, lastOf };
}
