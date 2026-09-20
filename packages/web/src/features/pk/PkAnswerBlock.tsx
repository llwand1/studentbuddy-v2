/**
 * PkAnswerBlock — 答题区（UX 批从 `PkMatch` 拆出：PkMatch 加上对阵布局后会顶破 300 行门禁）。
 *
 * ★ 倒计时 **≤10s 变红**（`.urgent`）：45s 时限只剩最后几秒时不给任何提示，玩家会在
 *   「我明明还能想一下」的错觉里被超时判 −1——那是系统坑人，不是玩家失误。
 * §15.4（B4）：情景题按 `kind` 分派到 `PkScenarioHost`（iframe demo 整页算一题）——
 * 选项区不渲染；求助道具**沿用**（道具语义是「给思路」不是「替玩」，契约 §15.4 机制表）。
 */
import type { PkQuestion } from '@sb/shared';
import { optionLetter, remainingMs } from './pk-view';
import { PkScenarioHost } from './PkScenarioHost';

interface Props {
  question: PkQuestion;
  /** 我的剩余求助次数（>0 才显示求助按钮） */
  helpLeft: number;
  /** 提交在途（防重复点） */
  disabled: boolean;
  onAnswer: (choice: number) => void;
  onHelp: () => void;
  /** 当前时间戳（父组件 500ms 驱动，本组件不起定时器） */
  now: number;
}

export function PkAnswerBlock({ question, helpLeft, disabled, onAnswer, onHelp, now }: Props) {
  const sec = Math.ceil(remainingMs(question.deadlineAt, now) / 1000);
  const isScenario = question.kind === 'scenario';
  return (
    <section className="sb-pk-card sb-pk-block">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">
          {question.isRetry ? '补救题（答对 +2）' : isScenario ? '情景题（全中 +2 / 有错 −1）' : '轮到你答'}
        </span>
        <span className={sec <= 10 ? 'sb-pk-deadline urgent' : 'sb-pk-deadline'}>{sec}s</span>
      </div>
      {isScenario ? (
        <PkScenarioHost roomId={question.roomId} question={question} />
      ) : (
        <>
          <p className="sb-pk-stem">{question.stem}</p>
          <div className="sb-pk-options">
            {question.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                className="sb-pk-option"
                disabled={disabled}
                onClick={() => onAnswer(i)}
              >
                <span className="sb-pk-option-letter">{optionLetter(i)}</span>
                <span className="sb-pk-option-text">{opt}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {helpLeft > 0 && (
        <button type="button" className="sb-pk-btn ghost" onClick={onHelp}>
          用求助道具（还剩 {helpLeft} 个）
        </button>
      )}
    </section>
  );
}
