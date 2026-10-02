/**
 * PomodoroBubble — 督促胶囊旁的番茄提醒（契约 `docs/POMODORO-SPEC.md` §7）。
 *
 * 与趋势卡气泡同舱（`.coach-dock-rail`），同一条克制纪律：不是模态、不自动展开抽屉、不响铃。
 * 三种提醒（判定只有 shared 的 `pomodoroReminder` 一份）：
 *   work-done  ⇒ 「到了——休息？」：开始休息 / 再来一轮 / 结束
 *   break-done ⇒ 「休息结束，继续？」：开始下一轮 / 结束
 *   setup      ⇒ 「还没定番茄钟」：去设一个（跳词条页展开开钟卡）/ 先不了（本机 2 小时内不再提）
 * ★ 关掉 work-done / break-done 只是收起这一次，钟还在、到点状态还在（卡片上照样能点）；下一次段到点会再冒。
 */
import { useEffect, useRef, useState } from 'react';
import { pomodoroReminder, type PomodoroReminderKind } from '@sb/shared';
import { advanceFocus, markSetupNudged, readSetupNudgeAt, requestPomodoroOpen, skipFocusBreak, stopFocus, usePomodoro } from './pomodoro-store';
import { usePomodoroClock } from './use-pomodoro-clock';
import './pomodoro.css';

export function PomodoroBubble({ openedAt }: { openedAt: Date }) {
  const { session, loaded } = usePomodoro();
  const { now } = usePomodoroClock();
  /** 对「这一段这一次到点」收起过就不再冒：键 = 段开始时刻 + 提醒种类 */
  const [dismissed, setDismissed] = useState('');
  const [slowNow, setSlowNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const nudgeAt = useRef<Date | null>(null);
  // 没开钟时也要有一个慢时钟（每 30 秒）去问「满 3 分钟没」——`usePomodoroClock` 只在开钟时跑
  useEffect(() => {
    if (session) return;
    setSlowNow(new Date());
    const t = window.setInterval(() => setSlowNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, [session]);

  if (!loaded) return null;
  const at = session ? now : slowNow;
  const r = pomodoroReminder({ session, now: at, openedAt, lastSetupNudgeAt: nudgeAt.current ?? readSetupNudgeAt() });
  if (r.kind === 'none') return null;
  const key = `${session?.phaseStartedAt ?? 'none'}|${r.kind}`;
  if (dismissed === key) return null;

  const close = (kind: PomodoroReminderKind): void => {
    if (kind === 'setup') {
      const t = new Date();
      nudgeAt.current = t;
      markSetupNudged(t);
    }
    setDismissed(key);
  };
  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    void fn()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className={`pomo-bubble is-${r.kind}`} role="status" data-testid="pomodoro-bubble">
      <div className="pomo-bubble-line">{r.line}</div>
      <div className="pomo-bubble-actions">
        {r.kind === 'work-done' && (
          <>
            <button type="button" className="rv-btn ok" disabled={busy} onClick={() => run(() => advanceFocus())}>
              开始休息
            </button>
            <button type="button" className="rv-btn" disabled={busy} onClick={() => run(() => skipFocusBreak())}>
              再来一轮
            </button>
            <button type="button" className="rv-btn" disabled={busy} onClick={() => run(() => stopFocus())}>
              结束
            </button>
          </>
        )}
        {r.kind === 'break-done' && (
          <>
            <button type="button" className="rv-btn ok" disabled={busy} onClick={() => run(() => advanceFocus())}>
              开始下一轮
            </button>
            <button type="button" className="rv-btn" disabled={busy} onClick={() => run(() => stopFocus())}>
              结束
            </button>
          </>
        )}
        {r.kind === 'setup' && (
          <button
            type="button"
            className="rv-btn ok"
            onClick={() => {
              close('setup');
              requestPomodoroOpen();
            }}
          >
            去定一个
          </button>
        )}
        <button type="button" className="pomo-bubble-x" title={r.kind === 'setup' ? '先不了（2 小时内不再提）' : '先收起'} onClick={() => close(r.kind)}>
          ×
        </button>
      </div>
    </div>
  );
}
