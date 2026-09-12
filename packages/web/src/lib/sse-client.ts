/**
 * sse-client — SSE 客户端（v1 两大挂账的一次性修复）：
 * ① 断线指数退避重连（手动重建连接携带最新 since，EventSource 原生重连带不了参数）；
 * ② 发送就绪门控（SSE 未就绪时 composer 禁发并显示状态，修「新对话竞态静默丢消息」F1）。
 * 事件契约：@sb/shared/sse-events（seq 单调去重）。
 */
import type { SseEvent } from '@sb/shared';

export type SseReadyState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseClient {
  /** 当前连接状态（订阅回调驱动 UI） */
  readonly state: SseReadyState;
  onStateChange(cb: (s: SseReadyState) => void): () => void;
  onEvent(cb: (ev: SseEvent) => void): () => void;
  close(): void;
}

/**
 * connectSse — 建立一条 SSE 长连接。
 * @param streamUrl 流地址（可带 query，`since` 由本函数自动续接）。
 *                  聊天传 `/api/chat/stream?sessionId=...`，PK 传 `/api/pk/stream?roomId=...`
 *                  ——同一套重连/就绪门控服务两条频道（PK 侧契约 docs/PK-SPEC.md §2.2）。
 */
export function connectSse(streamUrl: string): SseClient {
  let state: SseReadyState = 'connecting';
  let since = 0;
  let es: EventSource | null = null;
  let retry = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stateCbs = new Set<(s: SseReadyState) => void>();
  const eventCbs = new Set<(ev: SseEvent) => void>();

  const setState = (s: SseReadyState) => {
    state = s;
    stateCbs.forEach((cb) => cb(s));
  };

  const connect = () => {
    if (closed) return;
    es = new EventSource(`${streamUrl}${streamUrl.includes('?') ? '&' : '?'}since=${since}`);
    es.onopen = () => {
      retry = 0;
      setState('open');
    };
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as SseEvent;
        if ('seq' in ev && typeof ev.seq === 'number' && ev.seq > since) since = ev.seq;
        eventCbs.forEach((cb) => cb(ev));
      } catch {
        // 脏行容错
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      setState('reconnecting');
      // 指数退避 1s → 2s → 4s … 封顶 15s（v1 spec 语义）
      const delay = Math.min(1000 * 2 ** retry, 15000);
      retry += 1;
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    get state() {
      return state;
    },
    onStateChange(cb) {
      stateCbs.add(cb);
      cb(state);
      return () => stateCbs.delete(cb);
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      setState('closed');
    },
  };
}
