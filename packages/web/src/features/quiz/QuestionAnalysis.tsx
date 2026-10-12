import type { QuizRoundResponse } from '@sb/shared';
import { Markdown } from '../chat/Markdown';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
const labels = { none: '', queued: '等待本题分析', grading: '按标准核对答案', analyzing: '正在分析答案与思考', illustrating: '正文已完成，正在补图示', complete: '本题分析完成', error: '本题有部分未完成', cancelled: '本题生成已停止' };
export function QuestionAnalysis({ response, onRetry, disabled }: { response: QuizRoundResponse; onRetry: () => void; disabled: boolean }) {
  if (!response.result) return null;
  return <section className="quiz-question-analysis" aria-label={`第 ${response.index + 1} 题的独立分析`}>
    <header><strong>第 {response.index + 1} 题 · 专属分析</strong><span role="status">{labels[response.status]}</span></header>
    {response.analysis && <Markdown text={response.analysis} streaming={!response.analysisReady} />}
    {response.illustration && <>{response.illustration.sections.map((part, i) => <section className="quiz-lesson" key={i}>
      <h4>{part.title}</h4><figure><SvgPreviewCard code={part.svg} streaming={false} /><figcaption>{part.caption}</figcaption></figure>
    </section>)}<div className="quiz-transfer"><h4>换个条件，你还会吗？</h4><Markdown text={response.illustration.transfer.question} />
      <details><summary>想一想，再查看参考思路</summary><Markdown text={response.illustration.transfer.answer} /></details>
    </div></>}
    {response.error && <p className="quiz-review-error" role="alert">{response.error}</p>}
    {['error', 'cancelled'].includes(response.status) && <button type="button" className="quiz-gen-btn" disabled={disabled} onClick={onRetry}>
      {response.analysisReady ? '继续本题图示与自测' : '重试本题分析'}
    </button>}
  </section>;
}
