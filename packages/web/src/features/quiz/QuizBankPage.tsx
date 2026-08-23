/**
 * QuizBankPage — 题库页：一键出题 + 题库列表 + 练习 + 薄弱点。
 */
import { useCallback, useEffect, useState } from 'react';
import type { QuizPayload } from '@sb/shared';
import { api } from '../../lib/api';
import { QuizCard } from './QuizCard';
import './quiz.css';

type BankItem = { id: string; title: string; source: string; count: number; created_at: string };

export function QuizBankPage() {
  const [bank, setBank] = useState<BankItem[]>([]);
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState('');
  const [practicing, setPracticing] = useState<{ quizId: string; quiz: QuizPayload; weak?: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setBank(await api.request('/api/quiz/bank'));
    } catch {
      setBank([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const generate = async () => {
    if (!topic.trim() || generating) return;
    setGenerating(true);
    setErr('');
    try {
      const r = await api.request<{ quizId?: string; quiz: QuizPayload }>('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim() }),
      });
      if (r.quizId) setPracticing({ quizId: r.quizId, quiz: r.quiz });
      setTopic('');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const openPractice = async (id: string) => {
    const r = await api.request<{ quiz: QuizPayload }>(`/api/quiz/bank/${id}`);
    setPracticing({ quizId: id, quiz: r.quiz });
  };

  const answer = (index: number, correct: boolean) => {
    if (practicing?.quizId) {
      void api.request('/api/quiz/stats/record', {
        method: 'POST',
        body: JSON.stringify({ quizId: practicing.quizId, questionIndex: index, correct }),
      });
    }
  };

  const analyze = async () => {
    if (!practicing) return;
    const r = await api.request<{ weak: Array<{ topic: string; questionIndexes: number[]; reason: string; suggestion: string }> }>(
      `/api/quiz/analyze/${practicing.quizId}`,
    );
    setPracticing({ ...practicing, weak: r.weak.length ? `${r.weak[0]?.topic}：第 ${r.weak[0]?.questionIndexes.map((i) => i + 1).join('、')} 题正确率低（${r.weak[0]?.reason}）。${r.weak[0]?.suggestion}` : '暂无薄弱点（先做题）' });
  };

  if (practicing) {
    return (
      <div className="quiz-bank-page">
        <button className="quiz-gen-btn" onClick={() => setPracticing(null)}>
          ← 返回题库
        </button>
        <QuizCard title={practicing.quiz.title ?? '练习'} questions={practicing.quiz.questions} onAnswer={answer} />
        <button className="quiz-gen-btn" onClick={() => void analyze()}>
          薄弱点分析
        </button>
        {practicing.weak && <div className="quiz-explain" style={{ marginTop: 12 }}>{practicing.weak}</div>}
      </div>
    );
  }

  return (
    <div className="quiz-bank-page">
      <h2>题库</h2>
      <div className="quiz-gen-form">
        <input placeholder="输入主题一键出题（如：二重积分 / 英语虚拟语气）" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void generate()} />
        <button className="quiz-gen-btn" disabled={!topic.trim() || generating} onClick={() => void generate()}>
          {generating ? '出题中…' : '一键出题'}
        </button>
      </div>
      {err && <div className="quiz-explain">{err}</div>}
      {bank.map((b) => (
        <div key={b.id} className="quiz-bank-item" onClick={() => void openPractice(b.id)} role="button" tabIndex={0}>
          <span className="t">{b.title}</span>
          <span className="m">{b.count} 题 · {b.source} · {b.created_at?.slice(0, 10)}</span>
          <button
            className="quiz-bank-del"
            onClick={async (e) => {
              e.stopPropagation();
              await api.request(`/api/quiz/bank/${b.id}`, { method: 'DELETE' });
              await reload();
            }}
          >
            删除
          </button>
        </div>
      ))}
      {bank.length === 0 && <div className="m">暂无题库——输入主题出一套试试。</div>}
    </div>
  );
}
