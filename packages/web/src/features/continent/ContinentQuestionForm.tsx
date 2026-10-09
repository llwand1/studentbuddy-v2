/**
 * features/continent/ContinentQuestionForm — 一道大陆题的**作答控件**（五型共用；打怪弹窗与开拓弹窗都用它）。
 *
 * ★ 从 `MonsterDialog.tsx` 抽出（2026-09-29）：开拓地块也要答同一套题型，作答手势（判断两枚钮 / 选择与情景
 *   共用一段 options / 填空回车提交 / 连线下拉）若在两个弹窗里各写一遍，改一处漏一处就是"同一种题两种手感"。
 * ★ **受控组件**：作答值由父组件持有（`answer` / `onChange`），形状就是 `gradeAnswer` 的入参
 *   （判断 boolean / 选择与情景 number / 填空 string / 连线 number[]，未选的项为 -1）——组件不自己判分，
 *   父组件拿 `answer` 直接喂 `gradeAnswer`。换题时父组件把 `answer` 置回 `null` 即可（配合 `key={题号}` 更稳）。
 * ★ 填空（2026-09-30 起）是打字练习式的 `TypingInput`：一格一字、符号格替你填好、「提示」按段揭；`answer` 仍是
 *   带符号的完整字符串，`gradeAnswer` 的 `normText` 口径不变。正经考题不开逐格对错（那会把答案一格格试出来）。
 */
import type { ContinentAnswer, ContinentQuestion } from '@sb/shared';
import { CONTINENT_QLABEL } from '@sb/shared';
import { TypingInput } from '../../components/TypingInput';

interface Props {
  q: ContinentQuestion;
  /** 当前作答（`null` = 还没作答） */
  answer: ContinentAnswer | null;
  onChange: (a: ContinentAnswer) => void;
  /** 填空题按回车 = 提交（与按钮同一条路） */
  onEnter?: () => void;
}

/** 正确答案的可读文本（答错时亮出来——比"再想想"有用） */
export function correctText(q: ContinentQuestion): string {
  switch (q.type) {
    case 'judge':
      return `正确答案：${q.answer ? '对' : '错'}`;
    case 'choice':
    case 'scene':
      return `正确答案：${q.options[q.answerIndex] ?? ''}`;
    case 'fill':
      return `正确答案：${q.answer}`;
    case 'match':
      return `正确连线：${q.left.map((l, i) => `${l} → ${q.right[q.answer[i] ?? 0] ?? ''}`).join('；')}`;
  }
}

export function ContinentQuestionForm({ q, answer, onChange, onEnter }: Props) {
  const picks = q.type === 'match' && Array.isArray(answer) ? answer : [];
  return (
    <div className="continent-q answer-surface">
      <p className="continent-q-type">{CONTINENT_QLABEL[q.type]}</p>
      {/* 情景题多一层"情境框"（照抄 demo 的 `SCENE_FRAME`）：它把题干放进一个场景里，
          其余作答手势与选择题完全一致——所以下面 options 与 choice 共用一段渲染 */}
      {q.type === 'scene' && <p className="continent-q-frame">{q.frame}</p>}
      <p className="continent-q-prompt">{q.type === 'judge' ? q.statement : q.prompt}</p>

      {q.type === 'judge' && (
        <div className="continent-opts">
          <button className={answer === true ? 'continent-opt on' : 'continent-opt'} onClick={() => onChange(true)}>
            对
          </button>
          <button className={answer === false ? 'continent-opt on' : 'continent-opt'} onClick={() => onChange(false)}>
            错
          </button>
        </div>
      )}

      {(q.type === 'choice' || q.type === 'scene') && (
        <div className="continent-opts">
          {q.options.map((opt, i) => (
            <button key={`${i}-${opt}`} className={answer === i ? 'continent-opt on' : 'continent-opt'} onClick={() => onChange(i)}>
              {opt}
            </button>
          ))}
        </div>
      )}

      {q.type === 'fill' && (
        <TypingInput
          answer={q.answer}
          value={typeof answer === 'string' ? answer : ''}
          onChange={onChange}
          onSubmit={onEnter}
          autoFocus
          ariaLabel="填入词条"
        />
      )}

      {q.type === 'match' && (
        <ul className="continent-match">
          {q.left.map((l, i) => (
            <li key={`${i}-${l}`}>
              <span>{l}</span>
              <select
                value={picks[i] === undefined || picks[i] < 0 ? '' : picks[i]}
                onChange={(e) => {
                  const next = q.left.map((_, j) => picks[j] ?? -1);
                  next[i] = e.target.value === '' ? -1 : Number(e.target.value);
                  onChange(next);
                }}
              >
                <option value="">选择释义…</option>
                {q.right.map((r, ri) => (
                  <option key={`${ri}-${r}`} value={ri}>
                    {r}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
