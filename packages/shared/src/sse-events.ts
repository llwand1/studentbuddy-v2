/**
 * SSE 事件契约（演进②③的承载）。
 *
 * 「先登记再实现」：任何新增事件类型必须先在此登记并同步 docs/SSE-CONTRACT.md，
 * 才允许在 server 广播 / web 消费。按 sessionId 隔离广播 + seq 单调去重。
 */
import type { TaskItem } from './task-list.js';
import type { PkQuestion, PkRoomState } from './pk.js';
import type { AskChoiceRecord, AskChoiceReply } from './choice.js';


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
  // ── PK 频道（AI 出题微信双人对战，契约 docs/PK-SPEC.md §2.2）─────────────
  // ★ 频道键为 `pk:<roomId>`（`shared/pk.ts` 的 `pkChannel()`）——与上面的 `sessionId` 空间
  //   严格隔离；两者共用 sse-bus 实现，靠频道键前缀防串台（v1 教训）。故本组事件用 `roomId`
  //   字段而非 `sessionId`：字段名不同，才不会有人把房间号当会话 ID 传进聊天通道。
  // ★ 载荷里**没有 answer**：正确答案永不下发（含 SSE），判分权只在服务端（契约 §1）。
  // P0-1 只发 `pk-state`；后三个按契约先登记、待 P0-2（出题与判分）实现时启用
  // ——「先登记再实现」是本仓纪律，契约已定的类型不必等实现才登记。
  | { type: 'pk-state'; seq: number; roomId: string; state: PkRoomState }
  | { type: 'pk-question'; seq: number; roomId: string; question: PkQuestion }
  | {
      type: 'pk-verdict';
      seq: number;
      roomId: string;
      questionId: string;
      /** 被判分的是谁（答题方）——PVE 后 AI 也走同一条判分路径，前端要分清是谁的分数在动 */
      byUserId: string;
      correct: boolean;
      /** 本题分数变化（答错 / 超时各 −1） */
      delta: number;
      /** 判分后的总分 */
      score: number;
    }
  | { type: 'pk-end'; seq: number; roomId: string; winner?: string; state: PkRoomState }
  // ── 方案选择框（AI 主动提问 → 用户点选 → 同轮继续，契约 docs/ASK-CHOICE-SPEC.md）──
  // ★ 归 `sessionId` 空间（与聊天事件同频道，不是独立频道）：选择的答案直接续进这一轮对话，
  //   因此不经 `pk:` 那套前缀隔离。三个事件覆盖一个提问的完整生命周期：
  //   asked（弹卡）→ replied（切已选态）/ cancelled（切作废态，逃生口触发）。
  | { type: 'choice-asked'; seq: number; sessionId: string; request: AskChoiceRecord }
  | { type: 'choice-replied'; seq: number; sessionId: string; requestId: string; reply: AskChoiceReply }
  | { type: 'choice-cancelled'; seq: number; sessionId: string; requestId: string; reason: string }
  | { type: 'ping' };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated';
}
