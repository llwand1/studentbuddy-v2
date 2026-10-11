import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { canAccessSession, ownerIdOf, sessionExists } from '../auth/ownership.js';
import { adaptQuestion, parseFeedbackRequest, predictFeedback } from '../learning/quiz-feedback.js';
import { announceQuizToSession } from '../learning/quiz-announce.js';

export const quizFeedbackRouter = Router();
const active = new Set<string>();
function feedbackRoute(kind: 'choices' | 'adapt'): RequestHandler {
  return async (req, res) => {
    const input = parseFeedbackRequest(req.body, kind === 'adapt');
    if (!input) { res.status(400).json({ error: '题目或评价不完整、过长，请检查后重试。' }); return; }
    const ownerId = ownerIdOf(req);
    if (input.sessionId && (!sessionExists(input.sessionId) || !canAccessSession(input.sessionId, ownerId))) {
      res.status(404).json({ error: '会话不存在。' }); return;
    }
    const key = ownerId ?? 'local';
    if (active.has(key)) { res.status(409).json({ error: '已有题目评价正在处理，请稍后重试。' }); return; }
    active.add(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), kind === 'choices' ? 40_000 : 150_000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    try {
      if (kind === 'choices') {
        const options = await predictFeedback(input, ownerId, controller.signal);
        if (!controller.signal.aborted) res.json({ options });
      } else {
        const quiz = await adaptQuestion(input, ownerId, controller.signal);
        controller.signal.throwIfAborted();
        // 生成期间会话可能已被删除或归属变化，再核对后才发布题卡。
        if (input.sessionId && (!sessionExists(input.sessionId) || !canAccessSession(input.sessionId, ownerId))) {
          res.status(404).json({ error: '会话已不可用，新题未写入。' }); return;
        }
        const quizId = randomUUID();
        if (input.sessionId) announceQuizToSession(input.sessionId, quiz, quizId);
        res.json({ quizId, quiz, announced: !!input.sessionId });
      }
    } catch (error) {
      if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 502).json({
        error: controller.signal.aborted ? '生成超时，请重试。' : error instanceof Error ? error.message : '题目调整失败，请重试。',
      });
    } finally {
      clearTimeout(timer); res.off('close', disconnect); active.delete(key);
    }
  };
}
quizFeedbackRouter.post('/feedback/choices', feedbackRoute('choices'));
quizFeedbackRouter.post('/feedback/adapt', feedbackRoute('adapt'));
