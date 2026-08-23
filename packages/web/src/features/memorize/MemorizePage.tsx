/**
 * MemorizePage — 背背背：统计条 + 今日待复习翻卡（SRS 三键）+ 添加词条。
 * 翻卡交互参照 Quizlet 手感（轻快），调度走 SM-2（服务端 srs.ts）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import './memorize.css';

type Term = {
  id: string;
  term: string;
  definition: string;
  category: string | null;
  status: string;
  interval_days: number;
  review_count: number;
};

export function MemorizePage() {
  const [stats, setStats] = useState({ total: 0, mastered: 0, due: 0 });
  const [queue, setQueue] = useState<Term[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [lastMsg, setLastMsg] = useState('');
  const [term, setTerm] = useState('');
  const [def, setDef] = useState('');

  const reload = useCallback(async () => {
    const [s, q] = await Promise.all([
      api.request<{ total: number; mastered: number; due: number }>('/api/memorize/stats'),
      api.request<Term[]>('/api/memorize/due?limit=50'),
    ]);
    setStats(s);
    setQueue(q);
    setIdx(0);
    setFlipped(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = queue[idx];

  const review = async (quality: 1 | 3 | 4) => {
    if (!current) return;
    const r = await api.request<{ intervalDays: number }>(`/api/memorize/${current.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    });
    setLastMsg(`下次复习：${r.intervalDays} 天后`);
    setFlipped(false);
    setIdx((i) => i + 1); // 本张出队（下一张继续）
    const s = await api.request<{ total: number; mastered: number; due: number }>('/api/memorize/stats');
    setStats(s);
  };

  const add = async () => {
    if (!term.trim() || !def.trim()) return;
    await api.request('/api/memorize', { method: 'POST', body: JSON.stringify({ term: term.trim(), definition: def.trim() }) });
    setTerm('');
    setDef('');
    await reload();
  };

  return (
    <div className="memo-page">
      <h2>背背背</h2>
      <div className="memo-stats">
        <span>共 {stats.total} 词</span>
        <span>已掌握 {stats.mastered}</span>
        <span className="memo-due">今日待复习 {stats.due}</span>
      </div>

      {current ? (
        <div className="memo-card-wrap">
          <div className={flipped ? 'memo-card flipped' : 'memo-card'} onClick={() => setFlipped((f) => !f)} role="button" tabIndex={0}>
            <div className="memo-face memo-front">
              <div className="memo-term">{current.term}</div>
              <div className="memo-hint">点击翻面</div>
            </div>
            <div className="memo-face memo-back">
              <div className="memo-term">{current.term}</div>
              <div className="memo-def">{current.definition}</div>
            </div>
          </div>
          {flipped ? (
            <div className="memo-actions">
              <button className="memo-btn bad" onClick={() => void review(1)}>
                没记住
              </button>
              <button className="memo-btn mid" onClick={() => void review(3)}>
                模糊
              </button>
              <button className="memo-btn ok" onClick={() => void review(4)}>
                记住了
              </button>
            </div>
          ) : (
            <div className="memo-hint">回想释义后翻面对答案（SM-2 调度）</div>
          )}
          {lastMsg && <div className="memo-msg">{lastMsg}</div>}
          <div className="memo-progress">
            {idx}/{queue.length}
          </div>
        </div>
      ) : (
        <div className="memo-empty">今日复习清空了。添加词条或明天再来。</div>
      )}

      <div className="memo-add">
        <input placeholder="词条（如 closure）" value={term} onChange={(e) => setTerm(e.target.value)} />
        <input placeholder="释义" value={def} onChange={(e) => setDef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button className="memo-add-btn" onClick={() => void add()}>
          添加
        </button>
      </div>
    </div>
  );
}
