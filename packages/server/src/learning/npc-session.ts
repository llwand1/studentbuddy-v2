/**
 * learning/npc-session — 伙伴对话接进**对话核**：有历史、有记忆、每位各一份
 * （契约 `docs/NPC-PARTNER-SPEC.md` §12）。
 *
 * ★★ 零新表是怎么做到的：**伙伴 id 直接当会话 id**（`sessions.id` 是 TEXT 主键）。
 *   于是三件事各自落进已有的地方：
 *     · 历史对话 → 既有 `messages` 表（`session_id = 'npc:<termId>'`）
 *     · 单独记忆 → 既有 `sessions.summary`（`chat/compact.ts` 的滚动摘要，超窗口先摘要再丢）
 *     · 他守哪条词条 → 既有 `sessions.forked_term` 列
 *   一张表都不用建、一条迁移都不用写 —— 这正是 §0 那条红线要的。
 *
 * ★★ **严格隔离**（本次裁定）：压缩走 `compactIfNeeded(..., isolated=true)`，
 *   **不写**全局 `user_memory`、**不读**全局画像块。
 *   ⇒ A 伙伴永远不知道你跟 B 伙伴说过什么；主助手也读不到伙伴的闲聊。
 *   代价如实记：伙伴对话里的用户偏好不会进画像。这是"每个 NPC 单独的记忆"的直接含义。
 *
 * ★ 为什么不直接复用 `chat/flow.ts`：那条链带着工具调用、SSE、追问、逼问、选择题…
 *   伙伴要的是"一个会记事的邻居"，把整条产品链拖进来既慢又会让他说出与任务清单打架的话
 *   （§4.3 那条"不带全库卡墙"的纪律）。这里只借**存储与记忆**两层，不借编排层。
 */
import { NPC_BIO_MAX, isNpcSessionId, npcSessionIdOf } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { insertAssistantMessage, insertUserMessage, loadHistory, type HistoryMessage } from '../chat/persist.js';
import { buildSummaryBlock, compactIfNeeded, loadSessionSummary } from '../chat/compact.js';
import { estimateTokens } from '../chat/context.js';
import type { ChatMessage } from '../llm/types.js';

/** 送进上下文的最近历史预算（★ 伙伴是短对话，给得比主链小得多——省钱且他本来就不该长篇大论） */
export const NPC_HISTORY_TOKENS = 1200;
/** 历史条数硬上限：预算之外再加一把尺子，防止一堆超短消息把条数堆爆 */
export const NPC_HISTORY_MAX = 24;

/**
 * 确保这位伙伴的会话行在（幂等）。
 *
 * ★ `INSERT OR IGNORE`：创建伙伴、第一次说话、主动搭话三条路都会调它，谁先到都行。
 * ★ `user_id` 必须写：不写的话多用户库里别人能读到这段对话（`ownership.ts` 按 user_id 判）。
 * ★ `title` 用伙伴名，纯粹为了可读性（伙伴会话不进聊天列表，但导数据/排查时看得懂）。
 */
export function ensureNpcSession(npcId: string, ownerId: string | null, name: string, termId: string): string {
  const sessionId = npcSessionIdOf(npcId);
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, title, user_id, forked_term, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(sessionId, `伙伴 ${name}`, ownerId, termId);
  return sessionId;
}

/**
 * 「让他回家」时连会话一起收走。
 *
 * ★★ **真删消息、软删会话**：`messages` 有外键指向 `sessions`，留着孤儿消息既占地方又会在
 *   导出时冒出来；而 `sessions` 走既有的 `deleted_at` 软删口径（与用户删会话同一条路，
 *   不为伙伴另造一套删除语义）。
 * ★ 与 §3「让他回家是真删」一致：名额按名册序号算，会话留着也不会让他复活。
 */
export function dropNpcSession(npcId: string): void {
  const sessionId = npcSessionIdOf(npcId);
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(sessionId);
}

/** 这位伙伴的历史（给面板回显用；`limit` 条最近的，按时间正序） */
export function npcHistory(npcId: string, limit = NPC_HISTORY_MAX): HistoryMessage[] {
  const all = loadHistory(npcSessionIdOf(npcId));
  return all.slice(-limit);
}

/**
 * 组装这一轮要送给模型的消息。
 *
 * 结构：`system`（人设 + 此刻站在哪 + 遇没遇险）→ `[他自己的记忆摘要]` → 最近几轮 → 本轮输入。
 * ★★ 刻意**没有**全局画像块（`injectMemoryBlock`）：那是"用户是谁"的跨会话档案，
 *   放进来就等于所有伙伴共用一份记忆，与本次"严格隔离"的裁定直接冲突。
 */
export function buildNpcMessages(opts: {
  systemPrompt: string;
  sessionId: string;
  text: string;
}): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: opts.systemPrompt }];
  // 他自己的记忆：滚动摘要（旧消息被摘要替代，而不是被丢弃）
  const { summary } = loadSessionSummary(opts.sessionId);
  if (summary) msgs.push({ role: 'system', content: buildSummaryBlock(summary) });
  // 最近几轮：双闸（token 预算 + 条数），从最近往回收
  const history = loadHistory(opts.sessionId);
  const recent: ChatMessage[] = [];
  let budget = NPC_HISTORY_TOKENS;
  for (let i = history.length - 1; i >= 0 && recent.length < NPC_HISTORY_MAX; i -= 1) {
    const h = history[i];
    if (!h) continue;
    // 工具消息不该出现在伙伴会话里（他没有工具链）；真出现了就跳过，不让它污染上下文
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    // ★ 历史里可能有多模态消息（`ContentPart[]`）—— 伙伴会话不该有图，
    //   真混进来就跳过：把它 JSON 化塞进上下文只会浪费 token 且模型读不懂。
    if (typeof h.content !== 'string') continue;
    const cost = estimateTokens(h.content);
    if (cost > budget) break;
    budget -= cost;
    recent.unshift({ role: h.role, content: h.content });
  }
  msgs.push(...recent, { role: 'user', content: opts.text });
  return msgs;
}

/**
 * 落一轮对话（用户说的 + 伙伴答的），并在超窗口时**异步**压缩。
 *
 * ★ 压缩 fire-and-forget、下一轮生效（照 `compact.ts` 头注那条"用户盯着屏幕等回答"的理由）。
 * ★ `isolated = true` 是本文件的立命之本，**改掉这一行就等于取消了"每位伙伴单独记忆"**。
 */
export function recordNpcTurn(opts: {
  sessionId: string;
  ownerId: string | null;
  userText: string;
  reply: string;
  /** 主动搭话时没有"用户说的那句"——只落伙伴那句 */
  assistantOnly?: boolean;
}): void {
  if (!opts.assistantOnly) insertUserMessage(opts.sessionId, opts.userText, []);
  insertAssistantMessage({
    sessionId: opts.sessionId,
    content: opts.reply,
    tokens: estimateTokens(opts.reply),
  });
  getDb().prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(opts.sessionId);
  void compactIfNeeded(opts.sessionId, opts.ownerId, true).catch(() => {
    /* 压缩失败只是这一轮没沉淀，下一轮重试；绝不冒泡（fire-and-forget） */
  });
}

/** 供聊天列表过滤复用（唯一口径，避免两处各写一个 `LIKE 'npc:%'`） */
export { isNpcSessionId };

/** 人设长度上限对外再导一次，UI 与生成侧共用（避免前端自己写死 40） */
export const NPC_BIO_LIMIT = NPC_BIO_MAX;
