/**
 * routes/learner — 评分量规与学习者模型（挂在 `/api/learning` 下，与 `ai-ops.ts` 的 learningRouter 并列）。
 *
 *   POST /api/learning/grade                    AI 判填空/解答题 ⇒ GradeResult（并记误区、进事件流）
 *   GET  /api/learning/model                    学习者模型：快忘的词条、未解决误区、题型正确率、记忆校准
 *   POST /api/learning/misconceptions/:id/resolve  学习者自己把一条误区标为已解决
 */
import { Router } from 'express';
import type { GradeRequest } from '@sb/shared';
import { GRADE_LIMITS } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { gradeAnswer } from '../learning/quiz-grade.js';
import { learnerModel, resolveMisconception } from '../learning/learner-model.js';

export const learnerRouter = Router();

function str(x: unknown, max: number): string | null {
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t && t.length <= max ? t : null;
}

/** 入参闸门：必填三段非空且不超长；题型只认 fill / essay（选择与判断前端自己判得了，不花模型钱） */
export function parseGradeRequest(body: unknown): GradeRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const question = str(b.question, GRADE_LIMITS.question);
  const reference = str(b.reference, GRADE_LIMITS.reference);
  const answer = str(b.answer, GRADE_LIMITS.answer);
  if (!question || !reference || !answer) return null;
  if (b.qtype !== 'fill' && b.qtype !== 'essay') return null;
  const termId = str(b.termId, 100);
  const topic = str(b.topic, 200);
  return { question, reference, answer, qtype: b.qtype, ...(termId ? { termId } : {}), ...(topic ? { topic } : {}) };
}

const STATUS: Record<string, number> = { 'no-model': 503, timeout: 504, aborted: 499 };

learnerRouter.post('/grade', async (req, res) => {
  const input = parseGradeRequest(req.body);
  if (!input) {
    res.status(400).json({ error: '需要题目、参考答案与作答（均非空且不超长），题型为 fill 或 essay' });
    return;
  }
  // 用户关掉页面 ⇒ 掐掉上游，不白花一次模型调用
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const r = await gradeAnswer(input, ownerIdOf(req), ac.signal);
  if (!r.ok) {
    if (ac.signal.aborted) return;
    res.status(STATUS[r.reason] ?? 502).json({ error: r.error, reason: r.reason });
    return;
  }
  res.json(r.result);
});

learnerRouter.get('/model', (req, res) => {
  res.json(learnerModel(ownerIdOf(req)));
});

learnerRouter.post('/misconceptions/:id/resolve', (req, res) => {
  if (!resolveMisconception(ownerIdOf(req), req.params.id)) {
    res.status(404).json({ error: '没有这条未解决的误区' });
    return;
  }
  res.json({ ok: true });
});
