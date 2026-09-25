/**
 * routes/pk-invite — 「AI 主动发起对战」邀请的用户端点（契约 docs/PK-SPEC.md §16.5）。
 *
 * 薄路由（ADR-3）：只做「取身份/取参数 → 调域层 → 码映射 HTTP」，业务规则一律在 `pk/invite.ts`。
 * 单独成文件的理由与 `routes/choice.ts` 同款：`routes/pk.ts` 已 388/400 行，而本组端点是
 * **另一个资源**（邀请，不是房间），混进去只会把它顶破门禁线。
 *
 * ★ 这里**没有**「创建邀请」的口子：邀请只能由模型的工具发出（`chat/tools/offer-pk-battle.ts`）。
 *   人自己想开对战走大厅 `POST /rooms`。两条入口不混——混了等于把「AI 主动」变成一个
 *   任何人都能刷的开放写口（§16.7 那三条闸门的判据是数库，挡不住一个本该存在的公开端点）。
 *
 * ★ 三个码里只有两个会出现在用户界面：`INVITE_NOT_FOUND` / `INVITE_NOT_PENDING` /
 *   `INVITE_ROOM_GONE`；`INVITE_THROTTLED` 与 `INVITE_INPUT_INVALID` 是**回灌给模型**的，
 *   REST 侧永远拿不到（映射留在表里只为「万一有」时不静默变 500）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PkInviteError } from '@sb/shared';
import { acceptPkInvite, listPendingInvites, rejectPkInvite } from '../pk/invite.js';
import { ensureTicker } from '../pk/match.js';
import { pkIdentityOf } from '../pk/auth.js';
import { canAccessSession, ownerIdOf } from '../auth/ownership.js';
import { unauthorized } from './pk.js';

export const pkInviteRouter = Router();

/** 域错误码 → HTTP 状态（穷尽映射由编译器保证：加码不写就在这里红） */
const INVITE_STATUS: Record<PkInviteError, number> = {
  INVITE_NOT_FOUND: 404,
  INVITE_NOT_PENDING: 409,
  INVITE_THROTTLED: 409,
  INVITE_INPUT_INVALID: 400,
  INVITE_ROOM_GONE: 404,
};

/** 域错误码 → 人话文案（ADR-5：失败必须可读，不裸抛码） */
const INVITE_TEXT: Record<PkInviteError, string> = {
  INVITE_NOT_FOUND: '这张邀请不存在或不属于你',
  INVITE_NOT_PENDING: '这张邀请卡已经处理过了',
  INVITE_THROTTLED: '刚刚已经发过邀请了，先等他决定',
  INVITE_INPUT_INVALID: '邀请内容不合法',
  INVITE_ROOM_GONE: '这场对战已结束或已失效，请让 AI 重新邀请一局',
};

/** 域层的失败结果 → HTTP 响应（`error` 一律是文案，另带 `code` 供前端分支） */
function failInvite(res: Response, code: PkInviteError, error?: string): void {
  res.status(INVITE_STATUS[code]).json({ error: error ?? INVITE_TEXT[code], code });
}

/**
 * 未答复且未过旧的邀请（前端加载会话 / 重连成功时拉一次把卡捞回来，无则空数组）。
 *
 * ★ 归属必须核（§16.12 风险 6）：不核的话 `sessionId` 猜中就能捞别人的卡；
 *   而 `ownerIdOf → null`（本地单人形态）那条老坑是「无过滤＝看全部」，这里靠
 *   `canAccessSession` 同一条门面兜住——未登录放行、登录后只能看自己的会话。
 */
pkInviteRouter.get('/pending', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  if (!sessionId || !canAccessSession(sessionId, ownerIdOf(req))) {
    failInvite(res, 'INVITE_NOT_FOUND');
    return;
  }
  res.json(listPendingInvites(sessionId));
});

/**
 * 接受：服务端建房 + 开局，返回与 `POST /rooms` 同形的 `{ state }`（前端据此跳 `#/pk?roomId=`）。
 * ★ **幂等**：同一张卡第二次点接受返回第一次那间房（不是 409）——重复点是误触不是意图。
 */
pkInviteRouter.post('/:id/accept', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) {
    unauthorized(res);
    return;
  }
  const r = acceptPkInvite(req.params.id ?? '', identity, ownerIdOf(req));
  if (!r.ok) {
    failInvite(res, r.code, r.error);
    return;
  }
  // ★ 1s ticker 归路由层点火（同 `routes/pk.ts:192`）：接受走的是**域层** `acceptInviteRoom`，
  //   不经过那个端点 ⇒ 漏这一行不报错，症状是对局永远不动（AI 不出题、超时不判、8 分钟不结算）。
  ensureTicker();
  res.json({ invite: r.record, state: r.state });
});

/** 拒绝：只置终态不删行（行留着给闸门数「本会话刚发过邀请」） */
pkInviteRouter.post('/:id/reject', (req: Request, res: Response) => {
  const r = rejectPkInvite(req.params.id ?? '', ownerIdOf(req));
  if (!r.ok) {
    failInvite(res, r.code, r.error);
    return;
  }
  res.json(r.record);
});
