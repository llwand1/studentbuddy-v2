/**
 * routes/drill — 「等待时刷词」的 HTTP 出口（契约 `docs/WAIT-DRILL-SPEC.md` §4），前缀 `/api/drill`。
 *
 * ★ 刷词的**题面与判分全在前端**（`@sb/shared/drill`，词条来自既有的 `GET /api/terms/review/map`）：
 *   刷词不发奖励、不写账，前端判分没有"白拿"的风险；到期词条答对的那一次打卡走既有 `POST /api/terms/:id/review`，
 *   仍由复习引擎守 409。所以这里只有三个写口，全是"新词"这一件事：出新词 / 收入词库 / 不要。
 * ★ 薄路由：状态码由域层给（`DrillFail.status`），这里只做形状校验。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { dismissDrillTerm, drillNewTerms, keepDrillTerm } from '../learning/drill.js';

export const drillRouter = Router();

/** 出新词：body `{ sessionId? }`（带上正在等的那轮对话，新词跟着话题走）。永不 5xx：模型失手退词池。 */
drillRouter.post('/new-terms', async (req: Request, res: Response) => {
  const { sessionId, want } = req.body as { sessionId?: unknown; want?: unknown };
  const r = await drillNewTerms(ownerIdOf(req), {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    want: typeof want === 'number' ? want : undefined,
  });
  res.json(r);
});

/** 收入词库：body `{ candidateId? , term?, definition?, domain? }`（候选按表里那行为准） */
drillRouter.post('/keep', (req: Request, res: Response) => {
  const body = req.body as { candidateId?: unknown; term?: unknown; definition?: unknown; domain?: unknown };
  const r = keepDrillTerm(ownerIdOf(req), {
    candidateId: typeof body.candidateId === 'string' ? body.candidateId : null,
    term: typeof body.term === 'string' ? body.term : undefined,
    definition: typeof body.definition === 'string' ? body.definition : undefined,
    domain: typeof body.domain === 'string' ? body.domain : undefined,
  });
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
});

/** 不要这条：body `{ candidateId }`，候选标驳回（留行，以后不再出） */
drillRouter.post('/dismiss', (req: Request, res: Response) => {
  const { candidateId } = req.body as { candidateId?: unknown };
  if (typeof candidateId !== 'string' || candidateId.trim() === '') {
    res.status(400).json({ error: 'candidateId 必填' });
    return;
  }
  const r = dismissDrillTerm(ownerIdOf(req), candidateId);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r);
});
