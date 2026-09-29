import { useState } from 'react';
import type { QuizQuestion, QuizReviewItem } from '@sb/shared';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import { Markdown } from '../chat/Markdown';
import { fillCount, optionsFor, reviewAttempt } from './quiz-attempt';
import { aiOpsApi, answerQType } from '../../lib/api-ai-ops';
import { AiGradeNote } from './AiGradeNote';

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

export function QuizQuestionItem({ q, index, onComplete, topic }: {
  q: QuizQuestion; index: number; onComplete: (item: QuizReviewItem) => void; topic?: string;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [fills, setFills] = useState(() => Array<string>(fillCount(q)).fill(''));
  const [essay, setEssay] = useState('');
  const [result, setResult] = useState<QuizReviewItem | null>(null);
  const [shownAt] = useState(() => Date.now());
  const choice = ['single', 'multiple', 'judge'].includes(q.type);
  const options = optionsFor(q);
  const label = { single: '单选', multiple: '多选', fill: '填空', essay: '解答', judge: '判断' }[q.type];
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
    <section className={`quiz-q${result ? ` is-${result.verdict}` : ''}`} aria-label={`第 ${index + 1} 题`}>
      {/* 自包含（QUIZ-COMPLETE-SPEC §6）：题干依赖的材料与原图排在题干**之前**，读法顺序＝先材料、再问题 */}
      {q.material && <blockquote className="quiz-q-material" aria-label="材料">{q.material}</blockquote>}
      {q.photo?.essential && <QuizPhotoFigure photo={q.photo} />}
      <div className="quiz-q-title"><span className="quiz-q-type">{index + 1} · {label}</span>{q.question}</div>
      {q.svg && <div className="quiz-q-svg"><SvgPreviewCard code={q.svg} streaming={false} /></div>}
      {q.photo && !q.photo.essential && <QuizPhotoFigure photo={q.photo} />}
      {choice && options.map((option, i) => {
        const correct = !!result && Array.isArray(q.answer) && q.answer.map(Number).includes(i);
        return <button key={i} className={`quiz-opt${picked.includes(i) ? ' picked' : ''}${correct ? ' right' : ''}`}
          disabled={!!result} aria-pressed={picked.includes(i)} onClick={() => setPicked((p) =>
            q.type === 'multiple' ? p.includes(i) ? p.filter((n) => n !== i) : [...p, i] : [i])}>
          <span className="quiz-opt-key">{String.fromCharCode(65 + i)}</span>{option}
          {correct && <span className="quiz-mark ok">✓</span>}
          {result?.verdict === 'wrong' && picked.includes(i) && !correct && <span className="quiz-mark bad">×</span>}
        </button>;
      })}
      {q.type === 'fill' && fills.map((value, i) => <label className="quiz-blank" key={i}>
        第 {i + 1} 空
        <input className="quiz-fill" value={value} maxLength={500} placeholder="输入这一空的答案" disabled={!!result}
          onChange={(e) => setFills((prev) => prev.map((s, n) => n === i ? e.target.value : s))} />
      </label>)}
      {q.type === 'essay' && <textarea className="quiz-essay" aria-label="你的解答" placeholder="写下思路，提交后对照参考要点"
        rows={4} value={essay} maxLength={4000} disabled={!!result} onChange={(e) => setEssay(e.target.value)} />}
      {!result && <button className="quiz-submit" disabled={!ready} onClick={submit}>
        {q.type === 'essay' ? '提交并对照参考' : '确认作答'}
      </button>}
      {result && <div className={`quiz-explain quiz-feedback is-${result.verdict}`} role="status">
        <strong>{result.verdict === 'correct' ? '✓ 答案吻合' : result.verdict === 'wrong' ? '↗ 找到一个值得回看的知识点' : '◇ 已提交，结合参考继续核对'}</strong>
        <p><b>你的作答：</b>{result.answer}</p>
        <p><b>参考答案：</b>{result.expected}</p>
        {/* v47：前端判不了的（填空字面没对上、解答题）交给 AI 按要点评分，并诊断误区 */}
        {result.verdict === 'review' && <AiGradeNote q={q} result={result} {...(topic ? { topic } : {})} />}
        {(q.explanation || q.solution) && <Markdown text={q.explanation || q.solution || ''} />}
        {q.source && <div className="quiz-source">来源：{q.source.url
          ? <a href={q.source.url} target="_blank" rel="noreferrer noopener">{q.source.title}</a> : q.source.title}</div>}
      </div>}
    </section>
  );
}
