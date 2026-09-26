/**
 * PkJudgePanel — 裁判 AI 输出面板（P0-7）。
 *
 * 三处共用同一形状：出题跑题后的建议 / 求助道具的结果 / 二次机会的现场解析。
 * 只为标题不同就写三个组件，是让同一份展示逻辑在三个地方各漂移一次。
 *
 * ★ 来源链接一律 `rel="noreferrer noopener"` + `target="_blank"`（与题卡来源标注 `quiz/QuizCard` 同口径）。
 */
import type { PkJudgeAdvice } from '@sb/shared';

interface Props {
  title: string;
  /** 建议 + 知识（跑题建议 / 求助结果） */
  advice?: PkJudgeAdvice;
  /** 现场解析（二次机会） */
  explanation?: string;
  onClose: () => void;
}

export function PkJudgePanel({ title, advice, explanation, onClose }: Props) {
  return (
    <section className="sb-pk-card sb-pk-judge">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">{title}</span>
        <button type="button" className="sb-pk-btn tiny" onClick={onClose}>
          收起
        </button>
      </div>
      {explanation && <p className="sb-pk-stem">{explanation}</p>}
      {advice && advice.advice.length > 0 && (
        <ul className="sb-pk-advice">
          {advice.advice.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      {advice?.knowledge && <p className="sb-pk-hint">{advice.knowledge}</p>}
      {advice && advice.refs.length > 0 && (
        <div className="sb-pk-refs">
          {advice.refs.map((r) => (
            <a key={r.n} className="sb-pk-ref" href={r.url} target="_blank" rel="noreferrer noopener">
              [{r.n}] {r.title}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
