import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { QuizRoundHistoryEntry } from '@sb/shared';
import { quizRoundsApi } from '../../lib/api-quiz-rounds';
import './quiz-round-history.css';
const originLabel = { chat: '对话 / 共读', arrival: '篝火热身', desktop: '桌面题卡', scenario: '情景交互' };
export function QuizRoundHistoryPanel({ onClose, renderRound }: { onClose: () => void; renderRound: (id: string) => ReactNode }) {
  const [items, setItems] = useState<QuizRoundHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const load = async (before?: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await quizRoundsApi.history(before); setItems(prev => before ? [...prev, ...result.items] : result.items); setCursor(result.nextCursor); }
    catch (e) { setError(e instanceof Error ? e.message : '作答历史没有读到。'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { panel.current?.focus(); }, [selected]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="quiz-history-backdrop"><section ref={panel} tabIndex={-1} className="quiz-history-panel" role="dialog" aria-modal="true" aria-label="作答历史"
    onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]') ?? []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <header><h3>作答历史</h3><div>{selected && <button type="button" onClick={() => setSelected(null)}>返回记录列表</button>}<button type="button" onClick={onClose}>关闭历史</button></div></header>
    {selected ? renderRound(selected) : <>
      <p>每轮的答案、思考和已完成的分析分别保存，换题或收起题卡后仍可回看。</p>
      {items.map(item => <button type="button" key={item.id} className="quiz-history-entry" onClick={() => setSelected(item.id)}>
        <strong>{item.title}</strong><span>{originLabel[item.origin]} · 第 {item.number} 轮 · {item.questionCount} 题 · {item.state === 'draft' ? '未交卷' : '已交卷'}</span><small>{new Date(item.createdAt).toLocaleString()}</small>
      </button>)}
      {!busy && !items.length && !error && <p>还没有保存的作答记录。</p>}
      {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>加载更早的记录</button>}
      {busy && <p role="status">正在读取记录…</p>}{error && <p role="alert">{error}<button type="button" onClick={() => void load()}>重试读取</button></p>}
    </>}
  </section></div>, document.body);
}
