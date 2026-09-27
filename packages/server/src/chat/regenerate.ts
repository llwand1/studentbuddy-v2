/**
 * chat/regenerate —— 「重新生成」的数据侧两步：取最后一条提问、删掉它之后的全部产物。
 * 重跑本身不在这里：仍走 `flow.handleMessage`（串行锁 / 流式 / 落库 / SSE 全复用，不复制第二套）。
 *
 * 为什么用 rowid 而不是 created_at 划界：`created_at` 是 `datetime('now')`、**精度只到秒**，
 * 同一秒内的提问与回答分不出先后，按它删会误删提问或漏删回答。`rowid` 是插入序，单调且唯一。
 */
import { getDb } from '../storage/db.js';
import { dropMessagesAfter } from './persist.js';

export interface RegenPlan {
  ok: boolean;
  error?: string;
  /** 被重新生成的提问原文（交给 handleMessage 重跑） */
  text?: string;
}

/**
 * 删除最后一条 user 消息之后的所有行（旧回答 + 工具轮 + 中途失败的半截），返回该提问原文。
 * 没有提问 / 会话为空时如实报 `ok:false` —— 调用方据此给 400，不静默什么都不做。
 */
export function planRegenerate(sessionId: string): RegenPlan {
  const db = getDb();
  const row = db
    .prepare(`SELECT rowid AS rid, content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`)
    .get(sessionId) as { rid: number; content: string } | undefined;
  if (!row) return { ok: false, error: '这个会话还没有可以重新生成的提问' };
  // 删旧产物（回答 + 工具轮 + 半截）**并连带清搜索索引**——见 persist.ts 的同名函数头注：
  // 索引是派生表，不会随源行级联消失，漏清就会留下永久搜不到的孤儿。
  dropMessagesAfter(sessionId, row.rid);
  return { ok: true, text: row.content };
}
