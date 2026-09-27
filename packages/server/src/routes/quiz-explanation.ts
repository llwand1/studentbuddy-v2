import { Router } from 'express';
import { canAccessSession, ownerIdOf, sessionExists } from '../auth/ownership.js';
import { generateExplanation, parseReviewRequest } from '../learning/quiz-explanation.js';

export const quizExplanationRouter = Router();
const active = new Set<string>();

quizExplanationRouter.post('/explain', async (req, res) => {
  const input = parseReviewRequest(req.body);
  if (!input) { res.status(400).json({ error: '题目与作答资料缺失或过长，请完成练习后再试。' }); return; }
  const ownerId = ownerIdOf(req);
  if (!sessionExists(input.sessionId) || !canAccessSession(input.sessionId, ownerId)) {
    res.status(404).json({ error: '会话不存在。' }); return;
  }
  // 同一用户一次只生成一份，避免连点/多个标签页叠加模型开销。
  const key = ownerId ?? 'local';
  if (active.has(key)) { res.status(409).json({ error: '已有讲解正在生成，请等待完成或取消后再试。' }); return; }
  active.add(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  try {
    const explanation = await generateExplanation(input, ownerId, controller.signal);
    if (!controller.signal.aborted) res.json(explanation);
  } catch (error) {
    if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? '讲解生成超时，请重试。' : error instanceof Error ? error.message : '讲解生成失败，请重试。',
    });
  } finally {
    clearTimeout(timer);
    res.off('close', disconnect);
    active.delete(key);
  }
});
