import { createHash, randomUUID } from 'node:crypto';
import { extractReplyPractice, isReplyPracticeRequest, type QuizPayload, type ReplyPracticeRef } from '@sb/shared';
import { canAccessSession, sessionExists } from '../auth/ownership.js';
import { getDb } from '../storage/db.js';
import { announceQuizToSession } from './quiz-announce.js';
import { publishEvent } from '../events/bus.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface Cached { message_id: string; source_hash: string; title: string; quiz_json: string; content: string }

/** Called only after successful chat persistence. A derived-cache error cannot turn a delivered answer into a failed chat. */
export function cacheReplyPractice(messageId: string, prompt: string, answer: string): ReplyPracticeRef | undefined {
  try {
    const quiz = extractReplyPractice(prompt, answer);
    if (!quiz) return undefined;
    const title = quiz.title!;
    getDb().prepare('INSERT OR REPLACE INTO reply_practice(message_id, source_hash, title, quiz_json) VALUES(?,?,?,?)')
      .run(messageId, hash(answer), title, JSON.stringify(quiz));
    return { messageId, title };
  } catch { return undefined; }
}

/** Batch metadata only, after the route has checked session ownership. Never serialize the hidden exercise with the hint. */
export function sessionPracticeRefs(sessionId: string): Record<string, ReplyPracticeRef> {
  const rows = getDb().prepare(`SELECT p.message_id, p.title, p.source_hash, m.content
    FROM reply_practice p JOIN messages m ON m.id=p.message_id WHERE m.session_id=?`).all(sessionId) as Cached[];
  return Object.fromEntries(rows.filter((r) => hash(r.content) === r.source_hash)
    .map((r) => [r.message_id, { messageId: r.message_id, title: r.title }]));
}

/** Only the latest substantive answer qualifies. Never fall back to an older exercise after a new/failed/unstructured reply. */
export function latestReplyPractice(sessionId: string, ownerId: string | null, explicitToolRequest = false): QuizPayload | null {
  if (!sessionExists(sessionId) || !canAccessSession(sessionId, ownerId)) return null;
  const latest = getDb().prepare(`SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant')
    AND content<>'' AND tool_calls IS NULL AND content NOT LIKE '[QUIZ]%' AND content NOT LIKE '[SCENARIO]%'
    ORDER BY rowid DESC LIMIT 1`).get(sessionId) as { role: string; content: string } | undefined;
  // A new question with no completed answer (failed/in progress) also invalidates the default prior-reply shortcut.
  if (!latest || (latest.role === 'user' && !explicitToolRequest && !isReplyPracticeRequest(latest.content))) return null;
  const row = getDb().prepare(`SELECT p.*, m.content FROM messages m LEFT JOIN reply_practice p ON p.message_id=m.id
    WHERE m.session_id=? AND m.role='assistant' AND m.content<>'' AND m.tool_calls IS NULL
    AND m.content NOT LIKE '[QUIZ]%' AND m.content NOT LIKE '[SCENARIO]%'
    ORDER BY m.rowid DESC LIMIT 1`).get(sessionId) as Cached | undefined;
  if (!row?.quiz_json || hash(row.content) !== row.source_hash) return null;
  try { return JSON.parse(row.quiz_json) as QuizPayload; } catch { return null; }
}

export function deliverReplyPractice(sessionId: string, ownerId: string | null, quiz: QuizPayload): string {
  const quizId = randomUUID();
  announceQuizToSession(sessionId, quiz, quizId);
  publishEvent({ type: 'quiz_generated', quizId, ownerId });
  getDb().prepare(`UPDATE sessions SET updated_at=datetime('now') WHERE id=?`).run(sessionId);
  return quizId;
}
