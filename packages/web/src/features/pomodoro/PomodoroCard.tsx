/**
 * PomodoroCard — 番茄钟开钟卡，长在词条页复习列表里（契约 `docs/POMODORO-SPEC.md` §3）。
 *
 * 两个状态一个组件：
 *   未开钟 ⇒ 「学什么 · 学多久」：方向可敲、也可点领域芯片（词条库里已有的领域，点一下就填）；时长四档 + 自填；
 *   开着钟 ⇒ 倒计时、第几轮、已完成几轮；工作段给「休息 / 再来一轮 / 结束」，休息段给「开始下一轮 / 结束」。
 * ★ 到点**不自动翻页**（口径 2）：这里与胶囊旁的气泡是同一组动作的两个入口，哪边点都行。
 * ★ 领域芯片复用复习目标卡的视觉词汇（`rv-goal-chip`），不另起一套样式——它就在那张卡旁边。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  POMODORO_SUBJECT_MAX,
  POMODORO_WORK_MAX,
  POMODORO_WORK_MIN,
  POMODORO_WORK_PRESETS,
  POMODORO_DEFAULT_WORK_MIN,
  formatPomodoroClock,
  isLongBreakAfter,
  normalizeWorkMin,
  pomodoroPhaseDone,
  pomodoroRemainingMs,
} from '@sb/shared';
import { api } from '../../lib/api';
import { advanceFocus, skipFocusBreak, startFocus, stopFocus, usePomodoro } from './pomodoro-store';
import { usePomodoroClock } from './use-pomodoro-clock';
import './pomodoro.css';

export function PomodoroCard() {
  const { session } = usePomodoro();
  const { now } = usePomodoroClock();
  const [subject, setSubject] = useState('');
  const [minutes, setMinutes] = useState(String(POMODORO_DEFAULT_WORK_MIN));
  const [domains, setDomains] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api.terms
      .domains()
      .then((r) => {
        if (alive) setDomains(r.domains.map((d) => d.domain).filter((d) => d && d !== 'all').slice(0, 8));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '没存上，再试一次');
    } finally {
      setBusy(false);
    }
  };

  const workMin = useMemo(() => normalizeWorkMin(minutes), [minutes]);

  if (!session) {
    return (
      <div className="rv-goal pomo-card" data-testid="pomodoro-card">
        <div className="rv-goal-head">
          <b>🍅 番茄钟</b>
          <span className="rv-goal-hint">定下接下来学什么，对话、出题、刷词、引路灯都会偏向它</span>
        </div>
        <div className="rv-goal-row">
          <span className="rv-goal-label">学什么</span>
          <input
            className="rv-goal-input pomo-subject"
            type="text"
            maxLength={POMODORO_SUBJECT_MAX}
            placeholder="如：数学 / 高数·极限"
            value={subject}
            disabled={busy}
            onChange={(e) => setSubject(e.target.value)}
            aria-label="学习方向"
          />
          {domains.length > 0 && (
            <div className="rv-goal-chips">
              {domains.map((d) => (
                <button key={d} type="button" className={subject === d ? 'rv-goal-chip on' : 'rv-goal-chip'} disabled={busy} onClick={() => setSubject(d)}>
                  {d}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="rv-goal-row">
          <span className="rv-goal-label">学多久</span>
          <input
            className="rv-goal-input"
            type="number"
            min={POMODORO_WORK_MIN}
            max={POMODORO_WORK_MAX}
            value={minutes}
            disabled={busy}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label="工作时长（分钟）"
          />
          <span className="rv-goal-label">分钟</span>
          <div className="rv-goal-presets">
            {POMODORO_WORK_PRESETS.map((n) => (
              <button key={n} type="button" className={workMin === n ? 'rv-goal-chip on' : 'rv-goal-chip'} disabled={busy} onClick={() => setMinutes(String(n))}>
                {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rv-btn ok"
            disabled={busy || subject.trim() === ''}
            onClick={() =>
              void run(async () => {
                const s = await startFocus({ subject, workMin });
                if (!s) setError('先写下学什么');
              })
            }
          >
            开始专注
          </button>
        </div>
        <p className="rv-goal-tip">每轮结束后休息 5 分钟，每 4 轮一次 15 分钟长休；到点只提醒、不替你翻页。</p>
        {error && <div className="pomo-error">{error}</div>}
      </div>
    );
  }

  const left = pomodoroRemainingMs(session, now);
  const done = pomodoroPhaseDone(session, now);
  const working = session.phase === 'work';
  return (
    <div className={`rv-goal pomo-card${working ? ' is-work' : ' is-break'}`} data-testid="pomodoro-card">
      <div className="rv-goal-head">
        <b>{working ? `🍅 ${session.subject}` : '☕ 休息中'}</b>
        <span className="rv-goal-hint">
          第 {session.round} 轮 · 已完成 {session.completed} 轮{working && isLongBreakAfter(session.round) ? ' · 这轮之后长休' : ''}
        </span>
      </div>
      <div className="pomo-clock" role="timer" aria-live="off" aria-label={working ? '本轮剩余' : '休息剩余'}>
        {formatPomodoroClock(left)}
        {done && <span className="pomo-done">{working ? '到点了' : '休息结束'}</span>}
      </div>
      <div className="rv-goal-row pomo-actions">
        {working ? (
          <>
            <button type="button" className="rv-btn ok" disabled={busy} onClick={() => void run(() => advanceFocus())}>
              {done ? '开始休息' : '提前休息'}
            </button>
            <button type="button" className="rv-btn" disabled={busy} onClick={() => void run(() => skipFocusBreak())}>
              再来一轮
            </button>
          </>
        ) : (
          <button type="button" className="rv-btn ok" disabled={busy} onClick={() => void run(() => advanceFocus())}>
            开始第 {session.round + 1} 轮
          </button>
        )}
        <button type="button" className="rv-btn pomo-stop" disabled={busy} onClick={() => void run(() => stopFocus())}>
          结束番茄钟
        </button>
      </div>
      {error && <div className="pomo-error">{error}</div>}
    </div>
  );
}
