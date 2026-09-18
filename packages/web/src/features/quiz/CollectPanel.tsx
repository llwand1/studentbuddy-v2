/**
 * CollectPanel — 题库页「现场搜集」面板（契约 docs/RESOURCE-SPEC.md §3.5；D2 已批：题库页先行）。
 *
 * 三条件决定长这样：
 * ① **preview/commit 两段式**——搜集结果必须先摆在用户眼前勾选确认，入库按钮只提交
 *    「机验通过 且 人勾选」的交集（外部结果永不直接写库，TOOL-ECOSYSTEM 先例）；
 * ② 逐页抓取记账与逐题拒绝原因**同屏展示**——"为什么只有 2 道能用"不能让用户猜（ADR-5）；
 * ③ 呈现逻辑在 collect-view.ts（组件只接线，判定可单测——weak-report/mix-report 同族纪律）。
 */
import { useState } from 'react';
import type { CollectCandidate, CollectReport, QuizType } from '@sb/shared';
import { QUIZ_TYPE_LABELS } from '@sb/shared';
import { api } from '../../lib/api';
import { collectNote, commitSelection } from './collect-view';
import './quiz.css';

type PreviewResult = { report: CollectReport; candidates: CollectCandidate[] };

function typeLabel(t: QuizType): string {
  return QUIZ_TYPE_LABELS[t] ?? String(t);
}

export function CollectPanel({
  initialTopic,
  onClose,
  onCommitted,
}: {
  initialTopic: string;
  onClose: () => void;
  onCommitted: (quizId: string, count: number) => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<CollectReport | null>(null);
  const [candidates, setCandidates] = useState<CollectCandidate[]>([]);
  const [checked, setChecked] = useState<boolean[]>([]);

  const preview = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setErr('');
    setReport(null);
    setCandidates([]);
    setChecked([]);
    try {
      const r = await api.request<PreviewResult>('/api/quiz/collect/preview', {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim() }),
      });
      setReport(r.report);
      setCandidates(r.candidates);
      // 默认勾上机验通过者：用户的动作是「剔掉不要的」，不是「逐道找能用的」
      setChecked(r.candidates.map((c) => c.ok));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const picked = commitSelection(candidates, checked);
  const commit = async () => {
    if (picked.length === 0 || committing) return;
    setCommitting(true);
    setErr('');
    try {
      const r = await api.request<{ quizId: string; count: number }>('/api/quiz/collect/commit', {
        method: 'POST',
        body: JSON.stringify({ title: `${topic.trim()}（搜集）`, questions: picked }),
      });
      onCommitted(r.quizId, r.count);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  const note = collectNote(report);
  return (
    <div className="collect-panel">
      <div className="collect-row">
        <input
          placeholder="输入主题，现场搜集练习真题（如：二元一次方程 / 英语虚拟语气）"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void preview()}
          disabled={busy}
        />
        <button className="quiz-gen-btn" disabled={!topic.trim() || busy} onClick={() => void preview()}>
          {busy ? '搜集中…' : '搜集预览'}
        </button>
        <button className="collect-close" disabled={busy || committing} onClick={onClose}>
          收起
        </button>
      </div>
      {busy && <div className="collect-hint">正在检索、抓页并摘录题目，通常要几十秒——检索与抓页逐层失败会如实写在报告里。</div>}
      {err && <div className="quiz-explain">{err}</div>}
      {note && <div className="collect-note">{note}</div>}
      {report && report.pages.length > 0 && (
        <ul className="collect-pages">
          {report.pages.map((p) => (
            <li key={p.url}>
              <span className={p.fetched ? 'ok' : 'bad'}>{p.fetched ? '✓' : '✗'}</span>{' '}
              <a href={p.url} target="_blank" rel="noreferrer noopener">
                {p.title || p.url}
              </a>
              {p.reason && <span className="why">{p.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {candidates.map((c, i) => (
        <div key={i} className={c.ok ? 'collect-item' : 'collect-item rejected'}>
          {c.ok ? (
            <label className="pick">
              <input
                type="checkbox"
                checked={!!checked[i]}
                onChange={() => setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))}
              />
              <span className="tag">{typeLabel(c.question.type)}</span>
              <span className="q">{c.question.question}</span>
            </label>
          ) : (
            <span className="pick">
              <span className="tag">{typeLabel(c.question.type)}</span>
              <span className="q">{c.question.question}</span>
              <span className="why">拒：{c.reason}</span>
            </span>
          )}
          {c.question.source?.url && (
            <a className="src" href={c.question.source.url} target="_blank" rel="noreferrer noopener">
              出处
            </a>
          )}
        </div>
      ))}
      {candidates.length > 0 && (
        <div className="collect-foot">
          <button className="quiz-gen-btn" disabled={picked.length === 0 || committing} onClick={() => void commit()}>
            {committing ? '入库中…' : `确认入库（${picked.length} 题）`}
          </button>
          <span className="m">入库前服务端逐题复校验；被拒题永不提交</span>
        </div>
      )}
      {report && !busy && candidates.length === 0 && (
        <div className="collect-hint">这次没有可入库的题——原因见上方报告（没搜到 / 正文没抓到 / 没摘出逐字命中的题）。</div>
      )}
    </div>
  );
}
