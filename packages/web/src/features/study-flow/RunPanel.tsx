/**
 * RunPanel — 学习流的**运行控制与轨迹**（契约 docs/STUDY-FLOW-SPEC.md §6）。
 *
 * ★ 三条最要紧的交互（都来自服务端状态机的真实约束，不是装饰）：
 *  ① **一步 = 一次请求跑完一整轮 LLM 对话**，数十秒是常态 ⇒ 在途态必须明确说「在跑第几步、最长等多久」，
 *     并给一个「停止等待」。★ 停止的是**前端等待**，服务端那一步仍在跑 —— 文案必须说清，
 *     否则用户会以为"点了停止就没事了"，然后看到运行继续往前走而困惑。
 *  ② `paused` 是**正常中间态**（跑到等你作答的步骤），不是错误。故按钮是「继续下一步」而非「重试」，
 *     并把服务端给的 `pauseReason`（在等什么）原样显示。
 *  ③ 轨迹逐步列出，每步是**哪个交互类型、什么状态、什么时候**。这是"控制流被固定化"之后
 *     用户复核"到底按我编排的跑了没有"的唯一依据。
 *
 * ★ 本组件不改定义：只驱动运行。改定义/编排在 `FlowPage` + `StepPanel`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlowRun, FlowRunStep, KnowledgeNode } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { NO_RESPONSE } from '../../lib/api-request';
import { findFlowStepMeta } from '@sb/shared';
import {
  advanceButtonText,
  advanceGate,
  canCancel,
  frozenVersionText,
  pauseHint,
  runProgressText,
  runStatusLabel,
  runStatusTone,
  stepStatusLabel,
} from './run-status';

type RunDetail = FlowRun & { producedNodes: KnowledgeNode[] };

export function RunPanel({
  defId,
  blockedReason,
  blockedStepId,
  onGoGraph,
  onJumpToStep,
}: {
  defId: string | null;
  /**
   * 非空则不许开始新运行。
   * ★ 为什么由外部注入：运行冻结的是**库里那一版定义**（`flow_run.def_snapshot`，契约 §6.3），
   *   画布上有未保存改动时开跑，跑的是旧版——用户会以为"我明明改了它却不按我改的跑"。
   */
  blockedReason?: string;
  /**
   * 被拦下的原因出在哪一步（目前只有"参数没填好"这一种会带它）。
   * ★ 有它就给一个「去改这一步」：**报错必须能落到具体位置上**，
   *   否则用户拿到的只是"被拒了"，还得自己在画布上找是哪一步。
   */
  blockedStepId?: string;
  onGoGraph?: () => void;
  onJumpToStep?: (stepId: string) => void;
}) {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const reloadRuns = useCallback(async () => {
    if (!defId) {
      setRuns([]);
      return;
    }
    try {
      setRuns(await api.studyFlow.listRuns(20));
    } catch {
      setRuns([]);
    }
  }, [defId]);

  const reloadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.studyFlow.getRun(id));
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  // 切流时把上一轮的运行收起来（否则会看到属于别的流的轨迹）
  useEffect(() => {
    setCurrentId(null);
    setDetail(null);
    setNote('');
    setErr('');
  }, [defId]);

  useEffect(() => {
    if (currentId) void reloadDetail(currentId);
  }, [currentId, reloadDetail]);

  const start = async () => {
    if (!defId || pending) return;
    setErr('');
    try {
      const r = await api.studyFlow.createRun(defId);
      setCurrentId(r.id);
      setDetail({ ...r, producedNodes: [] });
      await reloadRuns();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '无法开始运行');
    }
  };

  const advance = async () => {
    if (!currentId || pending) return;
    setPending(true);
    setErr('');
    setNote('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await api.studyFlow.advanceRun(currentId, ctrl.signal);
      setDetail({ ...r.run, producedNodes: detail?.producedNodes ?? [] });
      if (r.note) setNote(r.note);
      await reloadDetail(currentId);
      await reloadRuns();
    } catch (e) {
      if (e instanceof ApiError) {
        // status=0 是「等太久/被取消」，不是服务端拒绝——文案本身已区分（见 api-request）
        setErr(e.message);
        // 不确定那一步到底跑完没有 ⇒ 回读一次真实状态，别让界面停在猜的状态
        if (e.status === NO_RESPONSE) await reloadDetail(currentId);
      } else {
        setErr('这一步没有跑完');
      }
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  };

  const cancel = async () => {
    if (!currentId || pending) return;
    try {
      await api.studyFlow.cancelRun(currentId);
      await reloadDetail(currentId);
      await reloadRuns();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '终止失败');
    }
  };

  const gate = detail ? advanceGate(detail) : { ok: true as const };
  /** 只看属于当前这条流的运行（`listRuns` 返回的是全仓运行） */
  const myRuns = runs.filter((r) => r.defId === defId);

  return (
    <div className="fl-run">
      <div className="fl-run-head">
        <div className="fl-panel-title">运行</div>
        <button
          className="fl-btn primary"
          disabled={!defId || pending || Boolean(blockedReason)}
          title={blockedReason ?? ''}
          onClick={() => void start()}
        >
          开始新一轮
        </button>
        {myRuns.length > 0 && (
          <select value={currentId ?? ''} onChange={(e) => setCurrentId(e.target.value || null)} aria-label="历史运行">
            <option value="">选一次运行…</option>
            {myRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.createdAt.slice(5, 16).replace('T', ' ')} · {runStatusLabel(r.status)} · {r.stepCount} 步
              </option>
            ))}
          </select>
        )}
      </div>

      {blockedReason && (
        <p className="fl-warn">
          {blockedReason}
          {blockedStepId && onJumpToStep && (
            <button className="fl-mini" onClick={() => onJumpToStep(blockedStepId)}>
              去改这一步
            </button>
          )}
        </p>
      )}

      {!detail && <p className="fl-panel-hint">还没有选中的运行。点「开始新一轮」按这条流跑一次。</p>}

      {detail && (
        <>
          <div className="fl-run-bar">
            <span className={runStatusTone(detail.status)}>{runStatusLabel(detail.status)}</span>
            <span className="fl-run-meta">{runProgressText(detail)}</span>
            <span className="fl-run-meta">{frozenVersionText(detail)}</span>
            <div className="fl-run-actions">
              <button className="fl-btn primary" disabled={pending || !gate.ok} title={gate.ok ? '' : gate.reason} onClick={() => void advance()}>
                {pending ? '跑着呢…' : advanceButtonText(detail)}
              </button>
              {pending && (
                <button className="fl-btn" onClick={() => abortRef.current?.abort()}>
                  停止等待
                </button>
              )}
              {canCancel(detail) && !pending && (
                <button className="fl-btn danger" onClick={() => void cancel()}>
                  终止
                </button>
              )}
            </div>
          </div>

          {!gate.ok && <p className="fl-panel-hint">{gate.reason}</p>}
          {pending && (
            <p className="fl-running">
              正在跑这一步——一步就是完整的一轮对话（可能联网检索），最长会等 180 秒。
              「停止等待」只是不再等结果，服务端这一步可能仍在跑，稍后点开这次运行就能看到它有没有跑完。
            </p>
          )}
          {pauseHint(detail) && <p className="fl-paused">{pauseHint(detail)}</p>}
          {note && <p className="fl-note">{note}</p>}
          {err && <p className="fl-err">{err}</p>}
          {detail.error && <p className="fl-err">{detail.error}</p>}

          <div className="fl-steps">
            {(detail.steps ?? []).map((s: FlowRunStep) => (
              <div key={s.id} className={`fl-step ${s.status}`}>
                <span className="fl-step-seq">{s.seq}</span>
                <span className="fl-step-kind">{findFlowStepMeta(s.kind)?.label ?? s.kind}</span>
                <span className={`fl-step-status ${s.status}`}>{stepStatusLabel(s.status)}</span>
                <span className="fl-step-time">{s.startedAt.slice(11, 19)}</span>
                {s.error && <span className="fl-step-error">{s.error}</span>}
              </div>
            ))}
            {(detail.steps ?? []).length === 0 && <p className="fl-panel-hint">还没有跑过任何一步。</p>}
          </div>

          {detail.producedNodes.length > 0 && (
            <div className="fl-produced">
              <span className="fl-panel-hint">这次运行产出了 {detail.producedNodes.length} 个知识节点：</span>
              <div className="fl-produced-list">
                {detail.producedNodes.slice(0, 12).map((n) => (
                  <span key={n.id} className={`fl-produced-item ${n.kind}`}>
                    {n.refText}
                  </span>
                ))}
              </div>
              {onGoGraph && (
                <button className="fl-btn" onClick={onGoGraph}>
                  去知识图看它们的关系
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
