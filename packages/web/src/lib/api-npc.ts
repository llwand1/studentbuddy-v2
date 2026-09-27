/**
 * api-npc — 学习伙伴（NPC）的 REST 封装（契约 `docs/NPC-PARTNER-SPEC.md` §7.1）。
 *
 * ★ 独立成文件与 `api-cards.ts` 同一条理由：`api.ts` 已贴「.ts ≤400 行」红线，
 *   而本组是 6 个端点 + 6 个类型。只依赖 `api-request.ts`，不反向 import `api.ts`（环断在这里）。
 *
 * ★★ **这里的类型是服务端 `routes/npc.ts`／`learning/npc.ts`／`learning/npc-party.ts` 的形状镜像，
 *   不是第二份口径**：服务端代码不进 web 的编译单元（`npm run build` 不编 server），前端拿不到那些
 *   interface，所以形状只能在这里再写一遍。真正**不双写**的是判定——伙伴的数量、位置、处境、
 *   名额门票、今天还能换几次，一律**读服务端**（它们都是跨表的派生量，前端算不了）。
 *   ⚠️ 改服务端字段时必须同步改这里：护栏是 `routes/npc.test.ts`（它锁的是服务端发出的形状）。
 */
import { request } from './api-request.js';
import type { NpcQuota } from '@sb/shared';
import type { ChestDraw } from './api-cards.js';

/** ★ 名额与门票**不在本文件定义**：它是两端共读的契约形状，定义在 `@sb/shared/npc.ts`（唯一一份） */
export type { NpcQuota };

/** 威胁：堵住伙伴的那只怪（★ 领地格不算威胁源；距离 0 = 怪就压在他那一格上，见 SPEC §5.1） */
export interface NpcThreat {
  termId: string;
  term: string;
  distance: number;
}

/** 一位伙伴（= 服务端 `NpcView`）；`distressed` 是 `threat !== null` 的布尔镜头 */
export interface NpcView {
  id: string;
  name: string;
  /** 一句人设（创建时 AI 写，降级时是本地模板） */
  bio: string;
  /** 他守的词条（也是他的锚点：`id` = `npc:<termId>`） */
  termId: string;
  term: string;
  domain: string;
  row: number;
  col: number;
  distressed: boolean;
  threat: NpcThreat | null;
}

/** `GET /api/npc`（= 服务端 `NpcState`）：一次读全，含处境结论、名额门票与可落位格 */
export interface NpcState {
  /** 名册第 0 位的名字；还没有伙伴时为 `''` */
  partnerName: string;
  npcs: NpcView[];
  tradesLeft: number;
  quota: NpcQuota;
  /** 可落位的空格（选位态高亮用）；★ 服务端给，前端不重算铺格 */
  spots: Array<{ row: number; col: number }>;
}

/** `POST /`：创建成功回**整份新状态**（名额、可落位格都变了）+ 新伙伴 id 与起名来源 */
export interface NpcCreateResult {
  state: NpcState;
  memberId: string;
  /** ★ `fallback` 时说真话："名字是本地起的，绑个模型他会自己取"（降级可以，假装没降级不行） */
  source: 'ai' | 'fallback';
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
  /** 伙伴名单 + 名额门票 + 可落位格 + 交换余额（★ 进地图页拉它不会写库） */
  state: () => request<NpcState>('/api/npc'),
  /** 创建：`row/col` = 玩家在地图上点的那一格（服务端校验 + 起名 + 落库） */
  create: (row: number, col: number) =>
    request<NpcCreateResult>('/api/npc', { method: 'POST', body: JSON.stringify({ row, col }) }),
  /** 给一位伙伴改名（空串是入参错：每位伙伴都有存下来的名字） */
  rename: (id: string, name: string) =>
    request<{ state: NpcState }>(`/api/npc/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  /** 「让他回家」：从名册里删掉（★ 真删，否则门票序号会被隐身位刷掉） */
  remove: (id: string) =>
    request<{ state: NpcState }>(`/api/npc/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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