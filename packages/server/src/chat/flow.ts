/**
 * chat/flow — 单轮对话编排（chat 域唯一入口）。
 * 职责：会话串行锁（同会话消息不交错）/ abort 真断流 / 流式经 sse-bus 广播 /
 * 边流边累积末尾一次落库 / 用量兜底估算落库（v1 全部踩坑语义继承）。
 * 单轨原则（ADR/G3）：仅原生 function-calling，工具注册表见 chat/tools.ts。
 */
import { randomUUID } from 'node:crypto';
import type { ModelRole } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { publish, startNewRound } from './sse-bus.js';
import { publishEvent } from '../events/bus.js';
import { estimateTokens, truncateHistoryToBudget, getContextLimit } from './context.js';
import { toolDefinitions, runTool } from './tools.js';
import type { ChatMessage, ToolCall } from '../llm/types.js';

/** 工具循环上限（v1 语义：模型连续发起工具调用时最多 8 轮，防死循环） */
const MAX_TOOL_TURNS = 8;
/** 单条工具结果回灌上限（v1 语义：多轮工具调用会把上下文撑爆） */
const MAX_TOOL_RESULT_CHARS = 14_000;

const SYSTEM_PROMPT = [
  '你是 studentbuddy，一个本地优先的 AI 学习助手（学习版豆包）。',
  '帮助学习者完成「学→练→析→忆→反馈」闭环：讲解概念耐心分步，给出题时遵循协议，',
  '回答简洁好用、讲人话；不确定就说不确定。用户是单机学习者，回答默认中文。',
  '需要展示数据对比/趋势/占比时，用 ```chart 围栏输出单个 JSON：',
  '{"type":"bar|line|pie","title":"标题","labels":["类目"],"values":[非负数值]}；labels 与 values 一一对应，柱/折线最多31项，饼图2-8项。',
  '做可交互演示（动画/模拟器/小工具）时，用 ```html 围栏输出单个完整可独立运行的 HTML 文档：CSS 与 JS 全部内联、不引 CDN，用户点卡片按钮在新标签页打开。',
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
  const truncated = truncateHistoryToBudget(history, {
    limit: getContextLimit(target.model),
    systemPromptTokens: estimateTokens(SYSTEM_PROMPT),
  });
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...truncated];
  // 工具循环预算：窗口 − 系统提示 − 已载历史 − 预留。每轮工具回灌后核对，
  // 接近上限提前收口——小上下文模型 8 轮 × MAX_TOOL_RESULT_CHARS 会撑爆窗口。
  const toolBudget = Math.max(
    0,
    getContextLimit(target.model) -
      estimateTokens(SYSTEM_PROMPT) -
      truncated.reduce((s, m) => s + estimateTokens((m.content || '') + (m.toolCalls ? JSON.stringify(m.toolCalls) : '')), 0) -
      20_000,
  );
  let toolTokens = 0;
  let budgetExceeded = false;

  let acc = '';
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  /**
   * 追加收尾文本（上限提示 / 中断标记）：补进 acc 的与下发的是同一个 delta，
   * acc 因此恒等于已上屏文本——屏上与库内不会分叉（刷新前后一字不差）。
   */
  const appendFinal = (suffix: string) => {
    const delta = acc ? (acc.endsWith('\n') ? '' : '\n\n') + suffix : suffix;
    acc += delta;
    publish(sessionId, { type: 'token', sessionId, content: delta });
  };

  // 单轨工具循环（G3）：toolCalls → 执行 → tool 回灌 → 再生成；上限 MAX_TOOL_TURNS 轮
  const tools = toolDefinitions();
  const onStep = (tool: string, status: 'running' | 'done' | 'error', detail?: string) => {
    publish(sessionId, { type: 'step', sessionId, tool, status, detail });
  };
  /** 工具轮攒到最终答案确认后一并落库：中途失败/中止不留孤儿 tool 消息（v1 语义） */
  const rounds: Array<{ calls: ToolCall[]; results: ChatMessage[] }> = [];
  const abortIfNeeded = () => {
    if (opts.signal?.aborted) throw new Error('已停止');
  };

  try {
    let pendingToolRound = false;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      abortIfNeeded();
      let turnText = '';
      let turnToolCalls: ToolCall[] | undefined;
      for await (const chunk of target.adapter.chat({
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        messages,
        signal: opts.signal,
        tools,
      })) {
        abortIfNeeded();
        if (chunk.reasoning) {
          // 推理内容仅流式呈现（不落库）
          publish(sessionId, { type: 'reasoning', sessionId, content: chunk.reasoning });
        }
        if (chunk.content) {
          turnText += chunk.content;
          acc += chunk.content;
          publish(sessionId, { type: 'token', sessionId, content: chunk.content });
        }
        if (chunk.usage) {
          // 多轮各自计费：跨轮累加而非覆盖
          usage = {
            promptTokens: (usage?.promptTokens ?? 0) + chunk.usage.promptTokens,
            completionTokens: (usage?.completionTokens ?? 0) + chunk.usage.completionTokens,
          };
        }
        if (chunk.toolCalls && chunk.toolCalls.length > 0) turnToolCalls = chunk.toolCalls;
        if (chunk.done) break;
      }

      if (!turnToolCalls) {
        pendingToolRound = false;
        break; // 无工具调用 → 本轮即最终回答
      }

      const results: ChatMessage[] = [];
      for (const tc of turnToolCalls) {
        const r = await runTool(tc.name, tc.arguments, { onStep });
        abortIfNeeded();
        results.push({ role: 'tool', content: r.content.slice(0, MAX_TOOL_RESULT_CHARS), toolCallId: tc.id });
      }
      rounds.push({ calls: turnToolCalls, results });
      messages.push({ role: 'assistant', content: '', toolCalls: turnToolCalls }, ...results);
      toolTokens +=
        estimateTokens(JSON.stringify(turnToolCalls)) + results.reduce((s, r) => s + estimateTokens(r.content), 0);
      if (turnText) {
        acc += '\n\n'; // 过程语与下一轮正文之间留分隔（已流式上屏，不能粘连）
        publish(sessionId, { type: 'token', sessionId, content: '\n\n' }); // 分隔符同样下发：屏上与库内文本逐字一致
      }
      pendingToolRound = true;
      if (toolTokens > toolBudget) {
        budgetExceeded = true;
        break; // 预算耗尽，提前停止工具循环（预留收尾窗口）
      }
    }

    if (pendingToolRound) {
      const capMsg = budgetExceeded
        ? '上下文预算已满，工具调用提前停止；请基于已有内容作答或开始新对话。'
        : `工具调用已达上限（${MAX_TOOL_TURNS} 轮），已停止；请调整提问或直接要求作答。`;
      appendFinal(capMsg);
      publish(sessionId, { type: 'chat-error', sessionId, message: capMsg });
    }

    const assistantId = persistRounds(sessionId, rounds, acc, usage?.completionTokens ?? estimateTokens(acc));
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
    const aborted = opts.signal?.aborted === true;
    const msg = err instanceof Error ? err.message : String(err);
    // 流什么就存什么：已上屏的字不留白（中止与中途失败同样收口）。
    // 工具轮仍不落，绝不留孤儿 tool 消息。
    if (acc) {
      appendFinal(`（${aborted ? '已停止' : '生成中断'}）`);
      db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
        .run(randomUUID(), sessionId, acc, estimateTokens(acc));
    }
    publish(sessionId, { type: 'chat-error', sessionId, message: aborted ? '已停止' : `生成失败：${msg}` });
    // 失败也要收口：缓冲里留下终止帧，切回会话时不会重放这半截死流
    publish(sessionId, { type: 'done', sessionId });
    return { ok: false, error: msg };
  }
}

/**
 * 工具轮 + 最终回答原子落库（v1 语义）：中途失败/中止时整体不落，历史里不会
 * 出现以孤立 tool 消息结尾的轮次（OpenAI 要求 tool 消息前必有对应 assistant tool_calls）。
 */
function persistRounds(
  sessionId: string,
  rounds: Array<{ calls: ToolCall[]; results: ChatMessage[] }>,
  finalContent: string,
  tokens: number,
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
    db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
      .run(assistantId, sessionId, finalContent, tokens);
  });
  apply();
  return assistantId;
}

function loadHistory(sessionId: string): ChatMessage[] {
  const rows = getDb()
    // created_at 只到秒，同秒内的工具轮必须靠 rowid 保住 assistant→tool 的先后
    .prepare(`SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;
  return rows.map((r) => ({
    role: r.role as ChatMessage['role'],
    content: r.content,
    toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : undefined,
    toolCallId: r.tool_call_id ?? undefined,
  }));
}
