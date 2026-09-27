/**
 * routes/pk-scenario — 情景题进对战的薄路由（契约 docs/PK-SPEC.md §15.4，B4，2026-09-20）。
 *
 * 独立成文件的原因：routes/pk.ts 已 385 行，两个端点塞进去必撞 server ≤400 行门禁；
 * 错误映射/文案/未登录响应**引 routes/pk.ts 的同一份导出**——映射只此一处，不复制（防第二真相源）。
 * 路由只做三件事：身份、调域层（pk/scenario.ts）、错误码映射——业务规则一律不在这一层。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pkScenarioPage, reportScenarioTask } from '../pk/scenario.js';
import { pkIdentityOf } from '../pk/auth.js';
import { fail, unauthorized } from './pk.js';

export const pkScenarioRouter = Router();

/** 回传一个评分点的「发生了什么」：{ questionId, taskId, observed } → 服务端按 criteria 判 → { correct }。
 *  ★ observed 原样透传（unknown）：判分在服务端 judgeTask，宿主与路由都不判、不清洗。 */
pkScenarioRouter.post('/rooms/:id/scenario-report', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  try {
    const r = reportScenarioTask(
      String(req.params.id ?? ''),
      identity.userId,
      req.body?.questionId,
      req.body?.taskId,
      req.body?.observed,
    );
    res.json(r);
  } catch (e) {
    fail(res, e);
  }
});

/**
 * 情景题 demo 页（宿主 iframe 用）：仅对局双方可取（demo 的授权是「房内成员」，不是题库 owner）。
 * ★ 出页响应头与 learning 侧 demo（routes/scenario.ts）**同一套账**：CSP `sandbox`
 *   （刻意不给 allow-same-origin ⇒ demo 源为 null，调不动写接口）+ X-Frame-Options SAMEORIGIN。
 */
pkScenarioRouter.get('/rooms/:id/scenario/:demoId', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  const page = pkScenarioPage(String(req.params.id ?? ''), identity.userId, String(req.params.demoId ?? ''));
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-modals allow-forms');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!page) {
    res.status(404).type('html').send('<meta charset="utf-8">情景题不存在，或对局已结束回收。');
    return;
  }
  res.type('html').send(page);
});
