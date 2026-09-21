/**
 * routes/obs — 可观测只读查询（薄路由，同 activity 范式）。
 * GET /api/obs/events?kind=&sinceId=&limit= —— 纯读无副作用，不走 Origin 写闸门；
 * ★ 但**归属闸门照吃**（2026-09-21 闸门 #2）：云模式只回本人会话的事件，别人的会话 id
 *   与事件摘要（含查询词）一条都不外泄，见 storage/obs.ts 的 listObsEvents。
 */
import { Router } from 'express';
import { isObsKind } from '@sb/shared/obs';
import type { ObsKind } from '@sb/shared/obs';
import { ownerIdOf } from '../auth/ownership.js';
import { listObsEvents } from '../storage/obs.js';

export const obsRouter = Router();

obsRouter.get('/events', (req, res) => {
  const kindRaw = req.query.kind;
  let kind: ObsKind | undefined;
  if (typeof kindRaw === 'string' && kindRaw.length > 0) {
    if (!isObsKind(kindRaw)) {
      res.status(400).json({ error: `unknown kind: ${kindRaw}` });
      return;
    }
    kind = kindRaw;
  }
  const sinceRaw = req.query.sinceId;
  const sinceId = typeof sinceRaw === 'string' && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
  res.json({ events: listObsEvents({ kind, sinceId, limit, ownerId: ownerIdOf(req) }) });
});
