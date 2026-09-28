/**
 * routes/continent-world — 开拓制大陆的 HTTP 出口（域层见 `learning/continent-world.ts` / `continent-delve.ts`）。
 *   GET  /api/continent/world          存档 + 词条数 + 刷怪用的「今天」
 *   POST /api/continent/explore        { row, col }        花 1 枚开拓令开一格迷雾
 *   POST /api/continent/slay           { row, col, day }   击败野怪，一次开一片
 *   POST /api/continent/delve          { row, col, question } 追问（AI 作答 + 出题）
 *   POST /api/continent/delve/finish   { row, col, answers }  交卷；全对 ⇒ 地块升级
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { exploreOne, slayWild, worldPayload, type WorldResult } from '../learning/continent-world.js';
import { delveAsk, delveFinish } from '../learning/continent-delve.js';

export const continentWorldRouter = Router();

function send<T>(res: Response, r: WorldResult<T>): void {
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
}

const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

continentWorldRouter.get('/world', (req, res) => {
  res.json(worldPayload(ownerIdOf(req)));
});
continentWorldRouter.post('/explore', (req, res) => send(res, exploreOne(ownerIdOf(req), bodyOf(req))));
continentWorldRouter.post('/slay', (req, res) => send(res, slayWild(ownerIdOf(req), bodyOf(req))));
continentWorldRouter.post('/delve', async (req, res) => send(res, await delveAsk(ownerIdOf(req), bodyOf(req))));
continentWorldRouter.post('/delve/finish', (req, res) => send(res, delveFinish(ownerIdOf(req), bodyOf(req))));
