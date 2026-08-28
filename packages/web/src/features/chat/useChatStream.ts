/**
 * useChatStream — 对话流订阅与发送编排（拆自 v1 1114 行巨 hook 的关注点之一）。
 * 职责边界：SSE 生命周期 / 流式文本累积 / 错误呈现 / 停止；会话管理在 useSessions，
 * 输入框 UI 在 Composer——单一关注点（ADR-3 的前端落地）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent } from '@sb/shared';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { api } from '../../lib/api';

export interface StreamMessage {
  role: 'user' | 'assistant';
  content: string;
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
  const clientRef = useRef<ReturnType<typeof connectSse> | null>(null);
  /** 历史是否已落定：未落定前禁发，否则 messages 响应后到会把刚发的用户消息整表覆盖掉 */
  const historyLoadedRef = useRef(false);

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
            .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
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
    const client = connectSse(sessionId);
    clientRef.current = client;
    const offState = client.onStateChange(setReady);
    const offEvent = client.onEvent((ev: SseEvent) => {
      if (ev.type === 'token') {
        setStreamingText((t) => t + ev.content);
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
        setBusy(false);
        setSteps([]);
        setStreamingText((t) => {
          // 屏上文本与库内文本逐字一致（服务端保证）：/messages 晚于本轮落库返回时尾条已是这段字，不能再补一遍
          if (t) setMessages((ms) => (ms.at(-1)?.role === 'assistant' && ms.at(-1)?.content === t ? ms : [...ms, { role: 'assistant', content: t }]));
          return '';
        });
        setReasoning('');
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
        setBusy(false);
        setSteps((prev) => prev.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: '已中断' } : s)));
        setError(ev.message);
      }
    });
    return () => {
      offState();
      offEvent();
      client.close();
      clientRef.current = null;
    };
  }, [sessionId]);

  /** 发送：SSE 未就绪时拒绝并提示（修 F1 竞态——绝不静默吞） */
  const send = useCallback(
    async (text: string): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: '无会话' };
      if (ready !== 'open') return { ok: false, error: `连接${ready === 'reconnecting' ? '重连中' : '建立中'}，稍候再发` };
      if (busy) return { ok: false, error: '生成中，请先停止' };
      if (!historyLoadedRef.current) return { ok: false, error: '历史加载中，稍候再发' };
      setError('');
      // 上一轮残留必须归零：终止帧丢失时，新 token 否则会拼到旧半句后面
      setStreamingText('');
      setReasoning('');
      setSteps([]);
      setMessages((ms) => [...ms, { role: 'user', content: text }]);
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

  return { messages, streamingText, reasoning, steps, busy, ready, error, send, stop };
}
