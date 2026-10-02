/**
 * CoachCapsule — 督促小窗的**折叠态**（B 部分）。
 *
 * 全部信息量压成一行：`欠 N 条 · 连续 M 天`。刻意的取舍：
 *  - **不做倒计时、不做进度环**：本功能以天为最小单位（`shared/ebbinghaus.ts` 口径 1），
 *    小时级跳动的数字只会让人以为它是闹钟；
 *  - **只在有欠账时上色**（逾期红 / 今天到期橙 / 清零灰）：常亮的高亮色很快就没人看，
 *    而"颜色变了"本身就是提示；
 *  - 折叠态**不显示 AI 说的话**——那是展开态的事，胶囊负责的只有"该不该现在点开"。
 */
import { capsuleLine, pomodoroCapsuleLabel, type CoachSnapshot } from '@sb/shared';
import { capsuleTone } from './coach-cards';
import { CardsIcon } from '../../components/icons';
import { usePomodoro } from '../pomodoro/pomodoro-store';
import { usePomodoroClock } from '../pomodoro/use-pomodoro-clock';

export function CoachCapsule({
  snapshot,
  open,
  nudge,
  onToggle,
}: {
  snapshot: CoachSnapshot | null;
  open: boolean;
  /** 服务端判定「该主动提醒」（`shouldNudge`）：只在欠账时才该亮 */
  nudge: boolean;
  onToggle: () => void;
}) {
  const tone = snapshot ? capsuleTone(snapshot) : 'ok';
  const line = snapshot ? capsuleLine(snapshot) : '复习督促';
  // 番茄钟标签（契约 POMODORO-SPEC §7.1）：开着钟就把倒计时摆在欠账前面——它是此刻最要紧的那个数
  const pomo = usePomodoro().session;
  const { now } = usePomodoroClock();
  const pomoLabel = pomodoroCapsuleLabel(pomo, now);
  return (
    <button
      className={`coach-cap ${tone}${open ? ' open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? '收起督促小窗' : '打开督促小窗'}
    >
      <span className="coach-cap-icon">
        <CardsIcon size={15} />
      </span>
      {pomoLabel && <span className={`coach-cap-pomo${pomo?.phase === 'break' ? ' is-break' : ''}`}>{pomoLabel}</span>}
      <span className="coach-cap-text">{line}</span>
      {nudge && snapshot !== null && snapshot.due > 0 && <span className="coach-cap-dot" />}
    </button>
  );
}
