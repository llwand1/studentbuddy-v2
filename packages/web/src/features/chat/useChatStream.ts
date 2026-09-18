/**
 * useChatStream — 对话流订阅与发送编排（拆自 v1 1114 行巨 hook 的关注点之一）。
 * 职责边界：SSE 生命周期 / 流式文本累积 / 错误呈现 / 停止；会话管理在 useSessions，
 * 输入框 UI 在 Composer——单一关注点（ADR-3 的前端落地）。
 *
 * 2026-09-14：方案选择框（契约 docs/ASK-CHOICE-SPEC.md）的挂起队列抽到 `useChoiceQueue`，本文件只在事件入口做一次转发（本文件贴着 AGENTS 行数红线，装不下那 90 行）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent, TaskItem, TokenUsage } from '@sb/shared';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { api } from '../../lib/api';
import { createTokenDrain, type TokenDrain } from './stream-smooth';
import { foldToolRounds } from './history-fold';
import { useChoiceQueue } from './useChoiceQueue';
import { useSendActions } from './useSendActions';
import { applyChatBlock, type QuizBlockView, type ScenarioBlockView } from './chat-blocks';
export type { TaskItem, TaskStatus } from '@sb/shared';

export interface StreamMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 消息时间：历史消息取库内 created_at（SQLite UTC 串），本轮新消息取本地 ISO */
  ts?: string;
  streaming?: boolean;
  /** v17 看图：用户上传的图片（base64 dataURL），仅用于气泡内缩略图回显 */
  images?: Array<{ dataUrl: string; name?: string }>;
  quizBlock?: QuizBlockView;
  /** 情景题卡片（M3，契约 SCENARIO-SPEC §8）：live 走 block 事件、历史由 chat-blocks 还原 */
  scenarioBlock?: ScenarioBlockView;
  /**
   * 这条回答的执行过程（工具卡片）。★ 归属到消息而非页面：
   * 历史消息由 history-fold 从库里重建（tool_calls 展开 + tool 结果回填），
   * 本轮消息由 step 事件累积、在 done 时归并进来。正文为空但有 steps 的消息同样要渲染
   * （纯工具轮 / 被停止的半轮），否则过程又丢了。
   */
  steps?: ToolStep[];
  /** 这条回答的思考链原文（v11 起落库；历史由 history-fold 读列、本轮由 done 归并） */
  reasoning?: string;
  /** 这条回答最终声明的任务清单（同上；update_tasks 是全量覆盖语义） */
  tasks?: TaskItem[];
}

export interface ToolStep {
  tool: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  /** 工具入参原文（JSON 串）：过程卡片点开看 */
  args?: string;
  /** 工具结果摘要（截断 ~400 字）：同上 */
  result?: string;
}

/**
 * 任务清单条目（SSE tasks 事件）：**契约在 @sb/shared**（三态 pending/in_progress/done），
 * 本文件只转发，渲染层不必关心它住哪——单一事实源见 shared/src/task-list.ts。
 */

export function useChatStream(
  sessionId: string | null,
  onRoundDone?: () => void,
  /** 生成状态上报（App 侧栏「回复中」提示）：busy 翻转时回调一次 */
  onBusyChange?: (busy: boolean, sessionId: string | null) => void,
  /** v18.4 联网开关（ChatView 持有）：透传给 send / rerun，随本轮出站（服务端 chat/opening.ts） */
  online?: boolean,
) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  /**
   * 流式正文也以 **ref 为真相源**：done 时要拿「已上屏的全文」去和库内文本比对后归位到消息上，
   * 而 bufRef 只装尚未 flush 的尾巴、state 在 SSE 回调闭包里是创建时的过期值——只有 ref 读得到当前全文。
   * 顺带根治一个隐患：归并消息原先写在 setStreamingText 的 updater 内部（updater 里做副作用），
   * 而 main.tsx 开了 StrictMode ⇒ 开发期 updater 会被调用两次 ⇒ setMessages 入队两次 ⇒ 回答重复一条。
   * 副作用移出 updater 后，updater 只剩纯赋值，双调用无害。
   */
  const streamingRef = useRef('');
  const commitStreaming = useCallback((next: string) => {
    streamingRef.current = next;
    setStreamingText(next);
  }, []);
  const appendStreaming = useCallback((chunk: string) => {
    streamingRef.current += chunk;
    setStreamingText(streamingRef.current);
  }, []);
  /**
   * 「本轮过程」三件套（reasoning / steps / tasks）一律以 **ref 为真相源、state 只作渲染镜像**。
   * 原因：done 事件要把本轮过程整块归位到那条回答消息上，而 SSE 事件回调的闭包捕获的是
   * 创建时的 state（恒为空），读不到最新值——只有 ref 能读到。
   */
  const [reasoning, setReasoning] = useState('');
  const reasoningRef = useRef('');
  const pushReasoning = useCallback((s: string) => {
    reasoningRef.current += s;
    setReasoning(reasoningRef.current);
  }, []);
  const clearReasoning = useCallback(() => {
    reasoningRef.current = '';
    setReasoning('');
  }, []);
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const stepsRef = useRef<ToolStep[]>([]);
  const commitSteps = useCallback((next: ToolStep[]) => {
    stepsRef.current = next;
    setSteps(next);
  }, []);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const tasksRef = useRef<TaskItem[]>([]);
  const commitTasks = useCallback((next: TaskItem[]) => {
    tasksRef.current = next;
    setTasks(next);
  }, []);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<SseReadyState>('connecting');
  const [error, setError] = useState('');
  /** 方案选择框（契约 docs/ASK-CHOICE-SPEC.md）：队列与答复动作全在 `useChoiceQueue`，本 hook 只把
   * SSE 事件转发给它、并在新一轮/换会话时通知它清场。 */
  const {
    pendingChoice,
    applyEvent: applyChoiceEvent,
    reset: resetChoices,
    replyChoice,
    dismissChoice,
    skipChoice,
  } = useChoiceQueue(sessionId, setError);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const clientRef = useRef<ReturnType<typeof connectSse> | null>(null);
  /** 历史是否已落定：未落定前禁发，否则 messages 响应后到会把刚发的用户消息整表覆盖掉 */
  const historyLoadedRef = useRef(false);
  /** 本轮发起时刻：done 时与它相减得上屏耗时（usage 是服务端口径，耗时只能前端自己量） */
  const startedAtRef = useRef(0);
  // busy 上报给壳层：ref 锁回调解耦渲染，effect 只在 busy/sessionId 翻转时触发
  const busyCbRef = useRef(onBusyChange);
  busyCbRef.current = onBusyChange;
  useEffect(() => {
    busyCbRef.current?.(busy, sessionId);
  }, [busy, sessionId]);
  /**
   * 流式上屏走打字机平滑（stream-smooth）：token 先进积压，每帧放行 max(2, 积压/48)——
   * 池中 AI（once）整块到达的答案也匀速吐出（任意积压 ~0.8s 内排空），正常流式几乎零附加延迟。
   * done 收口因此分两步：有积压时先存 pendingDone，等排空回调再归并——归并用「已上屏全文」
   * 与库内文本判等，半截归并会把答案截断在屏上且判等必失败。
   */
  type DoneEvent = Extract<SseEvent, { type: 'done' }>;
  const pendingDoneRef = useRef<DoneEvent | null>(null);
  const finalizeRef = useRef<(ev: DoneEvent) => void>(() => undefined);
  const drainRef = useRef<TokenDrain | null>(null);
  if (!drainRef.current) {
    drainRef.current = createTokenDrain(appendStreaming, () => {
      const pending = pendingDoneRef.current;
      if (pending) {
        pendingDoneRef.current = null;
        finalizeRef.current(pending);
      }
    });
  }
  const pushTokens = useCallback((s: string) => drainRef.current?.push(s), []);
  const flushTokens = useCallback(() => drainRef.current?.flushAll(), []);

  /** 丢弃缓冲：新一轮开始前调用；上一轮若还有待收口的 done，先强制归并（新发送不能吃掉上轮收口） */
  const resetTokens = useCallback(() => {
    const pending = pendingDoneRef.current;
    pendingDoneRef.current = null;
    if (pending) {
      finalizeRef.current(pending);
      return;
    }
    drainRef.current?.cancel();
  }, []);

  /**
   * done 收口：过程三件套整块归位到那条回答消息上（过程属于消息，不属于页面），清「当前轮」。
   * 由 done 事件（无积压时）或排空回调（有积压时）调用；也兜底强制收口（resetTokens 里 pending）。
   */
  const finalizeRound = (ev: DoneEvent) => {
    // 残留未上屏的字先落屏：屏上文本与库内文本逐字一致是判等前提
    drainRef.current?.flushAll();
    setBusy(false);
    const t = streamingRef.current; // 已上屏全文（ref，非闭包里的过期 state）
    const roundSteps = stepsRef.current;
    const roundReasoning = reasoningRef.current;
    const roundTasks = tasksRef.current;
    /** 只挂有内容的那几项，别给每条普通回答塞一堆 undefined 键（导出/序列化都会带上） */
    const proc: Pick<StreamMessage, 'steps' | 'reasoning' | 'tasks'> = {
      ...(roundSteps.length > 0 ? { steps: roundSteps } : {}),
      ...(roundReasoning ? { reasoning: roundReasoning } : {}),
      ...(roundTasks.length > 0 ? { tasks: roundTasks } : {}),
    };
    const hasProc = Object.keys(proc).length > 0;
    if (ev.usage) setUsage(ev.usage);
    if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    // 纯工具轮 / 被停止的半轮：没有正文但有过程，也要留一条消息，否则过程就丢了
    if (t || hasProc) {
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        // 屏上文本与库内文本逐字一致（服务端保证）：/messages 晚于本轮落库返回时尾条已是这段字，
        // 此时只把过程补进去，不再插一条重复正文
        if (t && last?.role === 'assistant' && last.content === t) {
          return hasProc ? [...ms.slice(0, -1), { ...last, ...proc }] : ms;
        }
        return [...ms, { role: 'assistant', content: t, ts: new Date().toISOString(), ...proc }];
      });
    }
    // 已归位到消息内：清空「当前轮」（ref 与镜像一起清），否则底部与消息里会重复显示一整份过程
    commitStreaming('');
    commitSteps([]);
    commitTasks([]);
    clearReasoning();
    onRoundDone?.();
  };
  finalizeRef.current = finalizeRound;

  // 载入历史
  useEffect(() => {
    if (!sessionId) {
      historyLoadedRef.current = true;
      setMessages([]);
      return;
    }
    historyLoadedRef.current = false;
    let alive = true;
    api.sessions
      .messages(sessionId)
      .then((rows) => {
        if (!alive) return;
        // 工具轮（assistant.tool_calls + tool 结果）不当作独立消息，配对成 steps 挂回那条回答
        setMessages(foldToolRounds(rows));
      })
      .catch(() => setMessages([]))
      .finally(() => {
        historyLoadedRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // SSE 订阅（会话切换即重建）
  useEffect(() => {
    if (!sessionId) return;
    setError('');
    commitStreaming('');
    // ★ 切会话必须清 busy：它的语义是「**这个**会话在生成」，换了 sessionId 后旧值已不属于新会话。
    //   不清则：① 侧栏徽标漂到刚点开的那项（老板 2026-09-14 实测报的 bug，根因详见 bug-ledger）；
    //   ② 新会话凭空长出「思考中」气泡；③ blocked = busy ⇒ 新会话输入框被禁用到下次切页。
    //   切走后原会话的徽标改由服务端 /api/chat/active 兜（生成本就没中止）。
    setBusy(false);
    // 切会话即换轮：上一轮的思考/步骤/任务/耗时都不能漂到新会话的页面上。
    // reasoning 此前漏清，而渲染层是「非空即渲染」——切到别的会话会看到上一轮的思考面板（串轮）。
    // v11 起「本轮过程」以 ref 为真相源：清空必须走 clearReasoning/commit* 把 ref 一起清掉，
    // 只 setXxx('')/setXxx([]) 清的是渲染镜像，ref 里仍留着旧值，下一轮 done 会把它当本轮过程归并。
    commitSteps([]);
    commitTasks([]);
    clearReasoning();
    setUsage(null);
    setElapsedMs(0);
    const client = connectSse(`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`, {
      // 断线重连成功后拉 /live 快照对齐（契约「断线恢复」的客户端半边，v13 接通）：
      // 重连回放与快照的重叠帧由 sse-client 的 seq 去重拦下
      reconcileUrl: `/api/sessions/${encodeURIComponent(sessionId)}/live`,
    });
    clientRef.current = client;
    const offState = client.onStateChange(setReady);
    const offEvent = client.onEvent((ev: SseEvent) => {
      // 方案选择框的三种帧（asked/replied/cancelled）由 useChoiceQueue 自行消化；
      // 消化掉就 return，其余事件照旧往下分发
      if (applyChoiceEvent(ev)) return;
      if (ev.type === 'token') {
        pushTokens(ev.content);
        setBusy(true);
      } else if (ev.type === 'reasoning') {
        pushReasoning(ev.content);
      } else if (ev.type === 'step') {
        setBusy(true);
        if (ev.status === 'running') {
          commitSteps([...stepsRef.current, { tool: ev.tool, status: ev.status, detail: ev.detail }]);
        } else {
          const next = [...stepsRef.current];
          const settled: ToolStep = {
            tool: ev.tool,
            status: ev.status,
            detail: ev.detail,
            args: ev.args,
            result: ev.result,
          };
          let hit = -1;
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]?.tool === ev.tool && next[i]?.status === 'running') {
              hit = i;
              break;
            }
          }
          // 配不上 running（重连补发的终态、或 running 帧丢失）就新开一条：过程宁可多一条也不丢
          if (hit >= 0) next[hit] = settled;
          else next.push(settled);
          commitSteps(next);
        }
      } else if (ev.type === 'tasks') {
        // 任务清单是全量覆盖语义：面板整表替换，模型每次 update_tasks 都发完整列表
        setBusy(true);
        commitTasks(ev.items);
      } else if (ev.type === 'done') {
        // 有积压（含池中一次性整块答案）时延迟收口：等打字机吐完再归并，否则半截文本判等必失败
        if (drainRef.current?.hasBacklog()) {
          pendingDoneRef.current = ev;
          return;
        }
        finalizeRound(ev);
      } else if (ev.type === 'block') {
        // 内容块流（演进③）：quiz/scenario 块以可交互卡片进消息流（分派在 chat-blocks.ts）
        applyChatBlock(setMessages, ev.blockId, ev.payload);
      } else if (ev.type === 'chat-error') {
        // 出错也要把已流出的字落屏：服务端会把这半截落库（flow.ts catch 分支），屏上不能比库里少
        flushTokens();
        setBusy(false);
        // 本轮步骤标红后仍留在「当前轮」区显示。错误轮不做归并（不吸进消息流）：
        // 半截正文会落库、过程则随重试整轮重来，避免把一次失败执行固化进历史。
        commitSteps(
          stepsRef.current.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: '已中断' } : s)),
        );
        setError(ev.message);
      }
    });
    return () => {
      // 切会话/卸载：丢弃积压与待收口帧——不 finalize（历史消息接口随后重载，库内文本是权威）
      pendingDoneRef.current = null;
      drainRef.current?.cancel();
      offState();
      offEvent();
      client.close();
      clientRef.current = null;
    };
  }, [
    sessionId,
    flushTokens,
    pushTokens,
    commitSteps,
    commitTasks,
    clearReasoning,
    pushReasoning,
    commitStreaming,
    applyChoiceEvent,
  ]);

  /**
   * 新一轮公共前置：清上一轮残留（token 缓冲 / 流式文本 / 过程三件套 / 用量耗时）并计时。
   * 过程三件套一律走 ref 感知的 setter（只 setState 清不掉 ref，会串到新一轮的 done 归并里）；
   * 终止帧丢失时不清缓冲，新 token 会拼到旧半句后面。
   */
  const beginRound = useCallback(() => {
    resetTokens();
    commitStreaming('');
    clearReasoning();
    commitSteps([]);
    commitTasks([]);
    // 方案选择框：上一轮遗留的卡片（含已选/已作废的确认态）退场——它属于上一轮，不该漂过来
    resetChoices();
    setUsage(null);
    setElapsedMs(0);
    startedAtRef.current = Date.now();
  }, [resetTokens, clearReasoning, commitSteps, commitTasks, commitStreaming, resetChoices]);

  // 发送 / 重跑 / 停止这组动作在 useSendActions（2026-09-14 拆出：本文件触 400 行红线）。
  // 它们只发请求与撤屏，不认识流式事件；本文件专心管 SSE 呈现。
  const { send, stop, regenerate, resend } = useSendActions({
    sessionId,
    ready,
    busy,
    beginRound,
    setError,
    setBusy,
    setMessages,
    historyLoadedRef,
    online,
  });

  return {
    messages,
    streamingText,
    reasoning,
    steps,
    tasks,
    busy,
    ready,
    error,
    usage,
    elapsedMs,
    send,
    stop,
    regenerate,
    resend,
    pendingChoice,
    replyChoice,
    dismissChoice,
    skipChoice,
  };
}
