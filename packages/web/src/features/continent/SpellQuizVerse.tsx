/**
 * features/continent/SpellQuizVerse — 吟唱里的「重做当初的题」一节（契约 `docs/SPELL-CHANT-SPEC.md` §3.3）。
 *
 * ★ 判分**复用**对话页题卡那一份 `reviewAttempt`（`features/quiz/quiz-attempt.ts`），`verdict === 'correct'` 才算命中——
 *   不另写第二份判分口径（两份判分迟早一份漂）。
 * ★ **一次作答**：对 ⇒ 命中；错 ⇒ 失谐并亮出正确答案。与打怪常规题「答错可重试」刻意不同：
 *   吟唱是回忆练习，看过答案再答一遍不叫回忆。
 * ★ 只会收到 `chantable` 放行的四型（single / multiple / judge / fill），`essay` 到不了这里。
 */
import { useState } from 'react';
import type { QuizQuestion } from '@sb/shared';
import { fillCount, optionsFor, reviewAttempt } from '../quiz/quiz-attempt';

interface Props {
  question: QuizQuestion;
  title: string;
  /** 作答已判、用户按下「下一节」：`hit` = 答对 */
  onResult: (hit: boolean) => void;
}

export function SpellQuizVerse({ question, title, onResult }: Props) {
  const [picked, setPicked] = useState<number[]>([]);
  const [fills, setFills] = useState<string[]>(() => Array.from({ length: fillCount(question) }, () => ''));
  const [verdict, setVerdict] = useState<{ hit: boolean; expected: string } | null>(null);

  const options = optionsFor(question);
  const isChoice = question.type === 'single' || question.type === 'multiple' || question.type === 'judge';
  const ready = isChoice ? picked.length > 0 : fills.every((f) => f.trim() !== '');

  const toggle = (i: number): void => {
    if (verdict) return;
    if (question.type === 'multiple') setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
    else setPicked([i]);
  };

  const submit = (): void => {
    if (!ready || verdict) return;
    const r = reviewAttempt(question, { picked, fills, essay: '' });
    setVerdict({ hit: r.verdict === 'correct', expected: r.expected });
  };

  return (
    <div className="continent-q spell-quiz">
      <p className="spell-echo-label">出自题卡「{title}」</p>
      <p className="continent-q-prompt">{question.question}</p>

      {isChoice && (
        <div className="continent-opts">
          {options.map((opt, i) => (
            <button
              key={`${i}-${opt}`}
              className={picked.includes(i) ? 'continent-opt on' : 'continent-opt'}
              disabled={verdict !== null}
              aria-pressed={picked.includes(i)}
              onClick={() => toggle(i)}
            >
              {String.fromCharCode(65 + i)}. {opt}
            </button>
          ))}
        </div>
      )}
      {question.type === 'multiple' && !verdict && <p className="spell-dim">多选：把该选的都点上</p>}

      {question.type === 'fill' &&
        fills.map((f, i) => (
          <input
            key={i}
            className="continent-input"
            value={f}
            disabled={verdict !== null}
            placeholder={fills.length > 1 ? `第 ${i + 1} 空` : '填入答案'}
            aria-label={fills.length > 1 ? `第 ${i + 1} 空` : '填空作答'}
            onChange={(e) => setFills((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        ))}

      {verdict && (
        <p className={verdict.hit ? 'continent-note spell-hit' : 'continent-note spell-miss'} role="status">
          {verdict.hit
            ? '命中——这一节共鸣了。'
            : question.type === 'fill'
              ? `失谐（逐空文字对照未匹配）。参考答案：${verdict.expected}`
              : `失谐。正确答案：${verdict.expected}`}
        </p>
      )}

      <footer className="continent-modal-foot">
        {verdict ? (
          <button className="continent-btn primary" onClick={() => onResult(verdict.hit)}>
            下一节
          </button>
        ) : (
          <button className="continent-btn primary" disabled={!ready} onClick={submit}>
            作答
          </button>
        )}
      </footer>
    </div>
  );
}
