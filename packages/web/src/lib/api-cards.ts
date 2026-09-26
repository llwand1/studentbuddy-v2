/**
 * api-cards — 卡牌／宝箱／任务清单的 REST 封装（契约 `docs/TERM-CARDS-SPEC.md` §7）。
 *
 * ★ 独立成文件与 `api-terms-review.ts`／`api-terms-domain.ts` 同一条理由：`api.ts` 已贴
 *   「.ts ≤400 行」红线，而本组是 5 个端点 + 7 个类型。只依赖 `api-request.ts`，不反向 import
 *   `api.ts`（环断在这里，同前例）。
 *
 * ★★ **这里的类型是服务端 `routes/cards.ts` 的形状镜像，不是第二份口径**：
 *   服务端代码不进 web 的编译单元（`npm run build` 不编 server），前端拿不到那些 interface，
 *   所以类型只能在这里再写一遍。真正**不双写**的是判定逻辑——星位、稀有度、进度、今天还能
 *   开几次，一律向 `@sb/shared` 的纯函数要（`starOf`／`rarityOf`／`nextStarProgress`／`opensLeft`），
 *   而**卡数本身永远读服务端**（它是两张流水的聚合，前端算不了：流水不在浏览器里）。
 *   ⚠️ 改服务端字段时必须同步改这里：TS 结构一致 ≠ 有人校验过，本仓的护栏是
 *   `routes/cards.test.ts`（它锁的是服务端发出的形状）＋ 这里的字段注释指名出处。
 */
import { ApiError, request } from './api-request.js';
import type { CardRarity } from '@sb/shared';

/** 一条词条的卡牌读数（= 服务端 `learning/term-cards.ts` 的 `TermCards`） */
export interface CardReading {
  termId: string;
  /** 提及流水条数 */
  mentions: number;
  /** **不同**复习日数（同日只算一张） */
  reviewDays: number;
  /** 宝箱**收下**次数（抽到没要的不算） */
  chestGrants: number;
  /** = mentions + reviewDays + chestGrants + 1（建卡那张） */
  cards: number;
  star: number;
  progress: { star: number; nextStar: number | null; needed: number | null; pct: number };
  rarity: CardRarity;
}

/** 卡墙一行（= 服务端 `CardWallRow`） */
export interface CardWallRow {
  termId: string;
  term: string;
  definition: string;
  domain: string;
  inScope: boolean;
  /** 领域在册序号（取色键）；`null` = 该域名未登记 ⇒ 前端走中性档 */
  domIndex: number | null;
  card: CardReading;
}

/** 卡墙汇总（= 服务端 `CardWallSummary`；`byStar` 下标即星级，长度 9） */
export interface CardWallSummary {
  totalTerms: number;
  totalCards: number;
  byStar: number[];
  byRarity: Record<CardRarity, number>;
  almostThere: number;
}

/** 一次开盒的结果（= 服务端 `ChestDraw`；`cost` 在回读待处理那张时是 null） */
export interface ChestDraw {
  openId: string;
  term: string;
  domain: string;
  definition: string;
  source: 'seed' | 'candidate';
  cost: 'free' | 'earned' | null;
}

/** 钥匙账读数（= 服务端 `ChestState`；`left` 即 shared `opensLeft` 的返回） */
export interface ChestState {
  day: string;
  freeUsed: number;
  freeLeft: number;
  earnedKeys: number;
  openedToday: number;
  left: { left: number; reason: 'ok' | 'exhausted' | 'capped' };
  poolLeft: number;
  pending: ChestDraw | null;
}

/** 任务清单一行（= 服务端 `StudyTask`；`kind` 三值见 `learning/tasks.ts`） */
export interface StudyTask {
  id: string;
  kind: 'advance' | 'unstall' | 'review_pool';
  title: string;
  why: string;
  termId: string | null;
  targetStar: number | null;
  done: boolean;
  createdAt: string;
  doneAt: string | null;
}

/** 词池候选（= 服务端 `PoolCandidate`；`source==='ai'` 时 UI 要标「AI 生成，待人工校对」） */
export interface PoolCandidate {
  id: string;
  term: string;
  domain: string;
  definition: string;
  aliases: string[];
  status: 'pending' | 'approved' | 'rejected';
  source: string;
  created_at: string;
  decided_at: string | null;
}

/** `GET /api/cards/state` 的响应（一次拿全，四块来自同一个瞬间，契约 §7 文件头②） */
export interface CardsStateResponse {
  summary: CardWallSummary;
  wall: CardWallRow[];
  /** 卡牌统计起点日：UI 必须显示「统计自 <日期>」，否则「提及 20 次、卡数 8 张」看着像少算 */
  logSince: string | null;
  chest: ChestState;
  tasks: StudyTask[];
  candidates: PoolCandidate[];
}

export interface ChestOpenResult {
  draw: ChestDraw;
  state: ChestState;
}

export interface ChestAcceptResult {
  termId: string;
  card: CardReading | null;
  inScope: boolean;
}

/** 开盒被拦的三种原因（服务端 409 带的码，文案由服务端给，前端不再编一套） */
export type ChestFailCode = 'CHEST_EXHAUSTED' | 'CHEST_CAPPED' | 'CHEST_EMPTY';

export interface ChestOpenFailure {
  error: string;
  code: ChestFailCode;
  chest: ChestState;
}

const FAIL_CODES: ChestFailCode[] = ['CHEST_EXHAUSTED', 'CHEST_CAPPED', 'CHEST_EMPTY'];

/**
 * 把 `/chest/open` 抛出的 `ApiError` 收窄成可读的失败体。
 * ★ 返回 `null` 表示"这不是一个可解释的开盒失败"（网络错、5xx、会话过期……），
 *   调用方必须走通用错误分支——把未知错误当成"钥匙用完了"显示，是比不显示更糟的谎。
 */
export function asChestOpenFailure(e: unknown): ChestOpenFailure | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = e.body as Partial<ChestOpenFailure> | undefined;
  if (!b || typeof b.error !== 'string' || !FAIL_CODES.includes(b.code as ChestFailCode) || !b.chest) return null;
  return { error: b.error, code: b.code as ChestFailCode, chest: b.chest };
}

export const cardsApi = {
  /** 面板一次读全（★ 零写：跨日归零发生在读侧，进首页拉它不会写库） */
  state: () => request<CardsStateResponse>('/api/cards/state'),
  /** 开一次盒：200 → 抽到的卡；409 → 用 `asChestOpenFailure` 读原因 */
  openChest: () => request<ChestOpenResult>('/api/cards/chest/open', { method: 'POST', body: JSON.stringify({}) }),
  /** 收下这张卡。`review` 必须是真布尔（服务端 400 校验脏值 `'false'`） */
  acceptDraw: (openId: string, review: boolean) =>
    request<ChestAcceptResult>('/api/cards/chest/accept', {
      method: 'POST',
      body: JSON.stringify({ openId, review }),
    }),
  /** 「我做完了」：★ 判定在服务端，不满足返 409 `not_yet`（这一枚钮只是催一次重算） */
  completeTask: (id: string) =>
    request<{ ok: true; keyGranted: boolean }>(`/api/cards/tasks/${encodeURIComponent(id)}/done`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /** 裁决一条词池候选。★ 驳回同样算完成补池单——那一单要的是"裁决"这个动作 */
  decideCandidate: (id: string, approved: boolean) =>
    request<{ candidate: PoolCandidate; keysGranted: number }>(
      `/api/cards/pool/${encodeURIComponent(id)}/decide`,
      { method: 'POST', body: JSON.stringify({ approved }) },
    ),
};
