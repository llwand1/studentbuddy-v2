/**
 * routes/activity — 反馈环薄路由。
 */
import { Router } from 'express';
import { todayStats, last7Days, todaySummary } from '../learning/activity.js';

export const activityRouter = Router();

activityRouter.get('/today', (_req, res) => {
  res.json(todayStats());
});

activityRouter.get('/week', (_req, res) => {
  res.json(last7Days());
});

activityRouter.get('/summary', async (_req, res) => {
  res.json({ content: await todaySummary() });
});
