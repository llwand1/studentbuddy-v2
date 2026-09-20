/**
 * PkScenarioHost — 对战情景题宿主（契约 docs/PK-SPEC.md §15.4，B4，2026-09-20）。
 *
 * 与学习侧 `ScenarioPanel` 同一套通道（零新造）：iframe
 * `sandbox="allow-scripts allow-modals allow-forms"`（与服务端 CSP 同向叠保险）挂
 * `/api/pk/rooms/:id/scenario/:demoId`，监听 demo 经桥接发来的 postMessage——
 * report 帧过 `validateScenarioReport` 白名单后 REST 上报，**对错只认服务端判分**
 * （demo 是模型写的不可信侧；criteria 在服务端内存里，宿主根本拿不到）。
 *
 * 与学习侧的三处刻意差异：
 * ① 上报端点是 `/api/pk/rooms/:id/scenario-report`（判分结果随房间快照走 SSE 回灌双方）；
 * ② taskResults 以**服务端快照为唯一事实源**（props 直读）——重复上报以最后一次为准，
 *    demo 允许改正重报，本地不再维护一份 results（两份迟早漂移）；
 * ③ 没有「重开 demo」按钮：对战答题时限（45s）内重开等于重置操作进度，不该被当成卡顿的救命稻草。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PkQuestion } from '@sb/shared';
import { SCENARIO_READY_TYPE } from '@sb/shared';
import { api } from '../../lib/api';
import { validateScenarioReport } from '../quiz/scenario-view';

interface Props {
  roomId: string;
  /** kind='scenario' 的待答题（调用方保证；kind 不符直接不渲染） */
  question: PkQuestion;
}

export function PkScenarioHost({ roomId, question }: Props) {
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const demo = question.scenario;
  /** 白名单（宿主侧一道闸）：由题目 tasks 派生，demo 报谁都不认名单外的 */
  const taskIds = useMemo(() => new Set(demo?.tasks.map((t) => t.id) ?? []), [demo]);
  const demoId = demo?.demoId ?? '';

  useEffect(() => {
    if (!demoId) return;
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
      api.pk
        .reportScenario(roomId, question.id, report.taskId, report.observed)
        .then(() => setErr(''))
        // 判分结果不在本地猜：失败只报「没连上」，状态以 SSE 快照为准
        .catch(() => setErr('回传失败：服务端没连上，稍后重试该操作或刷新页面'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [demoId, taskIds, question.id, roomId]);

  if (!demo) return null;

  return (
    <div className="sb-pk-scenario">
      <div className="sb-pk-scenario-head">
        <span className="sb-pk-hint">{connected ? '沙箱已连接' : '沙箱连接中…'}</span>
        <span className="sb-pk-hint">在 demo 里完成下面的任务，全中 +2 / 有错 −1</span>
      </div>
      {err && <div className="sb-pk-error">{err}</div>}
      <iframe
        ref={frameRef}
        className="sb-pk-scenario-frame"
        src={api.pk.scenarioDemoUrl(roomId, demoId)}
        title={demo.title}
        sandbox="allow-scripts allow-modals allow-forms"
      />
      <ul className="sb-pk-scenario-tasks">
        {demo.tasks.map((t) => {
          const state = question.taskResults?.[t.id];
          return (
            <li key={t.id} className={`sb-pk-scenario-task${state === undefined ? '' : state ? ' ok' : ' no'}`}>
              <span className="sb-pk-scenario-state">{state === undefined ? '待完成' : state ? '判对' : '判错'}</span>
              <span className="t">{t.prompt}</span>
              {t.hint && <span className="m">{t.hint}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
