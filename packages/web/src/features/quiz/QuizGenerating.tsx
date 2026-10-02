/**
 * QuizGenerating — 出题中的等待条。
 * ★ 2026-10-01（契约 POMODORO-SPEC §8）：出题也算等待——2 秒后等待时刷词会自己弹；这里再给一个手动入口
 *   （与对话等待气泡里的「刷词」同一条 `sb:drill-open` 事件），用户关掉自动弹也能点开。
 */
import { requestDrillOpen } from '../drill/drill-prefs';
import './quiz-effects.css';

export function QuizGenerating({ scenario }: { scenario: boolean }) {
  return <div className="quiz-forging" role="status">
    <span className="quiz-pixel-loader" aria-hidden="true">◆ ◆ ◆</span>
    <span>{scenario ? '正在搭建情景试炼…' : '正在编排知识试炼…'}
      <small>准备题目与交互，完成后将在对话中出现。</small>
    </span>
    <button type="button" className="quiz-forging-drill" onClick={requestDrillOpen} title="等题的空档刷几张词卡">
      刷词
    </button>
  </div>;
}
