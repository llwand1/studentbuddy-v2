import { Router } from 'express';
import { canAccessSession, ownerIdOf, sessionExists } from '../auth/ownership.js';
import { latestReplyPractice, deliverReplyPractice } from '../learning/reply-practice.js';

export const replyPracticeRouter = Router();
replyPracticeRouter.post('/from-reply', (req, res) => {
  const { sessionId } = req.body as { sessionId?: unknown };
  if (typeof sessionId !== 'string' || !sessionId) { res.status(400).json({ error: 'sessionId 必填' }); return; }
  const ownerId = ownerIdOf(req);
  if (!sessionExists(sessionId) || !canAccessSession(sessionId, ownerId)) {
    res.status(404).json({ error: '会话不存在' }); return;
  }
  const quiz = latestReplyPractice(sessionId, ownerId);
  if (!quiz) { res.json({ available: false }); return; }
  const quizId = deliverReplyPractice(sessionId, ownerId, quiz);
  res.json({ available: true, quizId });
});
