/**
 * api-pk-invite — 「AI 主动发起对战」邀请的三个用户端点（契约 docs/PK-SPEC.md §16.5）。
 *
 * ★ 为什么不住 `api.ts`：那文件已 380 行上下（本仓 `.ts ≤400` 门禁），而 `api-study-flow.ts`
 *   就是为同样的问题拆出去的——分组文件只依赖 `api-request.ts` 这一层，不成环。
 *
 * ★ **没有 create**：邀请只能由模型的工具 `offer_pk_battle` 发出。REST 侧开一个创建口子
 *   ＝任何人都能给自己刷一张卡，§16.7 那三条频率闸门数的是库，挡不住一个"本该存在"的公开端点。
 *   学习者自己想开战走大厅 `api.pk.createRoom`，两条入口不混。
 */
import type { PkInviteRecord, PkRoomState } from '@sb/shared';
import { request } from './api-request.js';

export const pkInviteApi = {
  /** 本会话未答复且未过旧的邀请（刷新/重连把卡捞回来）；会话不是你的 → 404 */
  pending: (sessionId: string) =>
    request<PkInviteRecord[]>(`/api/pk/invites/pending?sessionId=${encodeURIComponent(sessionId)}`),
  /**
   * 接受：服务端建房 + 开局 ⇒ `{ invite, state }`（拿 `state.roomId` 跳 `#/pk?roomId=`）。
   * ★ 幂等：同一张卡第二次点接受返回**第一次那间房**（重复点是误触，不该吃 409 也开不出第二局）。
   */
  accept: (id: string) =>
    request<{ invite: PkInviteRecord; state: PkRoomState }>(`/api/pk/invites/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /** 拒绝：只置终态不删行；已处理过的卡 → 409（`body.code = INVITE_NOT_PENDING`） */
  reject: (id: string) =>
    request<PkInviteRecord>(`/api/pk/invites/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
