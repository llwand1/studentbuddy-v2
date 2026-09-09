/**
 * useChatStream — 对话流订阅与发送编排（拆自 v1 1114 行巨 hook 的关注点之一）。
 * 职责边界：SSE 生命周期 / 流式文本累积 / 错误呈现 / 停止；会话管理在 useSessions，
 * 输入框 UI 在 Composer——单一关注点（ADR-3 的前端落地）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent, TokenUsage } from '@sb/shared';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { api } from '../../lib/api';

export interface StreamMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 消息时间：历史消息取库内 created_at（SQLite UTC 串），本轮新消息取本地 ISO */
  ts?: string;
  streaming?: boolean;
  quizBlock?: { blockId: string; quiz: { title?: string; questions: import('@sb/shared').QuizQuestion[] }; quizId?: string };
}

export interface ToolStep {
  tool: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export function useChatStream(sessionId: string | null, onRoundDone?: () => void) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [steps, setSteps] = useState<ToolStep[]>([]);
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
    if (chunk) setStreamingText((t) => t + chunk);
  }, []);

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
        setMessages(
          rows
            .filter((r) => r.role === 'user' || r.role === 'assistant')
            .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, ts: r.created_at })),
        );
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
    setStreamingText('');
    setSteps([]);
    // 切会话即换轮：上一轮的 token/耗时不能跟着漂到新会话的页面上
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
        setReasoning((r) => r + ev.content);
      } else if (ev.type === 'step') {
        setBusy(true);
        setSteps((prev) => {
          if (ev.status === 'running') return [...prev, { tool: ev.tool, status: ev.status, detail: ev.detail }];
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]?.tool === ev.tool && next[i]?.status === 'running') {
              next[i] = { tool: ev.tool, status: ev.status, detail: ev.detail };
              return next;
            }
          }
          return [...next, { tool: ev.tool, status: ev.status, detail: ev.detail }];
        });
      } else if (ev.type === 'done') {
        // 合批残留必须先落屏：buffer 里可能压着最后一帧没 flush 的字，丢了就是尾巴少一段
        flushTokens();
        setBusy(false);
        setSteps([]);
        if (ev.usage) setUsage(ev.usage);
        if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
        setStreamingText((t) => {
          // 屏上文本与库内文本逐字一致（服务端保证）：/messages 晚于本轮落库返回时尾条已是这段字，不能再补一遍
          if (t)
            setMessages((ms) =>
              ms.at(-1)?.role === 'assistant' && ms.at(-1)?.content === t
                ? ms
                : [...ms, { role: 'assistant', content: t, ts: new Date().toISOString() }],
            );
          return '';
        });
        // reasoning 刻意不清：学习场景下「它刚才是怎么想的」是答案的一部分，用户要能回看；
        // 清空点放在下一轮 send（本文件的 send 里已清），保证不串轮
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
        setSteps((prev) => prev.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: '已中断' } : s)));
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
  }, [sessionId, flushTokens, pushTokens, resetTokens]);

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
      setStreamingText('');
      setReasoning('');
      setSteps([]);
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
    [sessionId, ready, busy],
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
      setStreamingText('');
      setReasoning('');
      setUsage(null);
      setElapsedMs(0);
      setSteps([]);
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
    [sessionId, ready, busy, resetTokens],
  );

  return { messages, streamingText, reasoning, steps, busy, ready, error, usage, elapsedMs, send, stop, regenerate };
}
