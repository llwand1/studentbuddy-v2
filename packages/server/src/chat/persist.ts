/**
 * chat/persist — 消息落库与会话历史读取（纯存储，零编排）。
 *
 * 2026-09-14 从 `flow.ts` 原样搬出（**零行为改动**）：flow.ts 当时 399/400 行，
 * 方案选择框要在其中接线（会话 id 透传、超时豁免、abort 联动作废），依 AGENTS
 * 「单文件 server ≤400 行、贴线前先开新文件」的既有规则把这两段纯存储逻辑搬走腾空间
 * （同 `quiz.ts` → `quiz-image.ts` 的那次搬迁）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import type { ChatMessage, ToolCall } from '../llm/types.js';
import type { TaskItem } from './task-list.js';

/**
 * 工具轮 + 最终回答原子落库（v1 语义）：中途失败/中止时整体不落，历史里不会
 * 出现以孤立 tool 消息结尾的轮次（OpenAI 要求 tool 消息前必有对应 assistant tool_calls）。
 * v11 起同时落「思考」与「任务清单」——过程归属于这条回答，重开会话由 history-fold 回放。
 */
export function persistRounds(
  sessionId: string,
  rounds: Array<{ calls: ToolCall[]; results: ChatMessage[] }>,
  finalContent: string,
  tokens: number,
  proc: { reasoning: string; tasks: TaskItem[] },
): string {
  const db = getDb();
  const assistantId = randomUUID();
  const apply = db.transaction(() => {
    for (const r of rounds) {
      db.prepare(`INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES (?, ?, 'assistant', '', ?)`)
        .run(randomUUID(), sessionId, JSON.stringify(r.calls));
      for (const t of r.results) {
        db.prepare(`INSERT INTO messages (id, session_id, role, content, tool_call_id) VALUES (?, ?, 'tool', ?, ?)`)
          .run(randomUUID(), sessionId, t.content, t.toolCallId ?? null);
      }
    }
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tokens, reasoning, tasks) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
    ).run(
      assistantId,
      sessionId,
      finalContent,
      tokens,
      proc.reasoning || null,
      proc.tasks.length > 0 ? JSON.stringify(proc.tasks) : null,
    );
  });
  apply();
  return assistantId;
}

/**
 * 历史消息 + 它在 `messages` 表里的 `rowid`。
 *
 * 为什么把 rowid 带到上层：长期记忆的压缩需要一个**单调、可比较、删除后不复用**的锚点
 * 来记住「摘要覆盖到哪一条了」（契约 `docs/MEMORY-SPEC.md` §3.1）。`created_at` 只到秒，
 * 同秒内的多条消息无法区分先后，做不了锚点。
 *
 * 做成 `ChatMessage` 的**子类型**而非给 `ChatMessage` 加字段：`llm/types.ts` 是
 * **适配器契约**，混进 DB 概念不干净；子类型让既有调用方（`truncateHistoryToBudget`
 * 等收 `ChatMessage[]` 的地方）零改动即可接收。
 */
export interface HistoryMessage extends ChatMessage {
  rowid: number;
}

export function loadHistory(sessionId: string): HistoryMessage[] {
  const rows = getDb()
    // created_at 只到秒，同秒内的工具轮必须靠 rowid 保住 assistant→tool 的先后
    .prepare(
      `SELECT rowid, role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY created_at, rowid`,
    )
    .all(sessionId) as Array<{
    rowid: number;
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
  }>;
  return rows.map((r) => ({
    rowid: r.rowid,
    role: r.role as ChatMessage['role'],
    content: r.content,
    toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : undefined,
    toolCallId: r.tool_call_id ?? undefined,
  }));
}
