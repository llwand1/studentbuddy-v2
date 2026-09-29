/**
 * AiGradeNote — 填空（字面对不上）与解答题提交后，请 AI 按量规判一次，并显示判定、反馈与误区。
 *
 * ★ 只在"前端判不了"的两种情形出现：填空逐字比对没对上（`verdict='review'`）、解答题。
 *   选择/判断与逐字对上的填空前端自己就判得准，不花模型钱。
 * ★ 服务端判完会自己记学习事件与误区 ⇒ 这类题前端**不再** `reportAnswer`，免得一题记两次。
 * ★ 失败不是大事：原来的"对照参考答案"仍在上方，这里只说一句判不了的原因（没配模型要说清去哪配）。
 */
import { useEffect, useState } from 'react';
import type { GradeResult, QuizQuestion, QuizReviewItem } from '@sb/shared';
import { aiOpsApi } from '../../lib/api-ai-ops';
import { ApiError } from '../../lib/api-request';

const VERDICT: Record<GradeResult['verdict'], string> = { correct: '✓ AI 判定：答对了', partial: '◐ AI 判定：部分正确', wrong: '✗ AI 判定：还不对' };

export function gradeErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 503) return 'AI 评分暂不可用：还没有配置模型（设置页可配）。请对照上方参考答案。';
  if (e instanceof ApiError && e.status === 504) return 'AI 评分超时了，请对照上方参考答案。';
  return 'AI 评分没有成功，请对照上方参考答案。';
}

export function AiGradeNote({ q, result, topic }: { q: QuizQuestion; result: QuizReviewItem; topic?: string }) {
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    aiOpsApi
      .grade(
        {
          question: q.question,
          reference: result.expected,
          answer: result.answer,
          qtype: q.type === 'fill' ? 'fill' : 'essay',
          ...(topic ? { topic } : {}),
        },
        ac.signal,
      )
      .then(setGrade)
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(gradeErrorText(e));
      });
    return () => ac.abort();
  }, [q, result, topic]);

  if (error) return <p className="quiz-muted quiz-ai-grade">{error}</p>;
  if (!grade) return <p className="quiz-muted quiz-ai-grade" role="status">AI 正在按要点评分…</p>;
  return (
    <div className={`quiz-ai-grade is-${grade.verdict}`} role="status">
      <strong>{VERDICT[grade.verdict]}（{Math.round(grade.score * 100)} 分）</strong>
      <p>{grade.feedback}</p>
      {grade.misconception && <p className="quiz-ai-mis"><b>可能的误区：</b>{grade.misconception}（已记入学习画像）</p>}
    </div>
  );
}
