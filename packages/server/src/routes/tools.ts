/**
 * routes/tools — 设置页「工具」卡的读写口（契约 TOOL-ECOSYSTEM-SPEC §6.3-4 阈值、§4.5 统计）。
 *
 * ★ 为什么独立成文件而不是并进 `settingsRouter`（routes.ts）：routes.ts 已 381/400 行，
 *   阈值两态 + 统计一条至少 +40 行必破线；且 P4 的 path_grants 列表/撤销也天然是「工具」的路由，
 *   提前立好 `/api/tools` 这个家，届时不再搬家。
 *
 * 口径三条：
 * ① 阈值 PUT 与 quiz-mix 同款——入参一律过 `normalizeConfirmThreshold`（坏值回退默认，不 400），
 *    回读实际落库值，设置页显示的是"存进去的是哪一档"而不是"我点了什么"；
 * ② stats 支持可选 `?sessionId=`：带且归属通过才回 `sessionAffected`（本会话 AI 累计改动 N 条，
 *    §4.6 绕过面审计），带但不归属一律 404 同形（TENANCY-SPEC §5，不泄露"id 存在"）；
 * ③ 只读接口零写侧逻辑，聚合口径全在 `storage/tool-stats.ts`，本文件不碰 SQL。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadConfirmThreshold, saveConfirmThreshold } from '../storage/confirm-threshold.js';
import { summarizeToolStats, sessionAffectedTotal } from '../storage/tool-stats.js';
import { countDeleteLog } from '../storage/term-delete-log.js';
import { ownerIdOf, canAccessSession } from '../auth/ownership.js';

export const toolsRouter = Router();

toolsRouter.get('/confirm-threshold', (req: Request, res: Response) => {
  res.json({ threshold: loadConfirmThreshold(ownerIdOf(req)) });
});

toolsRouter.put('/confirm-threshold', (req: Request, res: Response) => {
  const threshold = saveConfirmThreshold((req.body as { threshold?: unknown }).threshold, ownerIdOf(req));
  res.json({ ok: true, threshold });
});

toolsRouter.get('/stats', (req: Request, res: Response) => {
  const owner = ownerIdOf(req);
  const days = Number(req.query.days);
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  // 404 收口在聚合之前：越权探测不该先吃到一遍全表扫描，也不该回 200 带残缺字段
  if (sessionId && !canAccessSession(sessionId, owner)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({
    stats: summarizeToolStats(owner, Number.isFinite(days) ? days : 30),
    deleteLogTotal: countDeleteLog(owner),
    sessionAffected: sessionId ? sessionAffectedTotal(sessionId, owner) : null,
  });
});
