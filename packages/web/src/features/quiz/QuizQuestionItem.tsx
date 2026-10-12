import { useState } from 'react';
import type { QuizFeedbackResult, QuizQuestion, QuizReviewItem, QuizRoundResponse, QuizDraftAnswer } from '@sb/shared';
import { QUIZ_ATTEMPT_MARK, QUIZ_TIER_HINTS, QUIZ_TIER_LABELS, tierOf, type QuizAttemptRow } from '@sb/shared';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import { Markdown } from '../chat/Markdown';
import { MathText } from '../chat/MathText';
import { fillCount, optionsFor, reviewAttempt } from './quiz-attempt';
import { aiOpsApi, answerQType } from '../../lib/api-ai-ops';
import { AiGradeNote } from './AiGradeNote';
import { FillBlank } from './FillBlank';
import { AnswerImpact } from '../feedback/AnswerImpact';
import { QuestionFeedback } from './QuestionFeedback';
import { QuestionThinking } from './QuestionThinking';
import { QuestionAnalysis } from './QuestionAnalysis';

function QuizPhotoFigure({ photo }: { photo: NonNullable<QuizQuestion['photo']> }) {
  return (
    <figure className="quiz-q-photo">
      <img src={photo.src} alt={photo.alt} loading="lazy" />
      <figcaption>
        {photo.pageUrl ? <a href={photo.pageUrl} target="_blank" rel="noreferrer noopener">{photo.credit}</a> : photo.credit}
      </figcaption>
    </figure>
  );
}

export function QuizQuestionItem({ q, index, onComplete, topic, last, sessionId, onAdapted, roundResponse, onDraftChange, onRetryAnalysis, disabled = false }: {
  q: QuizQuestion; index: number; onComplete: (item: QuizReviewItem) => void; topic?: string;
  /** 这题上一次的作答记录（服务端读回；没刷过 / 老卡 ⇒ null）——只标一枚小标，不替用户作答 */
  last?: QuizAttemptRow['last'];
  sessionId?: string | null;
  onAdapted?: (result: QuizFeedbackResult) => void;
  roundResponse?: QuizRoundResponse;
  onDraftChange?: (draft: QuizDraftAnswer, thought: string) => void;
  onRetryAnalysis?: () => void;
  disabled?: boolean;
}) {
  const [localPicked, setPicked] = useState<number[]>([]);
  const [localFills, setFills] = useState(() => Array<string>(fillCount(q)).fill(''));
  const [localEssay, setEssay] = useState('');
  const [localResult, setResult] = useState<QuizReviewItem | null>(null);
  const picked = roundResponse?.draft.picked ?? localPicked, fills = roundResponse?.draft.fills ?? localFills, essay = roundResponse?.draft.essay ?? localEssay;
  const result = roundResponse ? roundResponse.result : localResult;
  const change = (draft: QuizDraftAnswer) => onDraftChange?.(draft, roundResponse?.thought ?? '');
  const [shownAt] = useState(() => Date.now());
  const choice = ['single', 'multiple', 'judge'].includes(q.type);
  const options = optionsFor(q);
  const label = { single: '单选', multiple: '多选', fill: '填空', essay: '解答', judge: '判断' }[q.type];
  // 分级徽标（契约 QUIZ-TIER-SPEC §1）：真题·必刷 / 模拟题·建议做 / 基础题·可选做——用户做题前先知道「这题做了有什么用」
  const tier = tierOf(q);
  const ready = choice ? picked.length > 0 : q.type === 'fill' ? fills.every((s) => s.trim()) : !!essay.trim();
  const submit = () => {
    if (result || !ready) return;
    const next = reviewAttempt(q, { picked, fills, essay });
    setResult(next);
    onComplete(next);
    // 进学习事件流（正确率、用时、题型；后续自适应难度的原料）。解答题只对照参考、没有对错，不报。
    const qtype = answerQType(q.type);
    if (qtype && next.verdict !== 'review') {
      aiOpsApi.reportAnswer({ correct: next.verdict === 'correct', qtype, ms: Date.now() - shownAt, source: 'chat-quiz' });
    }
  };
  return (
    <section className={`quiz-q answer-surface${result ? ` is-${result.verdict}` : ''}`} aria-label={`第 ${index + 1} 题`}>
      {result && <AnswerImpact verdict={result.verdict} audible />}
      {/* 自包含（QUIZ-COMPLETE-SPEC §6）：题干依赖的材料与原图排在题干**之前**，读法顺序＝先材料、再问题 */}
      {q.material && <blockquote className="quiz-q-material" aria-label="材料"><Markdown text={q.material}/></blockquote>}
      {q.photo?.essential && <QuizPhotoFigure photo={q.photo} />}
      <div className="quiz-q-title">
        <span className="quiz-q-type">{index + 1} · {label}</span>
        <span className={`quiz-q-tier is-${tier}`} title={QUIZ_TIER_HINTS[tier]}>{QUIZ_TIER_LABELS[tier]}</span>
        {last && !result && <span className={`quiz-q-last is-${last.verdict}`} title={last.answer ? `上次答：${last.answer}` : undefined}>
          上次 {QUIZ_ATTEMPT_MARK[last.verdict]}
        </span>}
        <MathText text={q.question}/>
      </div>
      {q.svg && <div className="quiz-q-svg"><SvgPreviewCard code={q.svg} streaming={false} /></div>}
      {q.photo && !q.photo.essential && <QuizPhotoFigure photo={q.photo} />}
      {choice && options.map((option, i) => {
        const correct = !!result && Array.isArray(q.answer) && q.answer.map(Number).includes(i);
        return <button key={i} className={`quiz-opt${picked.includes(i) ? ' picked' : ''}${correct ? ' right' : ''}`}
          disabled={!!result || disabled} aria-pressed={picked.includes(i)} onClick={() => {
            const next = q.type === 'multiple' ? picked.includes(i) ? picked.filter(n => n !== i) : [...picked, i] : [i];
            if (roundResponse) change({ picked: next, fills, essay }); else setPicked(next);
          }}>
          <span className="quiz-opt-key">{String.fromCharCode(65 + i)}</span><MathText text={option}/>
          {correct && <span className="quiz-mark ok">✓</span>}
          {result?.verdict === 'wrong' && picked.includes(i) && !correct && <span className="quiz-mark bad">×</span>}
        </button>;
      })}
      {/* 填空（2026-09-30）：参考答案短就逐格打（打字练习式，符号格替你填好、可分段提示），长句退普通框——见 FillBlank */}
      {q.type === 'fill' && fills.map((value, i) => <FillBlank key={i} label={`第 ${i + 1} 空`} placeholder="输入这一空的答案"
        expected={roundResponse && !result ? undefined : Array.isArray(q.answer) ? q.answer[i] === undefined ? undefined : String(q.answer[i]) : i === 0 && q.answer ? String(q.answer) : undefined}
        value={value} disabled={!!result || disabled} onEnter={roundResponse ? undefined : submit}
        onChange={v => { const next = fills.map((s, n) => n === i ? v : s); if (roundResponse) change({ picked, fills: next, essay }); else setFills(next); }} />)}
      {q.type === 'essay' && <textarea className="quiz-essay" aria-label="你的解答" placeholder="写下思路，提交后对照参考要点"
        rows={4} value={essay} maxLength={4000} disabled={!!result || disabled} onChange={e => { if (roundResponse) change({ picked, fills, essay: e.target.value }); else setEssay(e.target.value); }} />}
      {roundResponse && <QuestionThinking value={roundResponse.thought} disabled={!!result || disabled} onChange={thought => onDraftChange?.({ picked, fills, essay }, thought)} />}
      {!result && !roundResponse && <button className="quiz-submit" disabled={!ready} onClick={submit}>
        {q.type === 'essay' ? '提交并对照参考' : '确认作答'}
      </button>}
      {result && <div className={`quiz-explain quiz-feedback is-${result.verdict}`} role="status">
        <strong>{result.verdict === 'correct' ? '✓ 答案吻合' : result.verdict === 'wrong' ? '↗ 找到一个值得回看的知识点' : '◇ 已提交，结合参考继续核对'}</strong>
        <p><b>你的作答：</b>{result.answer}</p>
        <div><b>参考答案：</b><Markdown text={result.expected}/></div>
        {/* v47：前端判不了的（填空字面没对上、解答题）交给 AI 按要点评分，并诊断误区 */}
        {result.verdict === 'review' && !roundResponse && <AiGradeNote q={q} result={result} {...(topic ? { topic } : {})} />}
        {roundResponse?.grade && <p><b>{roundResponse.grade.verdict === 'correct' ? '✓ 按标准答对' : roundResponse.grade.verdict === 'partial' ? '◐ 部分正确' : '↗ 需要回看'}</b> · {Math.round(roundResponse.grade.score * 100)} 分<br />{roundResponse.grade.feedback}</p>}
        {(q.explanation || q.solution) && <Markdown text={q.explanation || q.solution || ''} />}
        {q.source && <div className="quiz-source">来源：{q.source.url
          ? <a href={q.source.url} target="_blank" rel="noreferrer noopener">{q.source.title}</a> : q.source.title}</div>}
      </div>}
      {(!roundResponse || result) && <QuestionFeedback onAdapted={onAdapted} input={{ question: q, title: topic ?? '练习', ...(sessionId ? { sessionId } : {}),
        ...(result ? { attempt: { answer: result.answer, verdict: result.verdict } } : {}) }} />}
      {roundResponse && <QuestionAnalysis response={roundResponse} disabled={disabled} onRetry={() => onRetryAnalysis?.()} />}
    </section>
  );
}
