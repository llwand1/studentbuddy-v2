/**
 * SSE 事件契约（演进②③的承载）。
 *
 * 「先登记再实现」：任何新增事件类型必须先在此登记并同步 docs/SSE-CONTRACT.md，
 * 才允许在 server 广播 / web 消费。按 sessionId 隔离广播 + seq 单调去重。
 */
import type { TaskItem } from './task-list.js';


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
      /** 工具入参原文（JSON 串）：过程卡片点击展开时展示（2026-09-09 登记） */
      args?: string;
      /** 工具结果摘要（截断至 ~400 字）：同上，展开时展示，不回灌模型 */
      result?: string;
    }
  | {
      /**
       * 任务清单（标准 CoT）：模型经 update_tasks 工具维护；前端渲染为打勾清单。
       * items 恒为「当前完整清单」——模型可以只发改动条目（工具的 patch 模式），
       * 但服务端会把合并结果整表下发，前端据此整表替换，不做本地合并。
       */
      type: 'tasks';
      seq: number;
      sessionId: string;
      items: TaskItem[];
    }
  | { type: 'chat-error'; seq: number; sessionId: string; message: string }
  | { type: 'done'; seq: number; sessionId: string; usage?: TokenUsage }
  | { type: 'ping' };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated';
}
