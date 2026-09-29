/**
 * DrillQuestion — 一张刷词卡的**作答面**（契约 `docs/WAIT-DRILL-SPEC.md` §5.2）。
 *
 * 三种手感照百词斩：四选一点了就判（对 ⇒ 绿亮闪过，错 ⇒ 红亮 + 正确项绿亮 + 翻出详情等你按「下一张」）；
 * 拼写回车提交；新词先"学"一屏再答，答完不论对错都问「收入词库 / 不要」（答错的词恰恰是最想留的）。
 * 键位提示写在按钮上（`<kbd>`），与 `useDrillKeys` 同一张表。
 * ★ 纯展示 + 回调：判分、排队、记账都在 `useDrillSession`；本组件不 import 任何 API。
 */
import { useEffect, useRef, useState } from 'react';
import { DRILL_KIND_LABEL, type DrillCard } from '@sb/shared';
import type { DrillEntry, DrillPhase, DrillResult } from './useDrillSession';

interface Props {
  phase: DrillPhase;
  card: DrillCard | null;
  entry: DrillEntry | null;
  result: DrillResult | null;
  notice: string;
  onAnswer: (a: number | string) => void;
  onDontKnow: () => void;
  onNext: () => void;
  onLearned: () => void;
  onSlay: () => void;
  onKeep: () => void;
  onDismiss: () => void;
}

function optionClass(i: number, card: DrillCard, result: DrillResult | null): string {
  if (!result) return 'drill-opt';
  if (i === card.answerIndex) return 'drill-opt right';
  if (result.answer === i) return 'drill-opt wrong';
  return 'drill-opt dim';
}

export function DrillQuestion({ phase, card, entry, result, notice, onAnswer, onDontKnow, onNext, onLearned, onSlay, onKeep, onDismiss }: Props) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTyped('');
    if (phase === 'question' && card?.kind === 'spell') inputRef.current?.focus();
  }, [card, phase]);

  if (phase === 'loading') return <div className="drill-card drill-wait">正在翻词库…</div>;
  if (phase === 'empty' || !card || !entry) {
    return (
      <div className="drill-card drill-wait">
        <p>{notice || '词库还是空的——AI 正在为你出几条新词，稍等一下；也可以先去「词条」页存几条。'}</p>
      </div>
    );
  }

  const isNew = entry.origin === 'new';
  const src = entry.newItem;
  const stateClass = result ? (result.slain ? ' slain' : result.correct ? ' hit' : ' miss') : '';

  if (phase === 'learn') {
    return (
      <div className="drill-card learn">
        <div className="drill-chips">
          <span className="drill-chip new">新词 · {src?.source === 'ai' ? 'AI 现出' : '内置词池'}</span>
          <span className="drill-chip">领域「{card.domain}」</span>
        </div>
        <h3 className="drill-term">{card.term}</h3>
        <p className="drill-def">{card.definition}</p>
        <p className={src?.source === 'fallback' ? 'drill-src fallback' : 'drill-src'}>
          {src?.fallbackReason ?? '跟着你正在聊的话题出的，先看一眼，下一屏就考它'}
        </p>
        <div className="drill-actions">
          <button type="button" className="drill-btn primary" onClick={onLearned}>
            记住了，来一题 <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`drill-card ${card.kind}${stateClass}`}>
      <div className="drill-chips">
        <span className="drill-chip">{DRILL_KIND_LABEL[card.kind]}</span>
        {entry.origin === 'due' && <span className="drill-chip due">到期 · 答对即打卡</span>}
        {isNew && <span className="drill-chip new">新词</span>}
      </div>
      <h3 className={card.kind === 'meaning' ? 'drill-term' : 'drill-prompt'}>{card.prompt}</h3>

      {card.kind !== 'spell' ? (
        <div className="drill-opts">
          {card.options.map((o, i) => (
            <button
              key={`${card.termId}-${i}`}
              type="button"
              className={optionClass(i, card, result)}
              disabled={phase !== 'question'}
              onClick={() => onAnswer(i)}
            >
              <kbd>{i + 1}</kbd>
              <span>{o}</span>
            </button>
          ))}
        </div>
      ) : (
        <form
          className="drill-spell"
          onSubmit={(e) => {
            e.preventDefault();
            if (phase === 'question' && typed.trim()) onAnswer(typed);
          }}
        >
          <p className="drill-hint">{card.hint}</p>
          <input
            ref={inputRef}
            className="drill-input"
            value={typed}
            disabled={phase !== 'question'}
            placeholder="输入词条，回车提交"
            aria-label="拼写作答"
            onChange={(e) => setTyped(e.target.value)}
          />
          {phase === 'question' && (
            <button type="submit" className="drill-btn primary" disabled={!typed.trim()}>
              提交 <kbd>Enter</kbd>
            </button>
          )}
        </form>
      )}

      {result && (
        <div className={result.correct ? 'drill-detail ok' : 'drill-detail bad'} role="status">
          <b>{result.slain ? '斩！今天不再出这条' : result.correct ? '对了' : result.answer === null ? '记一下' : '错了'}</b>
          <span>
            {card.term} —— {card.definition}
          </span>
        </div>
      )}

      <div className="drill-actions">
        {phase === 'question' && (
          <>
            <button type="button" className="drill-btn" onClick={onDontKnow}>
              不认识 <kbd>N</kbd>
            </button>
            {!isNew && (
              <button type="button" className="drill-btn slay" onClick={onSlay}>
                斩 <kbd>Z</kbd>
              </button>
            )}
          </>
        )}
        {phase === 'reveal' && isNew && (
          <>
            <button type="button" className="drill-btn" onClick={onDismiss}>
              不要 <kbd>X</kbd>
            </button>
            <button type="button" className="drill-btn primary" onClick={onKeep}>
              收入词库 <kbd>Enter</kbd>
            </button>
          </>
        )}
        {phase === 'reveal' && !isNew && !result?.slain && (
          <>
            {!result?.correct && (
              <button type="button" className="drill-btn slay" onClick={onSlay}>
                斩 <kbd>Z</kbd>
              </button>
            )}
            <button type="button" className="drill-btn primary" onClick={onNext}>
              下一张 <kbd>Enter</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
