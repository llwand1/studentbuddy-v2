/**
 * api-npc — 学习伙伴（NPC）的 REST 封装（契约 `docs/NPC-PARTNER-SPEC.md` §7.1）。
 *
 * ★ 独立成文件与 `api-cards.ts` 同一条理由：`api.ts` 已贴「.ts ≤400 行」红线，
 *   而本组是 4 个端点 + 5 个类型。只依赖 `api-request.ts`，不反向 import `api.ts`（环断在这里）。
 *
 * ★★ **这里的类型是服务端 `routes/npc.ts`／`learning/npc.ts` 的形状镜像，不是第二份口径**：
 *   服务端代码不进 web 的编译单元（`npm run build` 不编 server），前端拿不到那些 interface，
 *   所以形状只能在这里再写一遍。真正**不双写**的是判定——伙伴的数量、位置、遇险结论、
 *   今天还能换几次，一律**读服务端**（它们都是跨表的派生量，前端算不了）。
 *   ⚠️ 改服务端字段时必须同步改这里：护栏是 `routes/npc.test.ts`（它锁的是服务端发出的形状）。
 */
import { request } from './api-request.js';
import type { ChestDraw } from './api-cards.js';

/** 威胁：堵住伙伴的那只怪（★ 领地格不算威胁源，见 SPEC §5.1） */
export interface NpcThreat {
  termId: string;
  term: string;
  distance: number;
}

/** 一位伙伴（= 服务端 `NpcView`）；`distressed` 是 `threat !== null` 的布尔镜头 */
export interface NpcView {
  id: string;
  name: string;
  /** 他守的那条词条（也是他的锚点：`id` = `npc:<termId>`） */
  termId: string;
  term: string;
  domain: string;
  row: number;
  col: number;
  distressed: boolean;
  threat: NpcThreat | null;
}

/** `GET /api/npc`（= 服务端 `NpcState`）：一次读全，含遇险结论与交换余额 */
export interface NpcState {
  /** 主伙伴的显示名（用户起的名字或默认名）；空库时为 `''` */
  partnerName: string;
  npcs: NpcView[];
  /** 当前**该有**几位伙伴（空库时会大于 `npcs.length`：没有格可落脚） */
  count: number;
  max: number;
  /** 还差几条词条多一位伙伴；已封顶为 `null` */
  termsToNext: number | null;
  tradesLeft: number;
}

/** `POST /:id/talk`：★ `fallback` 不是"失败了"，是"现在只能这样"——UI 必须说真话 */
export interface NpcTalkResult {
  reply: string;
  source: 'ai' | 'fallback';
}

/** `POST /:id/trade`：`draw.openId` 交给**既有** `POST /api/cards/chest/accept` 收下 */
export interface NpcTradeResult {
  draw: ChestDraw;
  /** 信物的领域里没得换时回落全池 ⇒ `false`，UI 要如实说一句 */
  domainMatched: boolean;
  tradesLeft: number;
}

export const npcApi = {
  /** 伙伴名单 + 数量上界 + 交换余额（★ 零写：进地图页拉它不会写库） */
  state: () => request<NpcState>('/api/npc'),
  /** 给主伙伴起名；空串 ⇒ 恢复默认名（服务端回当前名字，前端不用再拉一次） */
  renamePartner: (name: string) =>
    request<{ partnerName: string }>('/api/npc/partner', { method: 'PUT', body: JSON.stringify({ name }) }),
  /** 跟他说句话。无 key 时也是 200（`source='fallback'`），故这里没有专门的失败分支 */
  talk: (id: string, text: string) =>
    request<NpcTalkResult>(`/api/npc/${encodeURIComponent(id)}/talk`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  /** 交换：信物必须是**自己的**、卡数 ≥2 的词条（服务端判，前端只管禁用态） */
  trade: (id: string, termId: string) =>
    request<NpcTradeResult>(`/api/npc/${encodeURIComponent(id)}/trade`, {
      method: 'POST',
      body: JSON.stringify({ termId }),
    }),
};