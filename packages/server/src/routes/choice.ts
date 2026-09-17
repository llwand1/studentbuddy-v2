/**
 * routes/choice — 方案选择框的用户端点（契约 docs/ASK-CHOICE-SPEC.md）。
 *
 * 薄路由（ADR-3）：只做参数校验与状态码透传，业务全在 `chat/choice.ts`。
 * 单独成文件的理由：`routes.ts` 已 360 行（贴 400 门禁），且本组端点前缀是 `/api/choices`
 * ——不属于「发消息」，混进 chatRouter 会让路由表失去可读性。
 *
 * 为什么已经有 SSE 了还需要这两个端点：
 * 挂起状态在后端是**内存 Promise**，SSE 缓冲又有「60s 无订阅即回收」——用户关掉标签页
 * 一分钟后重开，回放流里已没有 choice-asked，卡片会彻底消失而工具仍在等（界面显得空闲、
 * 实则挂起，是最难排查的一类体验断裂）。故必须能按会话**主动查询**挂起项来恢复卡片。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { answerChoice, listPendingChoices, cancelChoice } from '../chat/choice.js';

export const choiceRouter = Router();

/** 挂起清单：前端加载会话 / 重连成功时拉一次，把卡片捞回来（无挂起则空数组） */
choiceRouter.get('/', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  res.json(listPendingChoices(sessionId));
});

/**
 * 答复。状态码语义由 `choice.ts` 给出（404 不存在 / 409 已被答复或作废 / 400 参数不合法），
 * 路由只透传——不在这里反推原因（反推在被 mock 的测试与边缘态会判错，见 quiz 的失败真因先例）。
 */
choiceRouter.post('/:id/reply', (req: Request, res: Response) => {
  const { optionId, custom } = req.body as { optionId?: unknown; custom?: unknown };
  const r = answerChoice(req.params.id ?? '', { optionId, custom });
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r.record);
});

/**
 * **跳过**（v18 grill-me，2026-09-16）：把挂起的提问作废并唤醒等待中的工具。
 *
 * 为什么必须有这个端点：前端原来的「收起」只动本地 state，后端的 `askChoice`
 * Promise 还在等——grill-me 开场那张卡是**阻塞整轮**的，不真取消工具就永远悬挂，
 * 「可以跳过」就成了空话。作废后 `choiceToolHint` 会告诉模型「学习者没选，请直接作答」，
 * 本轮照常出正文。
 */
choiceRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const reason = (req.body as { reason?: unknown })?.reason;
  const rec = cancelChoice(req.params.id ?? '', typeof reason === 'string' && reason ? reason : '学习者跳过');
  if (!rec) {
    res.status(409).json({ error: '提问不存在或已结束' });
    return;
  }
  res.json(rec);
});
