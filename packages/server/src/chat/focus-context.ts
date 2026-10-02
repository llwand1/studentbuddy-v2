/**
 * chat/focus-context — 番茄钟方向段（契约 `docs/POMODORO-SPEC.md` §5.1）。
 *
 * 纯装配：读库在调用方（`context-segments.ts` 传入会话），这里只决定「这一段写什么」。
 * ★ 休息段 / 没开钟 ⇒ 空串（空段由 `collectContextSegments` 统一剔除，不占窗口）。
 * ★ 文案只有 shared 的 `pomodoroBiasLine` 一份：出题与刷词的提示词也引用它，三处一句话。
 */
import { pomodoroBiasLine, pomodoroFocus, type PomodoroSession } from '@sb/shared';

export function buildFocusBlock(session: PomodoroSession | null, now: Date = new Date()): string {
  const focus = pomodoroFocus(session, now);
  return focus ? pomodoroBiasLine(focus) : '';
}
