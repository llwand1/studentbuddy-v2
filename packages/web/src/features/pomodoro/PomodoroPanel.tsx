/**
 * PomodoroPanel — 督促小窗抽屉顶部的「专注」区（契约 `docs/POMODORO-SPEC.md` §3 / §10）。
 *
 * 为什么和复习督促放在一起：督促回答「欠了多少、什么时候还」，番茄钟回答「这段时间在学什么、学了多久」——
 * 都是「我的学习现状」的可视化，用户看的是同一块屏。所以这块区的三件东西与督促的卡片流同一套视觉：
 *   ① 开钟卡（`PomodoroCard`）：没开钟是表单、开着是倒计时；
 *   ② 近 7 天专注分钟折线：复用趋势卡的 `renderTrendSvg`（同宽、同配色、同「只画不算」纪律）；
 *   ③ 按方向汇总芯片：这周时间花在哪几个方向上。
 * ★ 数字只来自服务端 `/api/pomodoro/stats`（`pomodoro_log` 的 SQL 汇总），前端不自己累加——
 *   与督促「数字只有一个来源」同一条纪律。store 里的会话一变（翻段 = 可能刚完成一轮）就重拉。
 * ★ 一轮没专注过时折线不画、只给一句引导：空图比没图更像坏了。
 */
import { useEffect, useMemo, useState } from 'react';
import { formatFocusMinutes, pomodoroStatsLine, type PomodoroStats } from '@sb/shared';
import { pomodoroApi } from '../../lib/api-pomodoro';
import { renderTrendSvg } from '../../lib/chart-utils';
import { PomodoroCard } from './PomodoroCard';
import { usePomodoro } from './pomodoro-store';
import './pomodoro.css';

export function PomodoroPanel() {
  const { session, loaded } = usePomodoro();
  const [stats, setStats] = useState<PomodoroStats | null>(null);
  // 翻段 / 结束都会让 `session` 变；completed 变了说明刚记了一行
  const statsKey = session ? `${session.subject}|${session.completed}` : 'none';
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    void pomodoroApi
      .stats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [loaded, statsKey]);

  const totalRounds = stats ? stats.recent.reduce((a, d) => a + d.rounds, 0) : 0;
  const svg = useMemo(
    () => (stats && totalRounds > 0 ? renderTrendSvg({ labels: stats.recent.map((d) => d.day.slice(5)), values: stats.recent.map((d) => d.minutes) }) : ''),
    [stats, totalRounds],
  );
  const line = stats ? pomodoroStatsLine(stats) : '';

  return (
    <section className="coach-queue-sec pomo-sec" data-testid="pomodoro-panel">
      <div className="coach-sec-head">
        专注番茄钟
        <span className="coach-sec-hint">{line || '定下方向，功能跟着你走'}</span>
      </div>
      <PomodoroCard />
      {stats && totalRounds > 0 && (
        <div className="pomo-stats">
          <div className="pomo-stats-head">
            近 {stats.recent.length} 天专注分钟
            <span className="coach-sec-hint">
              共 {totalRounds} 轮 · {formatFocusMinutes(stats.recent.reduce((a, d) => a + d.minutes, 0))}
            </span>
          </div>
          {/* 与趋势卡同一支画笔：数字来自服务端 SQL，这里只画 */}
          <div className="coach-tr-chart pomo-chart" dangerouslySetInnerHTML={{ __html: svg }} />
          {stats.bySubject.length > 0 && (
            <div className="pomo-subjects" aria-label="按方向汇总">
              {stats.bySubject.slice(0, 6).map((s) => (
                <span key={s.subject} className="pomo-chip is-stat" title={`${s.rounds} 轮`}>
                  {s.subject}
                  <b>{formatFocusMinutes(s.minutes)}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {stats && totalRounds === 0 && !session && <p className="pomo-tip">完成第一轮后，这里会出现近 7 天的专注曲线与方向分布。</p>}
    </section>
  );
}
