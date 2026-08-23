/**
 * SSE 事件契约（演进②③的承载）。
 *
 * 「先登记再实现」：任何新增事件类型必须先在此登记并同步 docs/SSE-CONTRACT.md，
 * 才允许在 server 广播 / web 消费。按 sessionId 隔离广播 + seq 单调去重。
 */

/** 服务端按会话推送的事件（seq 单调递增，新一轮对话从 1 重新计数） */
export type SseEvent =
  | { type: 'token'; seq: number; sessionId: string; content: string }
  | { type: 'reasoning'; seq: number; sessionId: string; content: string }
  | {
      type: 'block';
      seq: number;
      sessionId: string;
      blockId: string;
      /** 块已更新则替换同 blockId 内容（流式追加语义由 done 标记收口） */
      done: boolean;
      payload: unknown;
    }
  | {
      type: 'step';
      seq: number;
      sessionId: string;
      tool: string;
      status: 'running' | 'done' | 'error';
      detail?: string;
    }
  | { type: 'chat-error'; seq: number; sessionId: string; message: string }
  | { type: 'done'; seq: number; sessionId: string; usage?: TokenUsage }
  | { type: 'ping' };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated';
}
