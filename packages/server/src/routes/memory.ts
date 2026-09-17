/**
 * routes/memory — 长期记忆薄路由（契约 `docs/MEMORY-SPEC.md` §7 逃生口）。
 * 画像列表 / 单条删 / 全部清空 / 查与清某会话摘要。
 *
 * ★ 为什么这几个端点是**必做**而不是「锦上添花」（ADR-5 不静默）：
 *   记忆是**自动写入**的——模型自己决定记什么。用户看不见、改不了，它就只是黑箱，
 *   而一条写脏的画像会**污染此后每一个会话**（不像会话摘要只影响一个会话）。
 *   可见 + 可删，是「自动记忆」这个机制能被接受的前提。
 * ★ 全部只读 + 删除，**没有写入端点**：画像的写入路径唯一（压缩过程），
 *   多开一条手写路径就等于承认「模型自动写的东西需要人补」，那不如直接修提示词。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { clearMemory, loadMemoryItems, removeMemory } from '../chat/memory.js';
import { clearSessionSummary, loadSessionSummary } from '../chat/compact.js';

export const memoryRouter = Router();

/** 全部画像（按 importance 倒序）。记忆页用。 */
memoryRouter.get('/', (_req, res) => {
  res.json(loadMemoryItems());
});

/** 某会话的摘要状态（前端提示条用：有摘要才显示「已浓缩早前对话」）。 */
memoryRouter.get('/summary/:sessionId', (req: Request, res: Response) => {
  const { summary, uptoRowid } = loadSessionSummary(req.params.sessionId ?? '');
  res.json({ summary, uptoRowid, hasSummary: summary.length > 0 });
});

/** 清空某会话摘要：下一轮从零重算（摘要质量差时的逃生口）。 */
memoryRouter.delete('/summary/:sessionId', (req: Request, res: Response) => {
  clearSessionSummary(req.params.sessionId ?? '');
  res.json({ ok: true });
});

/** 删一条画像。未知 id 回 404（与 terms 的删法不同：那边恒 200——这里前端要能区分「删错了」）。 */
memoryRouter.delete('/:id', (req: Request, res: Response) => {
  if (!removeMemory(req.params.id ?? '')) {
    res.status(404).json({ error: '记忆不存在' });
    return;
  }
  res.json({ ok: true });
});

/** 清空全部画像（记忆页「全部清空」）。 */
memoryRouter.delete('/', (_req, res) => {
  res.json({ ok: true, removed: clearMemory() });
});
