/**
 * chat/resend —— 「编辑重发」的数据侧两步：把最后一条提问改成新文案、删掉它之后的全部产物。
 * 重跑本身不在这里：仍走 `flow.handleMessage`（skipUserPersist，提问已在库里只改内容）。
 *
 * 为什么只支持最后一条提问：编辑更早的提问 = 改写历史分叉，与「重新生成只对最后一条回答开放」
 * 是同一条产品决策（ChatView.tsx 注释），本版不做。
 * 为什么按 rowid 划界：与 regenerate.ts 同一理由——created_at 只到秒，同秒内的提问与回答
 * 分不出先后，按它删会误删提问或漏删回答。
 */
import { getDb } from '../storage/db.js';
import { estimateTokens } from './context.js';
import { dropMessagesAfter, updateMessageContent } from './persist.js';

export interface ResendPlan {
  ok: boolean;
  error?: string;
  /** 修正后的提问原文（交给 handleMessage 重跑） */
  text?: string;
}

export function planResend(sessionId: string, text: string): ResendPlan {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '编辑后的提问不能为空' };
  const db = getDb();
  const row = db
    .prepare(`SELECT rowid AS rid FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`)
    .get(sessionId) as { rid: number } | undefined;
  if (!row) return { ok: false, error: '这个会话还没有可以编辑的提问' };
  // 同 regenerate：删旧产物与改写提问都要连带刷索引（正文变了，索引里的 tokens 必须跟着变）
  dropMessagesAfter(sessionId, row.rid);
  updateMessageContent(row.rid, trimmed, estimateTokens(trimmed));
  return { ok: true, text: trimmed };
}
