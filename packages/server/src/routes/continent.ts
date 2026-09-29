/**
 * routes/continent — 知识大陆**开拓地块**的 HTTP 出口（契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「开拓」）。
 *
 * ★ **独立前缀 `/api/continent`，不挂进 `/api/terms`**：`routes/terms.ts` 是词条库的 CRUD 与复习（已 330 行，贴
 *   ≤400 红线），而这里是**玩法写口**（会落词条、会写 `app_settings` 的钉子）。地图取数仍在 `GET /api/terms/review/map`
 *   （它是"词条库的全景"，归词条那边）——本文件只管"在图上开出一块新地"这一件事。
 * ★ 两步制（offer → claim）的理由见 `learning/continent-expand.ts` 头注：题是服务端出的，裁判也在服务端。
 * ★ 薄路由：状态码由域层给（`ExpandFail.status`），这里只落 HTTP；入参只做形状校验（整数格坐标 / 非空 nonce）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { claimExpansion, offerExpansion } from '../learning/continent-expand.js';

export const continentRouter = Router();

/**
 * 领一块待开拓地：body `{ row, col }` = 玩家点的那枚「+」。
 * 回 `ContinentExpandOffer`（新词条 + 两道题 + nonce）；`source:'fallback'` 时 UI 必须如实说这条来自内置词池。
 */
continentRouter.post('/expand/offer', async (req: Request, res: Response) => {
  const { row, col } = req.body as { row?: unknown; col?: unknown };
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    res.status(400).json({ error: 'row / col 必须是整数格坐标' });
    return;
  }
  const r = await offerExpansion(ownerIdOf(req), { row: row as number, col: col as number });
  if ('ok' in r && r.ok === false) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
});

/** 落地：body `{ nonce, answers }`；服务端重判，全对才落库 + 钉住（`ContinentExpandResult`） */
continentRouter.post('/expand/claim', (req: Request, res: Response) => {
  const { nonce, answers } = req.body as { nonce?: unknown; answers?: unknown };
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    res.status(400).json({ error: 'nonce 必填（来自 offer）' });
    return;
  }
  const r = claimExpansion(ownerIdOf(req), nonce, answers);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
});
