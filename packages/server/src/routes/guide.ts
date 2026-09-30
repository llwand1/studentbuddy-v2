/**
 * routes/guide — 「下一步引导」的 HTTP 出口（契约 `docs/GUIDE-SPEC.md` §6），前缀 `/api/guide`。
 *
 * ★ 薄路由：形状校验在 shared 的 `parseGuideRequest`（白名单外的 kind / 非法视图 ⇒ 400），
 *   取现场 / 调模型 / 兜底都在 `learning/guide.ts`。形状合法的请求**永远 200**——模型失手走规则推荐。
 * ★ 用户关掉页面 / 切走就掐掉上游调用（同 `quiz/explain` 的做法）：引路灯的请求是「点开时现要」的，
 *   没人看的结果不值得再等一次模型。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { parseGuideRequest } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { guideNext } from '../learning/guide.js';

export const guideRouter = Router();

guideRouter.post('/next', async (req: Request, res: Response) => {
  const parsed = parseGuideRequest(req.body);
  if (!parsed) {
    res.status(400).json({ error: '请求形状不对：lang / view 要合法，can 只能是已登记的动作种类。' });
    return;
  }
  const controller = new AbortController();
  const disconnect = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', disconnect);
  try {
    const out = await guideNext(ownerIdOf(req), parsed, { signal: controller.signal });
    if (!controller.signal.aborted) res.json(out);
  } finally {
    res.off('close', disconnect);
  }
});
