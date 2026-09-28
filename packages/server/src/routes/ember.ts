/**
 * routes/ember — 「余烬笺 · 意外发现」的 HTTP 出口（域层见 `learning/ember.ts`）。
 *   GET    /api/ember/spot?night=0|1   今天（或「过一夜」后）大陆上那簇异火
 *   GET    /api/ember/mine             我写过的笺（含被谢次数）
 *   POST   /api/ember                  写 / 改写一张笺 { termId, body, sign? }
 *   DELETE /api/ember/:id              撤回自己的笺
 *   POST   /api/ember/:id/keep|thank|hide
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { emberSpot, hideEmber, keepEmber, myEmbers, removeEmber, thankEmber, writeEmber, type EmberAct } from '../learning/ember.js';

export const emberRouter = Router();

emberRouter.get('/spot', (req: Request, res: Response) => {
  const night = Math.max(0, Math.min(7, Math.trunc(Number(req.query.night ?? 0)) || 0));
  res.json({ spot: emberSpot(ownerIdOf(req), new Date(), night) });
});

emberRouter.get('/mine', (req: Request, res: Response) => {
  res.json({ notes: myEmbers(ownerIdOf(req)) });
});

emberRouter.post('/', (req: Request, res: Response) => {
  const r = writeEmber(ownerIdOf(req), (req.body ?? {}) as Record<string, unknown>);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.status(201).json({ note: r.note });
});

emberRouter.delete('/:id', (req: Request, res: Response) => {
  if (!removeEmber(ownerIdOf(req), String(req.params.id))) {
    res.status(404).json({ error: '没有这张笺，或它不是你写的' });
    return;
  }
  res.json({ ok: true });
});

const act = (fn: (owner: string | null, id: string) => EmberAct) => (req: Request, res: Response) => {
  const r = fn(ownerIdOf(req), String(req.params.id));
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
};

emberRouter.post('/:id/keep', act(keepEmber));
emberRouter.post('/:id/thank', act(thankEmber));
emberRouter.post('/:id/hide', act(hideEmber));
