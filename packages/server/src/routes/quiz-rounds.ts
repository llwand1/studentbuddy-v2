import { Router, type Request, type Response } from 'express';
import { canAccessSession, ownerIdOf, sessionExists } from '../auth/ownership.js';
import { parseDraftChange, parseOpenRound, type DraftChange } from '../learning/quiz-round-input.js';
import { loadQuizRound, openQuizRound, roundSession, newQuizRound, saveQuizDraft, submitQuizRound, listQuizRoundHistory, RoundConflict, RoundInputError } from '../learning/quiz-round-store.js';
import { recoverInterruptedRound, subscribeQuizRound, startQuizRoundAnalysis, cancelQuizRoundAnalysis } from '../learning/quiz-question-agent.js';
import type { QuizRound } from '@sb/shared';
export const quizRoundsRouter = Router();
function available(req: Request, res: Response): QuizRound | null {
  const owner = ownerIdOf(req), id = req.params.id ?? '', session = roundSession(id, owner);
  if (session === undefined || (session && (!sessionExists(session) || !canAccessSession(session, owner)))) {
    res.status(404).json({ error: '本轮练习不存在。' }); return null;
  }
  return loadQuizRound(id, owner);
}
function fail(res: Response, error: unknown): void {
  res.status(error instanceof RoundConflict ? 409 : error instanceof RoundInputError ? 400 : 500)
    .json({ error: error instanceof Error ? error.message : '保存练习失败，请重试。' });
}
quizRoundsRouter.post('/rounds/open', (req, res) => {
  const owner = ownerIdOf(req), input = parseOpenRound(req.body, owner);
  if (!input) { res.status(400).json({ error: '题组内容缺失或过长。' }); return; }
  if (input.sessionId && (!sessionExists(input.sessionId) || !canAccessSession(input.sessionId, owner))) {
    res.status(404).json({ error: '会话不存在。' }); return;
  }
  try {
    const round = openQuizRound(input, owner);
    res.json(recoverInterruptedRound(round.id, owner));
  } catch (error) { fail(res, error); }
});
quizRoundsRouter.get('/round-history', (req, res) => {
  const cursor = typeof req.query.before === 'string' ? req.query.before : undefined;
  if (cursor && !/^[\w-]{1,80}$/.test(cursor)) { res.status(400).json({ error: '历史记录位置不合法。' }); return; }
  res.json(listQuizRoundHistory(ownerIdOf(req), cursor));
});
quizRoundsRouter.get('/rounds/:id', (req, res) => {
  if (available(req, res)) res.json(recoverInterruptedRound(req.params.id!, ownerIdOf(req)));
});
quizRoundsRouter.patch('/rounds/:id/answer', (req, res) => {
  const round = available(req, res); if (!round) return;
  const change = parseDraftChange(req.body, round.questions);
  if (!change) { res.status(400).json({ error: '作答或思考格式不正确、过长。' }); return; }
  try { res.json(saveQuizDraft(round.id, ownerIdOf(req), change)); } catch (error) { fail(res, error); }
});
quizRoundsRouter.post('/rounds/:id/submit', (req, res) => {
  const round = available(req, res); if (!round) return;
  if (!Array.isArray(req.body?.changes) || req.body.changes.length > 20) { res.status(400).json({ error: '请提交完整题组。' }); return; }
  const changes = (req.body.changes as unknown[]).map(v => parseDraftChange(v, round.questions));
  if (changes.some(v => !v)) { res.status(400).json({ error: '作答或思考格式不正确。' }); return; }
  try {
    submitQuizRound(round.id, ownerIdOf(req), changes as DraftChange[]);
    startQuizRoundAnalysis(round.id, ownerIdOf(req));
    res.json(loadQuizRound(round.id, ownerIdOf(req)));
  } catch (error) { fail(res, error); }
});
quizRoundsRouter.post('/rounds/:id/new', (req, res) => {
  const round = available(req, res); if (!round) return;
  try { res.json(newQuizRound(round.id, ownerIdOf(req))); } catch (error) { fail(res, error); }
});
quizRoundsRouter.post('/rounds/:id/questions/:index/retry', (req, res) => {
  const round = available(req, res); if (!round) return;
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || !round.responses[index] || !['error', 'cancelled'].includes(round.responses[index]!.status)) {
    res.status(400).json({ error: '仅可继续未完成的本题分析。' }); return;
  }
  startQuizRoundAnalysis(round.id, ownerIdOf(req), index);
  res.json(loadQuizRound(round.id, ownerIdOf(req)));
});
quizRoundsRouter.post('/rounds/:id/cancel', (req, res) => {
  const round = available(req, res); if (!round) return;
  cancelQuizRoundAnalysis(round.id, ownerIdOf(req));
  res.json(loadQuizRound(round.id, ownerIdOf(req)));
});
quizRoundsRouter.get('/rounds/:id/events', (req, res) => {
  const round = available(req, res); if (!round) return;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (data: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const off = subscribeQuizRound(round.id, send);
  send({ type: 'round', round: recoverInterruptedRound(round.id, ownerIdOf(req)) });
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
  res.on('close', () => { clearInterval(heartbeat); off(); });
});
