/**
 * chat/flow — 单轮对话编排（chat 域唯一入口）。
 * 职责：会话串行锁（同会话消息不交错）/ abort 真断流 / 流式经 sse-bus 广播 /
 * 边流边累积末尾一次落库 / 用量兜底估算落库（v1 全部踩坑语义继承）。
 * 单轨原则（ADR/G3）：仅原生 function-calling；M1 先纯文本流，工具注册表接入点已留。
 */
import { randomUUID } from 'node:crypto';
import type { ModelRole } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { publish, startNewRound } from './sse-bus.js';
import { publishEvent } from '../events/bus.js';
import { estimateTokens, truncateHistoryToBudget, getContextLimit } from './context.js';
import type { ChatMessage } from '../llm/types.js';

const SYSTEM_PROMPT = [
  '你是 studentbuddy，一个本地优先的 AI 学习助手（学习版豆包）。',
  '帮助学习者完成「学→练→析→忆→反馈」闭环：讲解概念耐心分步，给出题时遵循协议，',
  '回答简洁好用、讲人话；不确定就说不确定。用户是单机学习者，回答默认中文。',
].join('\n');

/** 同会话串行锁：并发消息排队执行，绝不交错（v1 修复语义） */
const locks = new Map<string, Promise<unknown>>();

export interface ChatOptions {
  sessionId: string;
  text: string;
  role?: ModelRole;
  signal?: AbortSignal;
}

export interface ChatResult {
  ok: boolean;
  error?: string;
  assistantMessageId?: string;
}

export function handleMessage(opts: ChatOptions): Promise<ChatResult> {
  const prev = locks.get(opts.sessionId) ?? Promise.resolve();
  const next = prev.then(() => runTurn(opts), () => runTurn(opts));
  locks.set(opts.sessionId, next);
  const cleanup = () => {
    if (locks.get(opts.sessionId) === next) locks.delete(opts.sessionId);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function runTurn(opts: ChatOptions): Promise<ChatResult> {
  const { sessionId } = opts;
  const db = getDb();

  // 用户消息落库（新会话以首句生成标题）
  db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'user', ?, ?)`)
    .run(randomUUID(), sessionId, opts.text, estimateTokens(opts.text));
  const sessionTitle = (
    db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string } | undefined
  )?.title;
  if (sessionTitle === '新对话') {
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(opts.text.slice(0, 30) || '新对话', sessionId);
  }
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

  const target = routeRole(opts.role ?? 'explain');
  if (!target || !target.model) {
    const msg = !target
      ? '没有可用的服务商：请到设置页添加 provider（baseUrl + apiKey）'
      : `角色 ${opts.role ?? 'explain'} 未配置模型：请到设置页完成角色模型绑定`;
    publish(sessionId, { type: 'chat-error', sessionId, message: msg });
    return { ok: false, error: msg };
  }

  startNewRound(sessionId);

  // 组装上下文（截断含工具轮对齐）
  const history = loadHistory(sessionId);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...truncateHistoryToBudget(history, {
      limit: getContextLimit(target.model),
      systemPromptTokens: estimateTokens(SYSTEM_PROMPT),
    }),
  ];

  let acc = '';
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages,
      signal: opts.signal,
    })) {
      if (chunk.reasoning) {
        // 推理内容仅流式呈现（M1 不落库）
        publish(sessionId, { type: 'reasoning', sessionId, content: chunk.reasoning });
      }
      if (chunk.content) {
        acc += chunk.content;
        publish(sessionId, { type: 'token', sessionId, content: chunk.content });
      }
      if (chunk.usage) usage = chunk.usage;
      // M1：纯文本流（单轨工具循环接入点——chunk.toolCalls 在 M2 工具注册表就绪后启用）
      if (chunk.done) break;
    }

    const assistantId = randomUUID();
    db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
      .run(assistantId, sessionId, acc, usage?.completionTokens ?? estimateTokens(acc));
    db.prepare(`INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, source) VALUES (?, ?, ?, ?, ?)`)
      .run(
        sessionId,
        target.model,
        usage?.promptTokens ?? estimateTokens(messages.map((m) => m.content).join('\n')),
        usage?.completionTokens ?? estimateTokens(acc),
        usage ? 'provider' : 'estimated',
      );
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

    publishEvent({ type: 'chat_done', sessionId });
    publish(sessionId, {
      type: 'done',
      sessionId,
      usage: {
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        source: usage ? 'provider' : 'estimated',
      },
    });
    return { ok: true, assistantMessageId: assistantId };
  } catch (err) {
    // 用户中止：静默收尾（已生成部分保留落库），其余错误明确上报（ADR-5 失败可见）
    const aborted = opts.signal?.aborted === true;
    if (aborted && acc) {
      db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
        .run(randomUUID(), sessionId, acc, estimateTokens(acc));
      publish(sessionId, { type: 'done', sessionId });
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    publish(sessionId, { type: 'chat-error', sessionId, message: aborted ? '已停止' : `生成失败：${msg}` });
    return { ok: false, error: msg };
  }
}

function loadHistory(sessionId: string): ChatMessage[] {
  const rows = getDb()
    .prepare(`SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;
  return rows.map((r) => ({
    role: r.role as ChatMessage['role'],
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    toolCallId: r.tool_call_id ?? undefined,
  }));
}
