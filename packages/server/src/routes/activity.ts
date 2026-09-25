/**
 * routes/activity — 反馈环薄路由。
 *
 * ★ M2d（2026-09-18）：两个端点全部按归属读（`daily_activity` / `user_stats` 在 v30 归主）。
 *   ★ 路由只负责把 `ownerIdOf(req)` 的**原样值**（`string | null`）传下去，**转换留给
 *   `ownerForWrite`**（`null` ⇒ `''` = 无主行）。★ 不要在这里写 `?? ''`——那是把转换抄了
 *   第二份：口径一旦要改（比如将来引入"团队"维度），路由里这份会静默留在旧语义上。
 *   ★ 也不要以为"未登录 ⇒ 看不到历史"：未登录模式下写入的行**本来就是无主行**（同一把 helper），
 *   所以本地单人模式读到的就是自己的全部历史。判据与推演见 `auth/ownership.ts#ownerForWrite`。
 */
import { Router } from 'express';
import { todayStats, last7Days } from '../learning/activity.js';
import { ownerIdOf } from '../auth/ownership.js';

export const activityRouter = Router();

activityRouter.get('/today', (req, res) => {
  res.json(todayStats(ownerIdOf(req)));
});

activityRouter.get('/week', (req, res) => {
  res.json(last7Days(ownerIdOf(req)));
});
