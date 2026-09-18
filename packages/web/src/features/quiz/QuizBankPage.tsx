/**
 * QuizBankPage — 题库页：一键出题 + 题库列表 + 练习 + 薄弱点。
 */
import { useCallback, useEffect, useState } from 'react';
import type { QuizPayload, QuizMixReport, QuizImageReport, QuizRef, AnswerStyle, WeakAnalysis, ScenarioPayload, ScenarioMixResult } from '@sb/shared';
import { api } from '../../lib/api';
import { QuizCard } from './QuizCard';
import { ScenarioPanel } from './ScenarioPanel';
import { isScenarioItem, isScenarioPayload } from './scenario-view';
import { AskStyleCard, useAskStyle } from '../chat/AskStyleCard';
import { OnlineToggle } from '../../components/OnlineToggle';
import { RefList } from './RefList';
import { CollectPanel } from './CollectPanel';
import { mixSummary, shortfallText, imageNote, searchNote, refsList, scenarioMixNote } from './mix-report';
import { weakView } from './weak-report';
import './quiz.css';

type BankItem = { id: string; title: string; source: string; count: number; created_at: string };

export function QuizBankPage({ onOpenNotes }: { onOpenNotes?: (quizId?: string) => void }) {
  const [bank, setBank] = useState<BankItem[]>([]);
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);
  /** 联网开关：默认开（题库页是主出题口，时效性题目要靠它）；只作用于本次请求，不落库 */
  const [online, setOnline] = useState(true);
  /** 现场搜集面板开合（契约 RESOURCE-SPEC D2 已批：题库页先行；preview/commit 两段在面板内完成） */
  const [showCollect, setShowCollect] = useState(false);
  const [err, setErr] = useState('');
  const [mixTip, setMixTip] = useState('');
  const [note, setNote] = useState('');
  /** 本次出题的参考来源清单（可点击，契约 QUIZ-SEARCH-SPEC §2.8）；没联网/没命中即空数组 */
  const [refs, setRefs] = useState<QuizRef[]>([]);
  const [practicing, setPracticing] = useState<{ quizId: string; quiz: QuizPayload; weak?: WeakAnalysis } | null>(null);
  /** 情景题练习（契约 docs/SCENARIO-SPEC.md）：与普通题练习两条互斥视图，入口在 openPractice 里分派 */
  const [scenario, setScenario] = useState<{ quizId: string; payload: ScenarioPayload; demoId: string } | null>(null);
  /** 分析进行中：AI 要跑几秒，旧版点了毫无反应，用户以为按钮坏了会连点（ADR-5 三态） */
  const [analyzing, setAnalyzing] = useState(false);
  const [weakErr, setWeakErr] = useState('');

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
        scenarios?: ScenarioMixResult[];
      }>('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim(), style, search: online }),
      });
      // 缺题、缺图、联网、情景套数四件事同一套「缺了就说什么」口径，都挂在 note 上（不新开文案通道）；
      // 有来源清单时改由清单承担告知（可展开、可点），note 只留「没取到参考」那两种——避免说两遍
      const found = refsList(r.images?.search);
      setRefs(found);
      setNote(
        [
          r.mix ? shortfallText(r.mix) : null,
          imageNote(r.images),
          found.length === 0 ? searchNote(r.images?.search) : null,
          scenarioMixNote(r.scenarios),
        ]
          .filter((s): s is string => s !== null)
          .join(' '),
      );
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
    setWeakErr('');
    // 情景题分派（契约 §5）：data 是 ScenarioPayload 时换 demoId 开宿主面板，不走 QuizCard
    if (isScenarioPayload(r.quiz)) {
      try {
        const s = await api.request<{ demoId: string }>(`/api/scenario/by-quiz/${id}`);
        setScenario({ quizId: id, payload: r.quiz, demoId: s.demoId });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setPracticing({ quizId: id, quiz: r.quiz });
  };

  const answer = (index: number, correct: boolean, answerVal?: number[] | string) => {
    if (practicing?.quizId) {
      void api.request('/api/quiz/stats/record', {
        method: 'POST',
        body: JSON.stringify({
          quizId: practicing.quizId,
          questionIndex: index,
          correct,
          ...(answerVal !== undefined ? { answer: answerVal } : {}),
        }),
      });
    }
  };

  /**
   * 薄弱点分析：服务端走 analyzer 角色**实时生成**（契约 docs/QUIZ-WEAK-SPEC.md）。
   * ★ 三态齐备（ADR-5）：进行中按钮转「分析中…」并禁用；失败有独立错误位，不静默。
   * ★ 用函数式 setState 而非 `{...practicing}`——闭包里的 practicing 可能是旧值。
   */
  const analyze = async () => {
    if (!practicing || analyzing) return;
    setAnalyzing(true);
    setWeakErr('');
    try {
      const r = await api.request<WeakAnalysis>(`/api/quiz/analyze/${practicing.quizId}`);
      setPracticing((p) => (p ? { ...p, weak: r } : p));
    } catch (e) {
      setWeakErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  /** 展示模型由纯函数产出（weak-report.ts）——判定留在组件里就测不到 */
  const view = practicing?.weak ? weakView(practicing.weak) : null;

  if (scenario) {
    return (
      <div className="quiz-bank-page">
        <button className="quiz-gen-btn" onClick={() => setScenario(null)}>
          ← 返回题库
        </button>
        <ScenarioPanel quizId={scenario.quizId} payload={scenario.payload} demoId={scenario.demoId} />
        {/* 情景题完成态即统计（quiz_stats 同表），薄弱点分析对情景题的覆盖属 M4（契约 §8） */}
      </div>
    );
  }

  if (practicing) {
    return (
      <div className="quiz-bank-page">
        <button className="quiz-gen-btn" onClick={() => setPracticing(null)}>
          ← 返回题库
        </button>
        <QuizCard title={practicing.quiz.title ?? '练习'} questions={practicing.quiz.questions} onAnswer={answer} />
        {/* 出题后立即进练习视图，故 note/来源清单必须在这里也渲染——只在列表视图渲染＝用户永远看不到（真机实测） */}
        {note && <div className="quiz-note">{note}</div>}
        <RefList refs={refs} />
        <div className="quiz-practice-actions">
          <button className="quiz-gen-btn" disabled={analyzing} onClick={() => void analyze()}>
            {analyzing ? '分析中…' : '薄弱点分析'}
          </button>
          <button className="quiz-gen-btn" onClick={() => onOpenNotes?.(practicing.quizId)}>
            本套笔记
          </button>
        </div>
        {weakErr && <div className="quiz-explain quiz-explain-mt">分析失败：{weakErr}</div>}
        {/* 多主题列表：旧版只取 weak[0] 拼成一句话，模型聚出的其余主题全白算 */}
        {view && (
          <div className="quiz-weak">
            {view.headNote && <div className="quiz-weak-head">{view.headNote}</div>}
            {view.emptyNote && <div className="quiz-explain">{view.emptyNote}</div>}
            {view.points.map((p) => (
              <div key={`${p.topic}-${p.indexes}`} className="quiz-weak-item">
                <div className="quiz-weak-topic">
                  {p.topic}
                  <span className="m">{p.indexes}</span>
                </div>
                <div className="quiz-weak-reason">{p.reason}</div>
                <div className="quiz-weak-sug">建议：{p.suggestion}</div>
              </div>
            ))}
            {view.fallbackNote && <div className="quiz-weak-fallback">{view.fallbackNote}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="quiz-bank-page">
      <h2>题库</h2>
      <div className="quiz-gen-form">
        <input placeholder="输入主题一键出题（如：二重积分 / 英语虚拟语气）" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask.tap()} />
        <OnlineToggle on={online} disabled={generating} onToggle={setOnline} />
        <button className="quiz-gen-btn" disabled={!topic.trim() || generating} onClick={() => ask.tap()}>
          {generating ? '出题中…' : '一键出题'}
        </button>
        <button className="quiz-collect-btn" onClick={() => setShowCollect((v) => !v)}>
          {showCollect ? '收起搜集' : '搜集题目'}
        </button>
      </div>
      {showCollect && (
        <CollectPanel
          initialTopic={topic}
          onClose={() => setShowCollect(false)}
          onCommitted={(_quizId, count) => {
            setShowCollect(false);
            setTopic('');
            setNote(`已入库 ${count} 道搜集结果（逐题可点「出处」回查原页）`);
            void reload();
          }}
        />
      )}
      {ask.hint && <div className="ask-style-hint">{ask.hint}</div>}
      {ask.card && <AskStyleCard {...ask.card} busy={generating} />}
      {mixTip && <div className="quiz-mix-tip">本次出题配比：{mixTip}{ask.summary && <>｜回答方式：{ask.summary}</>}（设置页可改）</div>}
      {note && <div className="quiz-note">{note}</div>}
      <RefList refs={refs} />
      {err && <div className="quiz-explain">{err}</div>}
      {bank.map((b) => (
        <div key={b.id} className="quiz-bank-item" onClick={() => void openPractice(b.id)} role="button" tabIndex={0}>
          <span className="t">
            {isScenarioItem(b) && <span className="quiz-note">情景</span>} {b.title}
          </span>
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
