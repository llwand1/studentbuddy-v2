/**
 * routes/activity — 反馈环薄路由。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { todayStats, last7Days, todaySummary } from '../learning/activity.js';
import { ownerIdOf } from '../auth/ownership.js';

export const activityRouter = Router();

activityRouter.get('/today', (_req, res) => {
  res.json(todayStats());
});

activityRouter.get('/week', (_req, res) => {
  res.json(last7Days());
});

activityRouter.get('/summary', async (req: Request, res: Response) => {
  // M2c：总结要调 summarizer 模型，归属取当前用户（未登录 ⇒ null = 平台通道）
  res.json({ content: await todaySummary(ownerIdOf(req)) });
});
