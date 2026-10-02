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
import { clearPomodoro, loadPomodoro, logPomodoroRound, pomodoroStats, savePomodoro } from '../storage/pomodoro.js';

export const pomodoroRouter = Router();

pomodoroRouter.get('/', (req: Request, res: Response) => {
  const session = loadPomodoro(ownerIdOf(req));
  res.json({ session, focus: pomodoroFocus(session, new Date()) });
});

pomodoroRouter.put('/', (req: Request, res: Response) => {
  const owner = ownerIdOf(req);
  const prev = loadPomodoro(owner);
  const session = savePomodoro((req.body as { session?: unknown }).session, owner);
  if (!session) {
    res.status(400).json({ error: 'session 形状不对：方向不能为空，时间要是合法的 ISO 串。' });
    return;
  }
  // 流水（契约 §10）：`completed` 比库里多了 ⇒ 刚完成一个工作段，按**上一份**会话的方向 / 时长 / 轮次记一行。
  // 只认 +1：客户端一次翻两段（再来一轮）也只完成了一轮；跨会话（方向换了、completed 归零）不记。
  if (prev && session.completed === prev.completed + 1 && prev.phase === 'work') logPomodoroRound(owner, prev);
  res.json({ session, focus: pomodoroFocus(session, new Date()) });
});

/** 专注统计：今日 / 近 7 天逐日 / 按方向（督促小窗的学习可视化，契约 §10） */
pomodoroRouter.get('/stats', (req: Request, res: Response) => {
  res.json(pomodoroStats(ownerIdOf(req)));
});

pomodoroRouter.delete('/', (req: Request, res: Response) => {
  clearPomodoro(ownerIdOf(req));
  res.json({ session: null, focus: null });
});
