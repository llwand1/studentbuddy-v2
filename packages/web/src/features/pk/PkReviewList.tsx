/**
 * PkReviewList — 一局结束后逐题回看（契约 docs/PK-SPEC.md §5）。
 *
 * 从 `PkRoom` 抽出的**共享块**：房间结算页与历史详情页看的是同一件事（题干、选项、
 * 我选了什么、正确答案、判词），各写一份必然有一天只改一边。
 * 判词逻辑在 `pk-view.ts` 的 `reviewVerdict`（纯函数、进测链路），本组件只挂 UI。
 */
import { JUDGE_USER_ID, isAiUserId, type PkQuestion } from '@sb/shared';
import { optionLetter, reviewVerdict } from './pk-view';

interface Props {
  questions: PkQuestion[];
  /** 看这局的人（决定「谁出的」怎么标注）；不影响判词 */
  userId: string;
}

/** 出题人标签：我 / AI / 裁判（二次机会的类似题由裁判出）/ 对手 */
function authorLabel(q: PkQuestion, userId: string): string {
  if (q.fromUserId === userId) return '我出';
  if (q.fromUserId === JUDGE_USER_ID) return '裁判出';
  return isAiUserId(q.fromUserId) ? 'AI 出' : '对手出';
}

export function PkReviewList({ questions, userId }: Props) {
  if (questions.length === 0) return <p className="sb-pk-hint">这一局没有产生题目</p>;
  return (
    <>
      {questions.map((q, qi) => {
        const v = reviewVerdict(q);
        return (
          <div key={q.id} className="sb-pk-review">
            <div className="sb-pk-q-head">
              <span className="sb-pk-seat">
                第 {qi + 1} 题{q.isRetry ? ' · 补救' : ''} · {authorLabel(q, userId)}
              </span>
              <span className={v.ok ? 'sb-pk-verdict ok' : 'sb-pk-verdict'}>{v.text}</span>
            </div>
            <p className="sb-pk-stem">{q.stem}</p>
            {q.kind === 'scenario' ? (
              // §15.4 B4：情景题回看＝评分点命中清单（没有选项与下标可标）
              <ul className="sb-pk-scenario-tasks">
                {(q.scenario?.tasks ?? []).map((t) => {
                  const hit = q.taskResults?.[t.id];
                  return (
                    <li key={t.id} className={`sb-pk-scenario-task${hit === undefined ? '' : hit ? ' ok' : ' no'}`}>
                      <span className="sb-pk-scenario-state">{hit === undefined ? '未上报' : hit ? '判对' : '判错'}</span>
                      <span className="t">{t.prompt}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="sb-pk-review-opts">
                {q.options.map((opt, i) => (
                  <div
                    key={i}
                    className={
                      i === q.answerRevealed
                        ? 'sb-pk-review-opt correct'
                        : i === q.chosen
                          ? 'sb-pk-review-opt wrong'
                          : 'sb-pk-review-opt'
                    }
                  >
                    {optionLetter(i)}. {opt}
                    {i === q.chosen && ' ← 已选'}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
