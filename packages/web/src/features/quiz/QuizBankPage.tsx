/**
 * QuizBankPage — 题库页：一键出题 + 题库列表 + 练习 + 薄弱点。
 */
import { useCallback, useEffect, useState } from 'react';
import type { QuizPayload, QuizMixReport, QuizImageReport, AnswerStyle } from '@sb/shared';
import { api } from '../../lib/api';
import { QuizCard } from './QuizCard';
import { AskStyleCard, useAskStyle } from '../chat/AskStyleCard';
import { mixSummary, shortfallText, imageNote } from './mix-report';
import './quiz.css';

type BankItem = { id: string; title: string; source: string; count: number; created_at: string };

export function QuizBankPage() {
  const [bank, setBank] = useState<BankItem[]>([]);
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState('');
  const [mixTip, setMixTip] = useState('');
  const [note, setNote] = useState('');
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

  // 出题配比是全局设置（设置页改的），本页只展示摘要；切回本页会重新挂载，故不必轮询
  useEffect(() => {
    api.settings
      .quizMix()
      .then((r) => setMixTip(mixSummary(r.mix)))
      .catch(() => setMixTip(''));
  }, []);

  /** 单次覆盖：style 只在「没配过 + 刚在选项卡上选完」这一条路上非空（契约 ANSWER-STYLE §4） */
  const generate = async (style?: AnswerStyle) => {
    if (!topic.trim() || generating) return;
    setGenerating(true);
    setErr('');
    setNote('');
    try {
      const r = await api.request<{
        quizId?: string;
        quiz: QuizPayload;
        mix?: QuizMixReport;
        images?: QuizImageReport;
      }>('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim(), style }),
      });
      // 缺题与缺图同一套「缺了就说什么」口径，都挂在 note 上（不新开文案通道，免两端各说一套）
      setNote([r.mix ? shortfallText(r.mix) : null, imageNote(r.images)].filter((s): s is string => s !== null).join(' '));
      if (r.quizId) setPracticing({ quizId: r.quizId, quiz: r.quiz });
      setTopic('');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  /** 没配过回答方式时，点「一键出题」先就地展开选项卡问一次（与聊天页同一个 hook，行为不分叉） */
  const ask = useAskStyle((style) => void generate(style));

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
        {practicing.weak && <div className="quiz-explain quiz-explain-mt">{practicing.weak}</div>}
      </div>
    );
  }

  return (
    <div className="quiz-bank-page">
      <h2>题库</h2>
      <div className="quiz-gen-form">
        <input placeholder="输入主题一键出题（如：二重积分 / 英语虚拟语气）" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask.tap()} />
        <button className="quiz-gen-btn" disabled={!topic.trim() || generating} onClick={() => ask.tap()}>
          {generating ? '出题中…' : '一键出题'}
        </button>
      </div>
      {ask.hint && <div className="ask-style-hint">{ask.hint}</div>}
      {ask.card && <AskStyleCard {...ask.card} busy={generating} />}
      {mixTip && <div className="quiz-mix-tip">本次出题配比：{mixTip}{ask.summary && <>｜回答方式：{ask.summary}</>}（设置页可改）</div>}
      {note && <div className="quiz-note">{note}</div>}
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
