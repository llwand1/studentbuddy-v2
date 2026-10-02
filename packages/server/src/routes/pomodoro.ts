/**
 * routes/pomodoro — 番茄钟的 HTTP 出口（契约 `docs/POMODORO-SPEC.md` §4），前缀 `/api/pomodoro`。
 *
 * 三个端点、一份状态：
 *   GET    /          → `{ session, focus }`（`focus` 由服务端按**服务器时钟**派生，客户端不用自己算一遍方向）
 *   PUT    /          → body `{ session }` 整份落库（开钟 / 翻段 / 跳过都由客户端用 shared 纯函数算好再交）
 *   DELETE /          → 结束
 * ★ 翻段算法只有 shared 一份；服务端**不**替客户端翻页（口径 2：到点不自动翻页），也就没有「服务端定时器」。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pomodoroFocus } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { clearPomodoro, loadPomodoro, savePomodoro } from '../storage/pomodoro.js';

export const pomodoroRouter = Router();

pomodoroRouter.get('/', (req: Request, res: Response) => {
  const session = loadPomodoro(ownerIdOf(req));
  res.json({ session, focus: pomodoroFocus(session, new Date()) });
});

pomodoroRouter.put('/', (req: Request, res: Response) => {
  const session = savePomodoro((req.body as { session?: unknown }).session, ownerIdOf(req));
  if (!session) {
    res.status(400).json({ error: 'session 形状不对：方向不能为空，时间要是合法的 ISO 串。' });
    return;
  }
  res.json({ session, focus: pomodoroFocus(session, new Date()) });
});

pomodoroRouter.delete('/', (req: Request, res: Response) => {
  clearPomodoro(ownerIdOf(req));
  res.json({ session: null, focus: null });
});
