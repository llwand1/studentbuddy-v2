import type { QuizFeedbackRequest, QuizFeedbackResult } from '@sb/shared';
import { QUIZ_FEEDBACK_MAX } from '@sb/shared';
import { useQuestionFeedback } from './useQuestionFeedback';
import { QuizCard } from './QuizCard';
import '../chat/choice.css';
import './question-feedback.css';

/** GrillMe 式评价：内联、按需预判；不挂起对话、不增加全屏弹窗。 */
export function QuestionFeedback({ input, disabled = false, onAdapted }: {
  input: QuizFeedbackRequest; disabled?: boolean; onAdapted?: (result: QuizFeedbackResult) => void;
}) {
  const f = useQuestionFeedback(input, onAdapted);
  return <div className="question-feedback">
    <button type="button" className="qf-toggle" aria-expanded={f.open} disabled={disabled} onClick={f.toggle}>
      <span aria-hidden="true">◇</span> {f.open ? '收起题目评价' : '评价这道题'} <span aria-hidden="true">{f.open ? '−' : '+'}</span>
    </button>
    {f.open && <div className="choice-card qf-card">
      <div className="choice-head"><span className="qf-rune" aria-hidden="true">◇</span><strong>这道题，你想怎么调整？</strong><span className="qf-tag">GrillMe</span></div>
      <p className="qf-note">AI 预判几个可能的评价。选一个，或写下自己的意见，下一题会据此改变。</p>
      {f.busy && <div className="qf-progress" role="status"><span className="qf-spark" aria-hidden="true" />
        {f.busy === 'choices' ? '正在读这道题，预判可能的评价…' : '正在按你的评价重塑下一题…'}
        <button type="button" onClick={f.cancel}>取消</button>
      </div>}
      {!f.result && <>
        <div className="choice-opts">
          {f.options.map((o, i) => <button type="button" key={o.id} className="choice-opt" disabled={!!f.busy || disabled}
            onClick={() => { void f.submit(`${o.label}；${o.description}`); }}>
            <span className="choice-mk">{String.fromCharCode(65 + i)}</span><span className="choice-body"><span className="choice-label">{o.label}</span><span className="choice-desc">{o.description}</span></span>
          </button>)}
        </div>
        <form className="qf-custom" onSubmit={e => { e.preventDefault(); void f.submit(f.custom); }}>
          <label>我的评价<textarea aria-label="我的题目评价" rows={2} maxLength={QUIZ_FEEDBACK_MAX} value={f.custom}
            disabled={f.busy === 'adapt'} placeholder="例如：我卡在列方程，先让我练这个步骤。" onChange={e => f.setCustom(e.target.value)} /></label>
          <div className="qf-actions"><span>原题保留，下一题重新创作</span><button className="quiz-submit" type="submit" disabled={!!f.busy || disabled || !f.custom.trim()}>按评价再来一题</button></div>
        </form>
        {!f.busy && !f.options.length && <button type="button" className="qf-retry" onClick={() => { void f.predict(); }}>重新预判评价</button>}
      </>}
      {f.error && <p className="qf-error" role="alert">{f.error}</p>}
      {f.result && (f.result.announced || onAdapted) && <p className="qf-success" role="status">已按评价生成新题，见下方题卡。</p>}
      {f.result && !f.result.announced && !onAdapted && <QuizCard title={f.result.quiz.title ?? '调整后的练习'} questions={f.result.quiz.questions}
        quizId={f.result.quizId} feedback={f.result.quiz.feedback} />}
    </div>}
  </div>;
}
