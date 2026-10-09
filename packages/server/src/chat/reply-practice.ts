import { isReplyPracticeRequest } from '@sb/shared';
import type { ChatOptions, ChatResult } from './options.js';
import { latestReplyPractice, deliverReplyPractice } from '../learning/reply-practice.js';
import { insertUserMessage } from './persist.js';
import { publish, startNewRound } from './sse-bus.js';

/** Reuse a prepared exercise without starting a new model call or disturbing GrillMe/new-topic requests. */
export function tryReplyPracticeTurn(opts: ChatOptions): ChatResult | null {
  if (opts.grillMe || opts.skipUserPersist || opts.images?.length || opts.signal?.aborted ||
      (opts.role && opts.role !== 'explain') || !isReplyPracticeRequest(opts.text)) return null;
  const quiz = latestReplyPractice(opts.sessionId, opts.ownerId ?? null);
  if (!quiz) return null;
  startNewRound(opts.sessionId);
  insertUserMessage(opts.sessionId, opts.text, []);
  publish(opts.sessionId, { type: 'round-start', sessionId: opts.sessionId, startedAt: Date.now() });
  deliverReplyPractice(opts.sessionId, opts.ownerId ?? null, quiz);
  publish(opts.sessionId, { type: 'done', sessionId: opts.sessionId });
  return { ok: true };
}
