/**
 * DailySummaryPage — 今日总结：XP/等级/连签 + 近 7 天趋势（纯 CSS 柱状）+ AI 总结。
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import './summary.css';

type Stats = { day: string; xp: number; level: number; streak: number; activities: Array<{ type: string; count: number }> };
const TYPE_LABEL: Record<string, string> = {
  chat_done: '问答',
  quiz_generated: '出题',
  quiz_answered: '做题',
  review_done: '背词',
};

export function DailySummaryPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [week, setWeek] = useState<Array<{ day: string; count: number }>>([]);
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setStats(await api.request<Stats>('/api/activity/today'));
    setWeek(await api.request<Array<{ day: string; count: number }>>('/api/activity/week'));
  };

  useEffect(() => {
    void load();
  }, []);

  const genSummary = async () => {
    setLoading(true);
    const r = await api.request<{ content: string }>('/api/activity/summary');
    setSummary(r.content);
    setLoading(false);
  };

  const max = Math.max(1, ...week.map((w) => w.count));

  return (
    <div className="sum-page">
      <h2>今日总结</h2>
      {stats && (
        <div className="sum-cards">
          <div className="sum-card">
            <div className="sum-num">{stats.xp}</div>
            <div className="sum-label">XP · Lv.{stats.level}</div>
          </div>
          <div className="sum-card">
            <div className="sum-num">{stats.streak}</div>
            <div className="sum-label">连签天数</div>
          </div>
          <div className="sum-card">
            <div className="sum-num">{stats.activities.reduce((a, b) => a + b.count, 0)}</div>
            <div className="sum-label">今日活动</div>
          </div>
        </div>
      )}

      {stats && stats.activities.length > 0 && (
        <div className="sum-acts">
          {stats.activities.map((a) => (
            <span key={a.type} className="sum-act">
              {TYPE_LABEL[a.type] ?? a.type} × {a.count}
            </span>
          ))}
        </div>
      )}

      <div className="sum-chart">
        {week.map((w) => (
          <div key={w.day} className="sum-bar-col" title={`${w.day}：${w.count} 次`}>
            {/* gates:style-ok 数据驱动高度走 CSS 变量（非硬编码样式） */}
            <div className="sum-bar" style={{ ['--bar-h' as string]: `${Math.max(4, (w.count / max) * 100)}%` }} />
            <div className="sum-bar-day">{w.day.slice(5)}</div>
          </div>
        ))}
      </div>

      <button className="sum-gen" onClick={() => void genSummary()} disabled={loading}>
        {loading ? '生成中…' : '生成今日总结'}
      </button>
      {summary && <div className="sum-text">{summary}</div>}
    </div>
  );
}
