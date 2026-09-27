import './quiz-effects.css';

export function QuizGenerating({ scenario }: { scenario: boolean }) {
  return <div className="quiz-forging" role="status">
    <span className="quiz-pixel-loader" aria-hidden="true">◆ ◆ ◆</span>
    <span>{scenario ? '正在搭建情景试炼…' : '正在编排知识试炼…'}
      <small>准备题目与交互，完成后将在对话中出现。</small>
    </span>
  </div>;
}
