/**
 * growth/activity — 登录用户的**按日活跃心跳**（契约 docs/RETENTION-SPEC.md §2）。
 *
 * 做的事只有一件：某个已登录用户今天第一次打到 `/api/*`，就往 `user_activity_day` 记一行 `(user_id, day)`。
 * 这是 `docs/metrics-product.md` §3 登记的欠账「遥测心跳」——没有它，L3（留存）永远算不出来，
 * 因为 `messages` 只记「说过话的人」，「打开了但没说话」与「没来」在库里长得一模一样。
 *
 * 三条边界：
 *   ① **只记登录用户**（`req.authUser`）：本地单机形态没有账号也不需要留存；
 *   ② **探针不记**：复用 `growth/counters.ts` 的 `isProbeRequest`（`X-SB-Probe` 头 / `studentbuddy-probe/*` UA），
 *      否则 `prod-pulse` 每几分钟一次的巡检会把体验号变成「日日活跃」；
 *   ③ **进程内去重**：每用户每天只打一次库（`Map<userId, day>`），写入本身 `INSERT OR IGNORE` 幂等，
 *      多实例各自写一次也只留一行。
 * 任何异常吞掉：心跳是旁路观测，绝不能让业务请求 500。
 */
import type { NextFunction, Request, Response } from 'express';
import { localDayKey } from '@sb/shared';
import type { AuthedRequest } from '../auth/middleware.js';
import { getDb } from '../storage/db.js';
import { isProbeRequest } from './counters.js';

const seen = new Map<string, string>();

/** 记一次「今天来过」。返回 true = 本进程今天第一次见到这个用户（实际尝试了写入）。 */
export function touchActivity(userId: string, now = new Date()): boolean {
  const day = localDayKey(now);
  if (seen.get(userId) === day) return false;
  seen.set(userId, day);
  try {
    getDb()
      .prepare(`INSERT OR IGNORE INTO user_activity_day (user_id, day, first_seen_at) VALUES (?, ?, datetime('now'))`)
      .run(userId, day);
  } catch {
    // 库不在 / 迁移未到 v52：只丢这一次心跳，不影响请求；下次进程内仍视为已记，避免刷错误日志
  }
  return true;
}

/** 测试与换库（`openIsolated`）后清掉进程内去重表。 */
export function resetActivityCache(): void {
  seen.clear();
}

/** Express 中间件：挂在 `attachUser` 之后、业务路由之前。 */
export function activityHeartbeat(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).authUser;
  if (user && !isProbeRequest(req)) touchActivity(user.id);
  next();
}
