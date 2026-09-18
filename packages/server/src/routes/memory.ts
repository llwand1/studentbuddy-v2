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
import { canAccessSession, ownerIdOf } from '../auth/ownership.js';

export const memoryRouter = Router();

/** 全部画像（按 importance 倒序）。记忆页用。★ 只看自己的（TENANCY-SPEC §7）。 */
memoryRouter.get('/', (req: Request, res: Response) => {
  res.json(loadMemoryItems(ownerIdOf(req)));
});

/**
 * 某会话的摘要状态（前端提示条用：有摘要才显示「已浓缩早前对话」）。
 *
 * ★ 这里**必须判归属**：摘要虽不算隐私核心，但 `sessionId` 一旦可枚举，
 *   不判就等于「拿别人的会话 id 能读出他早前对话的浓缩」——M2a 只收了会话域自己的端点，
 *   这个旁路当时漏了，本批补上（与会话域同口径：**不归属回 404，不回 403**）。
 */
memoryRouter.get('/summary/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId ?? '';
  if (!canAccessSession(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const { summary, uptoRowid } = loadSessionSummary(sessionId);
  res.json({ summary, uptoRowid, hasSummary: summary.length > 0 });
});

/** 清空某会话摘要：下一轮从零重算（摘要质量差时的逃生口）。同样要判归属——否则可远程擦掉别人的摘要。 */
memoryRouter.delete('/summary/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId ?? '';
  if (!canAccessSession(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  clearSessionSummary(sessionId);
  res.json({ ok: true });
});

/**
 * 删一条画像。未知 id **或不属于自己**都回 404——两种情况的对外表现必须一致，
 * 否则「404 是因为不存在、403 是因为不是你的」就替攻击者确认了 id 的有效性。
 */
memoryRouter.delete('/:id', (req: Request, res: Response) => {
  if (!removeMemory(req.params.id ?? '', ownerIdOf(req))) {
    res.status(404).json({ error: '记忆不存在' });
    return;
  }
  res.json({ ok: true });
});

/** 清空全部画像（记忆页「全部清空」）。带归属 ⇒ 只清自己的，清不掉别人的。 */
memoryRouter.delete('/', (req: Request, res: Response) => {
  res.json({ ok: true, removed: clearMemory(ownerIdOf(req)) });
});
