/**
 * useChatStream — 对话流订阅与发送编排（拆自 v1 1114 行巨 hook 的关注点之一）。
 * 职责边界：SSE 生命周期 / 流式文本累积 / 错误呈现 / 停止；会话管理在 useSessions，
 * 输入框 UI 在 Composer——单一关注点（ADR-3 的前端落地）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent, TokenUsage } from '@sb/shared';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { api } from '../../lib/api';
import { foldToolRounds } from './history-fold';

export interface StreamMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 消息时间：历史消息取库内 created_at（SQLite UTC 串），本轮新消息取本地 ISO */
  ts?: string;
  streaming?: boolean;
  quizBlock?: { blockId: string; quiz: { title?: string; questions: import('@sb/shared').QuizQuestion[] }; quizId?: string };
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

/** 任务清单条目（SSE tasks 事件，标准 CoT 进度面板） */
export interface TaskItem {
  text: string;
  status: 'pending' | 'done';
}

export function useChatStream(
  sessionId: string | null,
  onRoundDone?: () => void,
  /** 生成状态上报（App 侧栏「回复中」提示）：busy 翻转时回调一次 */
  onBusyChange?: (busy: boolean, sessionId: string | null) => void,
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
   * 流式合批：token 先进 buffer，每帧只 flush 一次。
   * 不做合批时每个 token 触发一次 setState → Markdown 全量重解析，长回答是 O(n²) 且越流越卡。
   */
  const bufRef = useRef('');
  const rafRef = useRef<number | null>(null);

  /** 把攒下的字一次性推上屏（每帧至多一次） */
  const flushTokens = useCallback(() => {
    rafRef.current = null;
    const chunk = bufRef.current;
    bufRef.current = '';
    if (chunk) appendStreaming(chunk);
  }, [appendStreaming]);

  /** token 入缓冲：同帧内的多个 token 合成一次 setState */
  const pushTokens = useCallback(
    (s: string) => {
      bufRef.current += s;
      if (rafRef.current !== null) return;
      // 无 rAF 的环境（老浏览器/测试容器）直接同步落，不丢字
      if (typeof requestAnimationFrame !== 'function') {
        flushTokens();
        return;
      }
      rafRef.current = requestAnimationFrame(flushTokens);
    },
    [flushTokens],
  );

  /** 丢弃缓冲并把 pending 帧取消：新一轮/卸载时防旧字拼到新句子后面 */
  const resetTokens = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    bufRef.current = '';
  }, []);

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
    // 切会话即换轮：上一轮的思考/步骤/任务/耗时都不能漂到新会话的页面上。
    // reasoning 此前漏清，而渲染层是「非空即渲染」——切到别的会话会看到上一轮的思考面板（串轮）。
    // v11 起「本轮过程」以 ref 为真相源：清空必须走 clearReasoning/commit* 把 ref 一起清掉，
    // 只 setXxx('')/setXxx([]) 清的是渲染镜像，ref 里仍留着旧值，下一轮 done 会把它当本轮过程归并。
    commitSteps([]);
    commitTasks([]);
    clearReasoning();
    setUsage(null);
    setElapsedMs(0);
    const client = connectSse(sessionId);
    clientRef.current = client;
    const offState = client.onStateChange(setReady);
    const offEvent = client.onEvent((ev: SseEvent) => {
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
        // 合批残留必须先落屏：buffer 里可能压着最后一帧没 flush 的字，丢了就是尾巴少一段
        flushTokens();
        setBusy(false);
        // 「本轮过程」三件套在收口这一刻整块归位到那条回答消息上（过程属于消息，不属于页面）：
        // 屏上位置从「流式气泡上方」变成「回答内部」，内容连续；重开会话时由 history-fold 再重建一次。
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
      } else if (ev.type === 'block') {
        // 内容块流（演进③）：quiz 块以可交互卡片进入消息流
        const p = ev.payload as { kind?: string; blockId?: string; payload?: unknown };
        if (p?.kind === 'quiz' && p.payload) {
          const quiz = p.payload as { title?: string; questions: never[] };
          const quizIdMatch = ev.blockId.match(/quiz-(.+)/);
          setMessages((ms) => [
            ...ms,
            { role: 'assistant', content: '', quizBlock: { blockId: ev.blockId, quiz, quizId: quizIdMatch?.[1] } },
          ]);
        }
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
      resetTokens();
      offState();
      offEvent();
      client.close();
      clientRef.current = null;
    };
  }, [sessionId, flushTokens, pushTokens, resetTokens, commitSteps, commitTasks, clearReasoning, pushReasoning, commitStreaming]);

  /** 发送：SSE 未就绪时拒绝并提示（修 F1 竞态——绝不静默吞） */
  const send = useCallback(
    async (text: string): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: '无会话' };
      if (ready !== 'open') return { ok: false, error: `连接${ready === 'reconnecting' ? '重连中' : '建立中'}，稍候再发` };
      if (busy) return { ok: false, error: '生成中，请先停止' };
      if (!historyLoadedRef.current) return { ok: false, error: '历史加载中，稍候再发' };
      setError('');
      // 上一轮残留必须归零：终止帧丢失时，新 token 否则会拼到旧半句后面
      resetTokens();
      commitStreaming('');
      // 过程三件套一律走 ref 感知的 setter（只 setState 清不掉 ref，会串到新一轮的 done 归并里）
      clearReasoning();
      commitSteps([]);
      commitTasks([]);
      setUsage(null);
      setElapsedMs(0);
      startedAtRef.current = Date.now();
      setMessages((ms) => [...ms, { role: 'user', content: text, ts: new Date().toISOString() }]);
      try {
        await api.chat.send(sessionId, text);
        setBusy(true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    [sessionId, ready, busy, resetTokens, clearReasoning, commitSteps, commitTasks, commitStreaming],
  );

  const stop = useCallback(async () => {
    if (sessionId) await api.chat.abort(sessionId).catch(() => undefined);
  }, [sessionId]);

  /**
   * 重新生成：服务端已把最后一条提问之后的产物删掉（含工具轮与中止半截），
   * 屏上按**同一口径**同步撤——只保留最后一条提问及其之前，否则新回答会接在旧回答后面。
   */
  const regenerate = useCallback(
    async (): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: '无会话' };
      if (ready !== 'open')
        return { ok: false, error: `连接${ready === 'reconnecting' ? '重连中' : '建立中'}，稍候再试` };
      if (busy) return { ok: false, error: '生成中，请先停止' };
      setError('');
      resetTokens();
      commitStreaming('');
      clearReasoning();
      setUsage(null);
      setElapsedMs(0);
      commitSteps([]);
      commitTasks([]);
      startedAtRef.current = Date.now();
      setMessages((ms) => {
        const lastUser = ms.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
        return lastUser >= 0 ? ms.slice(0, lastUser + 1) : ms;
      });
      try {
        await api.chat.regenerate(sessionId);
        setBusy(true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    [sessionId, ready, busy, resetTokens, clearReasoning, commitSteps, commitTasks, commitStreaming],
  );

  return { messages, streamingText, reasoning, steps, tasks, busy, ready, error, usage, elapsedMs, send, stop, regenerate };
}
