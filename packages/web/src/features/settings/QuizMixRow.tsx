/**
 * QuizMixRow — 配比卡的单格步进器（− / 数字直输 / +），2026-09-20 从 `QuizMixCard.tsx` 拆出。
 *
 * ★ 为什么拆文件：配比卡升级「双列」（每题型 AI 一列 + 网络真题一列，契约 `docs/QUIZ-BLEND-SPEC.md` §2）
 *   后每行要渲染**两个**步进器，原单列行组件不再适用；且卡片本体已 227 行，加列会触 web 300 红线
 *   ——按契约「拆出 `QuizMixRow`/新 `QuizSourceRow` 到独立文件，卡片本体只留编排」执行。
 *
 * ★ 数字框用本地 draft（字符串），失焦或回车才提交：避免每次按键都重算导致光标跳动；
 *   提交走 shared 钳位（`setQuizMix` / `setQuizSourceMix`，由父级经 onSet 注入），钳位后的
 *   最终值由父组件 value 回灌（useEffect 同步 draft），输入超限数字会自动"回落"到合法值。
 */
import { useEffect, useState } from 'react';
import { MAX_QUIZ_TOTAL } from '@sb/shared';

export function MixStepper({
  value,
  cap,
  totalFull,
  disabled,
  onStep,
  onSet,
}: {
  value: number;
  /** 单档上限按格取：AI 侧题型 10 / 情景题 3；真题侧 5（shared mixKindCap / sourceKindCap） */
  cap: number;
  /** 总额已满（AI 侧 + 真题侧 ≥ MAX_QUIZ_TOTAL）：加号禁用，提示先减后加 */
  totalFull: boolean;
  disabled: boolean;
  onStep: (delta: number) => void;
  onSet: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // 父级值变化（点预设 / 点 +− / 保存回读 / 输入被钳位）时，把输入框同步回真实值
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const perTypeFull = value >= cap;

  /** 失焦/回车提交：无效输入还原为当前值；有效输入先截断小数，再交给父级钳位规则 */
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setDraft(String(value));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    setDraft(String(Math.trunc(n)));
    onSet(n);
  };

  return (
    <span className="quiz-mix-cell">
      <button className="quiz-mix-step" disabled={disabled || value <= 0} onClick={() => onStep(-1)} title="减少">
        −
      </button>
      <input
        className="quiz-mix-num"
        type="number"
        min={0}
        max={cap}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          }
        }}
      />
      <button
        className="quiz-mix-step"
        disabled={disabled || perTypeFull || totalFull}
        onClick={() => onStep(1)}
        title={
          perTypeFull
            ? `该列上限 ${cap}`
            : totalFull
              ? `总题数已达上限 ${MAX_QUIZ_TOTAL} 道（AI 题 + 真题合并计），先减掉别的格再加`
              : '增加'
        }
      >
        +
      </button>
    </span>
  );
}
