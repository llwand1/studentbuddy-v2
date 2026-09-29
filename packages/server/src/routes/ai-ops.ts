/**
 * routes/ai-ops — AI 网关统计 / 学习事件流 / 后台任务的薄路由（v46）。
 *
 *   GET  /api/ai/stats?days=7              自己最近 N 天的模型调用：按用途的成功率、失败分类、耗时分位、token
 *   GET  /api/learning/summary?days=14     学习概况（每日复习/答题/新词条/对话 + 连续天数 + 记住率/正确率）
 *   GET  /api/learning/terms/:id/timeline  某个词条的学习时间线
 *   POST /api/learning/answers             前端答完一题时上报（发 `quiz_answered`：答题从此算学习日）
 *   GET  /api/jobs                         自己最近的后台任务 + 各状态计数
 *   POST /api/jobs/:id/retry               手动重试一条失败的任务
 *
 * ★ 全部按 `ownerIdOf(req)` 过滤：统计、事件、任务都只看得到自己的。
 */
import { Router } from 'express';
import { ANSWER_QTYPES, ANSWER_SOURCES, type JobView } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { publishEvent } from '../events/bus.js';
import { aiCallStats } from '../ai/call-log.js';
import { learningSummary, termTimeline } from '../learning/learning-events.js';
import { jobCounts, listJobs, retryJob } from '../jobs/queue.js';
import { jobLabel } from '../jobs/worker.js';

function intParam(v: unknown, dflt: number): number {
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : dflt;
}

export const aiRouter = Router();

aiRouter.get('/stats', (req, res) => {
  res.json(aiCallStats(ownerIdOf(req), intParam(req.query.days, 7)));
});

export const learningRouter = Router();

learningRouter.get('/summary', (req, res) => {
  res.json(learningSummary(ownerIdOf(req), intParam(req.query.days, 14)));
});

learningRouter.get('/terms/:id/timeline', (req, res) => {
  res.json({ items: termTimeline(ownerIdOf(req), req.params.id) });
});

/**
 * 答题上报。★ 只收白名单里的题型与来源；`correct` 必须是布尔；`ms` 钳到 0–30 分钟。
 * 服务端不判分（题在前端判过了），这里只是**记一笔学习行为**——伪造它最多给自己多记一个学习日，
 * 碰不到别人的数据，也不发钥匙/卡牌（那些奖励各有自己的服务端判定）。
 */
learningRouter.post('/answers', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const items = Array.isArray(b.items) ? b.items.slice(0, 50) : [b];
  let accepted = 0;
  for (const raw of items as Array<Record<string, unknown>>) {
    if (typeof raw?.correct !== 'boolean') continue;
    const qtype = typeof raw.qtype === 'string' && (ANSWER_QTYPES as readonly string[]).includes(raw.qtype) ? raw.qtype : undefined;
    const source = typeof raw.source === 'string' && (ANSWER_SOURCES as readonly string[]).includes(raw.source) ? raw.source : undefined;
    const ms = typeof raw.ms === 'number' && Number.isFinite(raw.ms) ? Math.min(Math.max(Math.round(raw.ms), 0), 1_800_000) : undefined;
    const quizId = typeof raw.quizId === 'string' ? raw.quizId.slice(0, 80) : '';
    const termId = typeof raw.termId === 'string' ? raw.termId.slice(0, 80) : undefined;
    publishEvent({ type: 'quiz_answered', quizId, correct: raw.correct, ownerId: ownerIdOf(req), qtype, ms, termId, source });
    accepted += 1;
  }
  if (accepted === 0) {
    res.status(400).json({ error: '没有可记录的作答（correct 必须是 true/false）' });
    return;
  }
  res.json({ accepted });
});

export const jobsRouter = Router();

jobsRouter.get('/', (req, res) => {
  const owner = ownerIdOf(req);
  const jobs: JobView[] = listJobs(owner, intParam(req.query.limit, 20)).map((j) => ({
    id: j.id,
    kind: j.kind,
    label: jobLabel(j.kind),
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    lastError: j.last_error,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  }));
  res.json({ jobs, counts: jobCounts(owner) });
});

jobsRouter.post('/:id/retry', (req, res) => {
  if (!retryJob(req.params.id, ownerIdOf(req))) {
    res.status(404).json({ error: '没有这条失败的任务' });
    return;
  }
  res.json({ ok: true });
});
