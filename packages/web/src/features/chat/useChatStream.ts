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
}

export function useChatStream(sessionId: string | null, onRoundDone?: () => void) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<SseReadyState>('connecting');
  const [error, setError] = useState('');
  const clientRef = useRef<ReturnType<typeof connectSse> | null>(null);

  // 载入历史
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
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
      .catch(() => setMessages([]));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // SSE 订阅（会话切换即重建）
  useEffect(() => {
    if (!sessionId) return;
    setError('');
    setStreamingText('');
    const client = connectSse(sessionId);
    clientRef.current = client;
    const offState = client.onStateChange(setReady);
    const offEvent = client.onEvent((ev: SseEvent) => {
      if (ev.type === 'token') {
        setStreamingText((t) => t + ev.content);
        setBusy(true);
      } else if (ev.type === 'reasoning') {
        setReasoning((r) => r + ev.content);
      } else if (ev.type === 'done') {
        setBusy(false);
        setStreamingText((t) => {
          if (t) setMessages((ms) => [...ms, { role: 'assistant', content: t }]);
          return '';
        });
        setReasoning('');
        onRoundDone?.();
      } else if (ev.type === 'chat-error') {
        setBusy(false);
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
      setError('');
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

  return { messages, streamingText, reasoning, busy, ready, error, send, stop };
}
