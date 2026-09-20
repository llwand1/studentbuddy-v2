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
  onRemove,
}: {
  title: string;
  questions: QuizQuestion[];
  quizId?: string;
  /** answer：作答快照（选择=下标数组、填空=文本），随 stats/record 落进刷题笔记（QUIZ-NOTES-SPEC）；essay 无快照 */
  onAnswer?: (index: number, correct: boolean, answer?: number[] | string) => void;
  /**
   * 逐题剔除（契约 docs/QUIZ-BLEND-SPEC.md §8 对冲④）：D1「真题自动进组」没有人工确认闸门，
   * 错题要能事后剔除。**可选**——题库页传入；聊天流等调用点不传则整列按钮不渲染（纯加法）。
   */
  onRemove?: (index: number) => void;
}) {
  return (
    <div className="quiz-card">
      <div className="quiz-head">{title}</div>
      {questions.map((q, i) => (
        <QuestionItem key={i} index={i} q={q} onAnswer={onAnswer} onRemove={onRemove} />
      ))}
    </div>
  );
}

function QuestionItem({
  index,
  q,
  onAnswer,
  onRemove,
}: {
  index: number;
  q: QuizQuestion;
  onAnswer?: (i: number, c: boolean, answer?: number[] | string) => void;
  onRemove?: (index: number) => void;
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

  const submit = () => {
    setRevealed(true);
    let correct = false;
    let answer: number[] | string | undefined;
    if (q.type === 'single' || q.type === 'multiple') {
      const ans = answerArr.map(Number).sort();
      correct = picked.length === ans.length && picked.every((p) => ans.includes(p));
      answer = picked;
    } else if (q.type === 'fill') {
      const expects = answerArr.map(String);
      correct = expects.length > 0 && expects.some((e) => fillText.trim().includes(e.slice(0, Math.max(4, e.length - 2))));
      answer = fillText.trim();
    }
    onAnswer?.(index, correct, answer);
  };

  return (
    <div className="quiz-q">
      <div className="quiz-q-title">
        <span className="quiz-q-type">{typeLabel}</span>
        {q.question}
        {onRemove && (
          <button
            className="quiz-q-remove"
            onClick={() => onRemove(index)}
            title="从题组里剔除这道题（组内其余题的序号与统计会自动对齐）"
          >
            剔除
          </button>
        )}
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
