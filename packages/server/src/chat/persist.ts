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
import { estimateTokens } from './context.js';
import { dropRow, indexRow } from '../search/fts-index.js';
import type { ChatMessage, ToolCall } from '../llm/types.js';
import type { TaskItem } from './task-list.js';

/**
 * 工具轮 + 最终回答原子落库（v1 语义）：中途失败/中止时整体不落，历史里不会
 * 出现以孤立 tool 消息结尾的轮次（OpenAI 要求 tool 消息前必有对应 assistant tool_calls）。
 * v11 起同时落「思考」与「任务清单」——过程归属于这条回答，重开会话由 history-fold 回放。
 * ★ P1（迁移 v32）追加两份耗时，全部是**服务端实测值**（口径 TOOL-ECOSYSTEM-SPEC §4.7）：
 *   `durations` 与 `results` 同序落进各 tool 行的 `duration_ms`；`thinkingMs` 落进回答行的
 *   `thinking_ms`。两者缺省即 NULL——「没测到」与「0ms」在库里必须可分辨。
 */
export function persistRounds(
  sessionId: string,
  rounds: Array<{ calls: ToolCall[]; results: ChatMessage[]; durations?: Array<number | undefined> }>,
  finalContent: string,
  tokens: number,
  proc: { reasoning: string; tasks: TaskItem[]; thinkingMs?: number },
): string {
  const db = getDb();
  const assistantId = randomUUID();
  const apply = db.transaction(() => {
    for (const r of rounds) {
      db.prepare(`INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES (?, ?, 'assistant', '', ?)`)
        .run(randomUUID(), sessionId, JSON.stringify(r.calls));
      r.results.forEach((t, i) => {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, tool_call_id, duration_ms) VALUES (?, ?, 'tool', ?, ?, ?)`,
        ).run(randomUUID(), sessionId, t.content, t.toolCallId ?? null, r.durations?.[i] ?? null);
      });
    }
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tokens, reasoning, tasks, thinking_ms) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    ).run(
      assistantId,
      sessionId,
      finalContent,
      tokens,
      proc.reasoning || null,
      proc.tasks.length > 0 ? JSON.stringify(proc.tasks) : null,
      proc.thinkingMs ?? null,
    );
  });
  apply();
  // 搜索索引（契约 docs/FTS-SPEC.md §3.3）：**在源表事务提交后**同步最终回答行。
  // 只索引这一条：上面的空占位（content=''）与 tool 行（role='tool'）都被
  // `search/fts-index.ts#readSource` 的索引范围排除在外，调了也是空转。
  indexRow('message', assistantId);
  return assistantId;
}

/**
 * 用户消息落库（含搜索索引同步）。
 *
 * ★ 为什么要有这个封装（2026-09-20 FTS 批新增）：`flow.ts` 落在 **399/400 行**的
 *   server 行数红线上，而索引同步要在 INSERT 之后拿到 id——直接在调用点写就得再占 3 行。
 *   把「INSERT + 索引」封成一步，调用点从 3 行降到 1 行（净省行数），
 *   而且**结构上消除了"加了 INSERT 忘了接索引"这类漏写点**（FTS-SPEC §3.3 的头号风险）。
 */
export function insertUserMessage(sessionId: string, content: string, images: unknown[]): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO messages (id, session_id, role, content, tokens, images) VALUES (?, ?, 'user', ?, ?, ?)`)
    .run(id, sessionId, content, estimateTokens(content), JSON.stringify(images));
  indexRow('message', id);
  return id;
}

/**
 * 回答消息落库（含搜索索引同步）。中断/失败的半截回答也走这里（`flow.ts` 的中断收口），
 * 因为「已上屏的字」正是用户回头最想搜到的东西。
 *
 * `thinkingMs` 缺省即 NULL——「没测到」与「0ms」在库里必须可分辨（v32 的口径，本封装沿用）。
 */
export function insertAssistantMessage(opts: {
  sessionId: string;
  content: string;
  tokens: number;
  reasoning?: string | null;
  tasks?: TaskItem[];
  thinkingMs?: number | null;
}): string {
  const id = randomUUID();
  const tasks = opts.tasks ?? [];
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, tokens, reasoning, tasks, thinking_ms) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.sessionId,
      opts.content,
      opts.tokens,
      opts.reasoning ?? null,
      tasks.length > 0 ? JSON.stringify(tasks) : null,
      opts.thinkingMs ?? null,
    );
  indexRow('message', id);
  return id;
}

/**
 * 删掉某条消息之后的全部行（重新生成 / 编辑重发的公共动作），**连带清索引**。
 *
 * ★ 为什么先查 id 再删：`DELETE` 之后那些行就没了，索引行却还留着（索引是派生表，
 *   不会随源行级联消失）——不先捞出来，索引里就会留下永久搜不到的孤儿，
 *   直到下一次全量重建。返回删除行数供调用方对账。
 */
export function dropMessagesAfter(sessionId: string, rowid: number): number {
  const db = getDb();
  const doomed = db
    .prepare('SELECT id FROM messages WHERE session_id = ? AND rowid > ?')
    .all(sessionId, rowid) as Array<{ id: string }>;
  const res = db.prepare('DELETE FROM messages WHERE session_id = ? AND rowid > ?').run(sessionId, rowid);
  for (const d of doomed) dropRow('message', d.id);
  return res.changes;
}

/** 改写某条消息正文（编辑重发），连带刷新索引——正文变了，索引里的 tokens 必须跟着变。 */
export function updateMessageContent(rowid: number, content: string, tokens: number): void {
  const db = getDb();
  const row = db.prepare('SELECT id FROM messages WHERE rowid = ?').get(rowid) as { id: string } | undefined;
  db.prepare('UPDATE messages SET content = ?, tokens = ? WHERE rowid = ?').run(content, tokens, rowid);
  if (row) indexRow('message', row.id);
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
