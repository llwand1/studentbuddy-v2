/**
 * use-pomodoro-clock — 每秒一跳的「现在」（只在开着钟时跑）。
 * 倒计时读数全部由 shared 纯函数按这个 `now` 派生；没开钟时不起定时器，不白耗。
 */
import { useEffect, useState } from 'react';
import { usePomodoro } from './pomodoro-store';

export function usePomodoroClock(): { now: Date } {
  const { session } = usePomodoro();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!session) return;
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, [session]);
  return { now };
}
