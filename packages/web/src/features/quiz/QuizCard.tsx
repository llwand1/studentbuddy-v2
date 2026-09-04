/**
 * QuizCard — 可交互题组卡片（三题型：single/multiple/fill/essay）。
 * v1 教训：1886 行巨组件 → 本文件按 题干/作答/解析 子组件拆分，总量 ≤300 行红线内。
 */
import { useState } from 'react';
import type { QuizQuestion } from '@sb/shared';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import './quiz.css';

export function QuizCard({
  title,
  questions,

  onAnswer,
}: {
  title: string;
  questions: QuizQuestion[];
  quizId?: string;
  onAnswer?: (index: number, correct: boolean) => void;
}) {
  return (
    <div className="quiz-card">
      <div className="quiz-head">{title}</div>
      {questions.map((q, i) => (
        <QuestionItem key={i} index={i} q={q} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function QuestionItem({ index, q, onAnswer }: { index: number; q: QuizQuestion; onAnswer?: (i: number, c: boolean) => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [fillText, setFillText] = useState('');
  const [revealed, setRevealed] = useState(false);

  const typeLabel = { single: '单选', multiple: '多选', fill: '填空', essay: '解答' }[q.type];
  const answerArr = Array.isArray(q.answer) ? q.answer : [];

  const toggle = (i: number) => {
    if (revealed) return;
    setPicked((p) => (q.type === 'multiple' ? (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]) : [i]));
  };

  const submit = () => {
    setRevealed(true);
    let correct = false;
    if (q.type === 'single' || q.type === 'multiple') {
      const ans = answerArr.map(Number).sort();
      correct = picked.length === ans.length && picked.every((p) => ans.includes(p));
    } else if (q.type === 'fill') {
      const expects = answerArr.map(String);
      correct = expects.length > 0 && expects.some((e) => fillText.trim().includes(e.slice(0, Math.max(4, e.length - 2))));
    }
    onAnswer?.(index, correct);
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
        <button className="quiz-submit" disabled={q.type === 'fill' ? !fillText.trim() : picked.length === 0} onClick={submit}>
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
          {q.source && <div className="quiz-source">来源：{q.source.title}{q.source.url ? ` · ${q.source.url}` : ''}</div>}
        </div>
      )}
    </div>
  );
}
