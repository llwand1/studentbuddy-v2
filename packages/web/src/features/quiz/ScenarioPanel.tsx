/**
 * ScenarioPanel — 情景题宿主面板（契约 docs/SCENARIO-SPEC.md §5，2026-09-17 新建）。
 *
 * iframe `sandbox="allow-scripts allow-modals allow-forms"`（与服务端 CSP 同向叠保险）挂
 * /api/scenario/demo/:demoId，监听 demo 经桥接发来的 postMessage：
 * ready 帧只点亮「已连接」；report 帧过 validateScenarioReport 白名单后 REST 上报，
 * **完成态只认服务端判分响应**——demo 内的本地对错反馈（体验侧）不算数。
 *
 * ★ 刻意不提供「新标签页打开」：新标签页里 parent 不是本应用，回传链当场断——情景题必须在本应用
 *   iframe 内完成，这是与 HtmlCard/PreviewPanel 唯一的入口差异（契约 §5）。
 * ★ 重试（同一评分点二次上报）暂不覆盖首判——results 只增不改，重试语义是独立的一块（契约 §9）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScenarioPayload, QuizReviewItem } from '@sb/shared';
import { SCENARIO_READY_TYPE } from '@sb/shared';
import { api } from '../../lib/api';
import { progressSummary, scenarioProgress, validateScenarioReport, type TaskState } from './scenario-view';
import './quiz.css';
import './quiz-effects.css';
import { QuizReview } from './QuizReview';
import { AnswerImpact, AnswerSoundToggle } from '../feedback/AnswerImpact';

interface Props {
  sessionId?: string | null;
  quizId: string;
  payload: ScenarioPayload;
  demoId: string;
}

const STATE_LABEL: Record<TaskState, string> = { pending: '待完成', correct: '判对', wrong: '判错' };

export function ScenarioPanel({ quizId, payload, demoId, sessionId }: Props) {
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const accepted = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** 白名单（宿主侧三道闸之一，契约 §2）：由题目 tasks 派生，demo 报谁都不认名单外的 */
  const taskIds = useMemo(() => new Set(payload.tasks.map((t) => t.id)), [payload]);

  useEffect(() => {
    let mounted = true;
    const onMessage = (ev: MessageEvent) => {
      // source 比对：只认当前这枚 iframe 发出的帧（别的窗口伪造 demoId 也进不来）
      if (!frameRef.current || ev.source !== frameRef.current.contentWindow) return;
      const data = ev.data as { type?: string; v?: number; demoId?: string } | null;
      if (data && data.type === SCENARIO_READY_TYPE && data.v === 1 && data.demoId === demoId) {
        setConnected(true);
        return;
      }
      const report = validateScenarioReport(ev.data, demoId, taskIds);
      if (!report || accepted.current.has(report.taskId) || pending.current.has(report.taskId)) return;
      let body: string;
      try {
        if ((JSON.stringify(report.observed) ?? '').length > 4000) throw new Error('too large');
        body = JSON.stringify({ demoId, taskId: report.taskId, observed: report.observed });
      } catch {
        setErr('这次操作数据无法处理，请重开情景后重试。');
        return;
      }
      pending.current.add(report.taskId);
      api
        .request<{ ok: boolean; correct: boolean }>('/api/scenario/report', {
          method: 'POST',
          body,
        })
        .then((r) => {
          if (!mounted) return;
          if (!r.ok) {
            setErr('服务端拒绝了这次回传（评分点不存在）');
            return;
          }
          setErr('');
          accepted.current.add(report.taskId);
          setAnswers((prev) => ({ ...prev, [report.taskId]: report.observed }));
          setResults((prev) =>
            prev[report.taskId] === undefined ? { ...prev, [report.taskId]: r.correct } : prev,
          );
        })
        .catch(() => { if (mounted) setErr('回传失败：请重试该操作，或重开情景后再试。'); })
        .finally(() => pending.current.delete(report.taskId));
    };
    window.addEventListener('message', onMessage);
    return () => { mounted = false; window.removeEventListener('message', onMessage); };
  }, [demoId, taskIds]);

  const progress = scenarioProgress(payload, results);
  const reviewItems: QuizReviewItem[] = payload.tasks.flatMap((task) => results[task.id] === undefined ? [] : [{
    question: task.prompt,
    answer: JSON.stringify(answers[task.id]) ?? '未提供操作值',
    expected: JSON.stringify(task.criteria),
    verdict: results[task.id] ? 'correct' : 'wrong',
    context: task.hint ?? '',
  }]);

  return (
    <div className="sb-scenario quiz-adventure" data-quiz-id={quizId}>
      <span className="quiz-eyebrow">情景试炼</span>
      <header className="sb-scenario-head">
        <AnswerSoundToggle />
        <span className="sb-scenario-title">{payload.title}</span>
        <span className={connected ? 'sb-scenario-live' : 'sb-scenario-live off'}>
          {connected ? '沙箱已连接' : '沙箱连接中…'}
        </span>
        <span className="m">{progressSummary(progress)}</span>
        <button
          className="quiz-gen-btn"
          onClick={() => {
            // 刷新 iframe（换 key 强制重挂）；完成态是服务端数据，不随刷新丢
            setNonce((n) => n + 1);
            setConnected(false);
          }}
        >
          重开情景
        </button>
      </header>
      {err && <div className="quiz-explain" role="alert">{err}</div>}
      <p className="quiz-muted">操作情景完成任务。重开保留本轮首次判定；完成后可一键查看图文讲解。</p>
      <iframe
        key={nonce}
        ref={frameRef}
        className="sb-scenario-frame"
        src={`/api/scenario/demo/${demoId}`}
        title={payload.title}
        sandbox="allow-scripts allow-modals allow-forms"
      />
      <ul className="sb-scenario-tasks">
        {progress.items.map(({ task, state }) => (
          <li key={task.id} className={`sb-scenario-task answer-surface is-${state}`}>
            {state !== 'pending' && <AnswerImpact verdict={state} audible />}
            <span className="sb-scenario-task-state">{STATE_LABEL[state]}</span>
            <span className="t">{task.prompt}</span>
            {task.hint && <span className="m">{task.hint}</span>}
          </li>
        ))}
      </ul>
      <QuizReview sessionId={sessionId} title={payload.title} kind="scenario"
        items={reviewItems} total={payload.tasks.length} />
    </div>
  );
}
