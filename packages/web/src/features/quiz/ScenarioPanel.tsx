/**
 * ScenarioPanel — 情景题宿主面板（契约 docs/SCENARIO-SPEC.md §5，2026-09-17 新建）。
 *
 * iframe `sandbox="allow-scripts allow-modals allow-forms"`（与服务端 CSP 同向叠保险）挂
 * /api/scenario/demo/:demoId，监听 demo 经桥接发来的 postMessage：
 * ready 帧只点亮「已连接」；report 帧过 validateScenarioReport 白名单后 REST 上报，
 * **完成态只认服务端判分响应**——demo 内的本地对错反馈（体验侧）不算数（契约 §0.4）。
 *
 * ★ 刻意不提供「新标签页打开」：新标签页里 parent 不是本应用，回传链当场断——情景题必须在本应用
 *   iframe 内完成，这是与 HtmlCard/PreviewPanel 唯一的入口差异（契约 §5）。
 * ★ 重试（同一评分点二次上报）暂不覆盖首判——results 只增不改，重试语义属独立批（契约 §9）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScenarioPayload } from '@sb/shared';
import { SCENARIO_READY_TYPE } from '@sb/shared';
import { api } from '../../lib/api';
import { progressSummary, scenarioProgress, validateScenarioReport, type TaskState } from './scenario-view';
import './quiz.css';

interface Props {
  quizId: string;
  payload: ScenarioPayload;
  demoId: string;
}

const STATE_LABEL: Record<TaskState, string> = { pending: '待完成', correct: '判对', wrong: '判错' };

export function ScenarioPanel({ quizId, payload, demoId }: Props) {
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** 白名单（宿主侧三道闸之一，契约 §2）：由题目 tasks 派生，demo 报谁都不认名单外的 */
  const taskIds = useMemo(() => new Set(payload.tasks.map((t) => t.id)), [payload]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // source 比对：只认当前这枚 iframe 发出的帧（别的窗口伪造 demoId 也进不来）
      if (frameRef.current && ev.source !== frameRef.current.contentWindow) return;
      const data = ev.data as { type?: string } | null;
      if (data && data.type === SCENARIO_READY_TYPE) {
        setConnected(true);
        return;
      }
      const report = validateScenarioReport(ev.data, demoId, taskIds);
      if (!report) return;
      api
        .request<{ ok: boolean; correct: boolean }>('/api/scenario/report', {
          method: 'POST',
          body: JSON.stringify({ demoId, taskId: report.taskId, observed: report.observed }),
        })
        .then((r) => {
          if (!r.ok) {
            setErr('服务端拒绝了这次回传（评分点不存在）');
            return;
          }
          setErr('');
          setResults((prev) =>
            prev[report.taskId] === undefined ? { ...prev, [report.taskId]: r.correct } : prev,
          );
        })
        .catch(() => setErr('回传失败：服务端没连上，稍后重试该操作或刷新面板'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [demoId, taskIds]);

  const progress = scenarioProgress(payload, results);

  return (
    <div className="sb-scenario" data-quiz-id={quizId}>
      <header className="sb-scenario-head">
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
          }}
        >
          重开 demo
        </button>
      </header>
      {err && <div className="quiz-explain">{err}</div>}
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
          <li key={task.id} className={`sb-scenario-task is-${state}`}>
            <span className="sb-scenario-task-state">{STATE_LABEL[state]}</span>
            <span className="t">{task.prompt}</span>
            {task.hint && <span className="m">{task.hint}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
