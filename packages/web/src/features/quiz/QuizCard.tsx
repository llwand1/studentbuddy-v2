/**
 * QuizCard — 可交互题组卡片（三题型：single/multiple/fill/essay）。
 * v1 教训：1886 行巨组件 → 本文件按 题干/作答/解析 子组件拆分，总量 ≤300 行红线内。
 *
 * ★ 2026-09-26 题库整族下线：唯一的调用方是聊天流的题卡（`chat/MessageRow.tsx`），
 *   所以卡片只做「作答 → 判分 → 出解析」，原先挂在这儿的三根外接线一并摘掉——
 *   上报对错（`/api/quiz/stats/record`）、逐题剔除（契约 docs/QUIZ-BLEND-SPEC.md §8 对冲④，
 *   那道闸门防的是「真题自动进组无人工确认」，而"进组"这个动作已经没有了）、以及 quizId。
 */
import { useState } from 'react';
import type { QuizQuestion } from '@sb/shared';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import './quiz.css';

export function QuizCard({
  title,
  questions,
}: {
  title: string;
  questions: QuizQuestion[];
}) {
  return (
    <div className="quiz-card">
      <div className="quiz-head">{title}</div>
      {questions.map((q, i) => (
        <QuestionItem key={i} q={q} />
      ))}
    </div>
  );
}

function QuestionItem({
  q,
}: {
  q: QuizQuestion;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [fillText, setFillText] = useState('');
  const [revealed, setRevealed] = useState(false);

  const typeLabel = { single: '单选', multiple: '多选', fill: '填空', essay: '解答', judge: '判断' }[q.type];
  const answerArr = Array.isArray(q.answer) ? q.answer : [];

  const toggle = (i: number) => {
    if (revealed) return;
    setPicked((p) => (q.type === 'multiple' ? (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]) : [i]));
  };

  return (
    <div className="quiz-q">
      <div className="quiz-q-title">
        <span className="quiz-q-type">{typeLabel}</span>
        {q.question}
      </div>

      {/* 配图：svg 由模型产出，属不可信内容——只经 SvgPreviewCard 渲染（内含 prepareSvg 净化），
          此处不得另开 dangerouslySetInnerHTML。契约 docs/QUIZ-IMAGE-SPEC.md §2.5 */}
      {q.svg && (
        <div className="quiz-q-svg">
          <SvgPreviewCard code={q.svg} streaming={false} />
        </div>
      )}

      {(q.type === 'single' || q.type === 'multiple') &&
        q.options?.map((opt, i) => {
          const isAnswer = revealed && answerArr.map(Number).includes(i);
          const isPicked = picked.includes(i);
          return (
            <button key={i} className={`quiz-opt${isPicked ? ' picked' : ''}${isAnswer ? ' right' : ''}`} onClick={() => toggle(i)}>
              <span className="quiz-opt-key">{String.fromCharCode(65 + i)}</span>
              {opt}
              {revealed && isAnswer && <span className="quiz-mark ok">✓</span>}
              {revealed && isPicked && !isAnswer && <span className="quiz-mark bad">✗</span>}
            </button>
          );
        })}

      {q.type === 'fill' && (
        <input
          className="quiz-fill"
          placeholder="输入答案"
          value={fillText}
          disabled={revealed}
          onChange={(e) => setFillText(e.target.value)}
        />
      )}
      {q.type === 'essay' && <textarea className="quiz-essay" placeholder="写下你的解答（对照参考要点）" rows={3} disabled={revealed} />}

      {!revealed && q.type !== 'essay' && (
        <button className="quiz-submit" disabled={q.type === 'fill' ? !fillText.trim() : picked.length === 0} onClick={() => setRevealed(true)}>
          提交
        </button>
      )}

      {revealed && (
        <div className="quiz-explain">
          {q.type === 'essay' ? (q.solution ?? q.answer) : (
            <>
              <b>答案：</b>
              {q.type === 'single' || q.type === 'multiple'
                ? answerArr.map((a) => String.fromCharCode(65 + Number(a))).join('、')
                : answerArr.join('；')}
            </>
          )}
          {(q.explanation || q.solution) && <div className="quiz-explain-body">{q.explanation ?? q.solution}</div>}
          {q.source && (
            <div className="quiz-source">
              来源：
              {q.source.url ? (
                <a href={q.source.url} target="_blank" rel="noreferrer noopener">
                  {q.source.title}
                </a>
              ) : (
                q.source.title
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
