/**
 * routes/cards — 卡牌／宝箱／任务清单的 HTTP 出口（契约 `docs/TERM-CARDS-SPEC.md` §7）。
 *
 * ★ **独立前缀 `/api/cards`，不挂进 `/api/terms`**：那条路由是词条的**生命周期**（增删改查、
 *   复习范围），这里是**玩法读数**（卡数、钥匙、清单）。两批端点的写侧权力不同——
 *   那边改库里的事实，这边只有一条"抽到并收下"会写库。混在一起后想给玩法侧单独限流／
 *   灰度就没有落点。
 *
 * ★★ **`GET /state` 一次回全，且不接受领域／关键词过滤**（两个决定，各有各的理由）：
 *   ① 面板要同时画卡墙、钥匙、清单、待审候选四块，分四个请求就会出现"四块来自四个瞬间"——
 *      而这几块之间**有等式**（`summary.totalCards` 是 `wall` 各项之和、清单里的进度来自同一份
 *      `cardsByTerm`）。拆开取数没有任何一侧能自证一致，前端只能挑一个瞬间去信（B-007 那一族）。
 *   ② 一旦支持过滤，`summary` 就成了"过滤后的汇总"，而它旁边的文案是"全库 X 条"——
 *      同一个数在两种视角下叫同一个名字。过滤交给前端（≤500 行，本来就在响应里）。
 *
 * ★ 派生值**每次读都重算**（`cardsByTerm`／`chestState`／`listTasks`），库里没有一行计数器。
 *   所以这里不需要"改完词条要记得刷新缓存"那一类代码，也没有可以对账的中间表——
 *   这既是契约 §1 边界① 的兑现，也是 §11 判据 1「SQL 手工数一遍能对上」成立的原因。
 * ⚠️ `chestState` 是**零写**的（跨日归零只发生在读侧），所以"每次进首页都拉一次 `/state`"
 *   不会变成"每次进首页都写一行"。真写只有三条路：开盒／收卡／裁决候选。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { cardsChannel } from '@sb/shared';
import { subscribe, snapshot } from '../chat/sse-bus.js';
import { ownerIdOf } from '../auth/ownership.js';
import { listTerms } from '../learning/terms.js';
import { cardsByTerm, cardsLogSince, summarizeCards, type CardWallSummary, type TermCards } from '../learning/term-cards.js';
import { acceptDraw, chestState, openChest, type ChestState } from '../learning/chest.js';
import { domainOrdinals } from '../learning/domains.js';
import { completeTask, listTasks, type StudyTask } from '../learning/tasks.js';
import { decideCandidate, listCandidates, type PoolCandidate } from '../learning/pool-candidates.js';

export const cardsRouter = Router();

/** 卡墙上的一行：词条本体 + 它的全部卡牌读数 */
export interface CardWallRow {
  termId: string;
  term: string;
  definition: string;
  domain: string;
  /** ★ 现算的**有效**复习范围（继承领域默认的那条也算进来），前端不许自己 COALESCE */
  inScope: boolean;
  /**
   * 领域在册序号（取色键，见 `domains.ts:domainOrdinals` 的注释）；`null` = 该域名没登记过
   * ⇒ 前端走中性档。★ 前端**拿不到**这个数就只能按名字或按 count 排序取色，那两个都会漂。
   */
  domIndex: number | null;
  card: TermCards;
}

export interface CardsStateResponse {
  summary: CardWallSummary;
  wall: CardWallRow[];
  /** 卡牌统计起点日（契约 §7.4）：UI 必须显示「统计自 <日期>」，否则口径 1 的差异像少算 */
  logSince: string | null;
  chest: ChestState;
  tasks: StudyTask[];
  /** 待人工校对的候选（补池单就地裁决用）。★ 只列 `pending`——已定论的不是待办 */
  candidates: PoolCandidate[];
}

cardsRouter.get('/state', (req: Request, res: Response) => {
  const ownerId = ownerIdOf(req);
  // ★ 一次 `cardsByTerm`，两处用（墙与汇总）。跑两遍是同一份三相关子查询的聚合，白付一倍。
  const byTerm = cardsByTerm(ownerId);
  const terms = listTerms(undefined, undefined, ownerId);
  const ordinals = domainOrdinals(ownerId);
  const wall: CardWallRow[] = [];
  for (const t of terms) {
    const card = byTerm.get(t.id);
    // ★ 唯一能缺读数的形状是"两次查询之间词条被删了"——那这一行确实没有卡可画，跳过它，
    //   也不给它编一个 0 卡读数（`cardsByTerm` 的口径 3 说得很清楚：任何词条恒 ≥1 张）。
    if (!card) continue;
    wall.push({
      termId: t.id,
      term: t.term,
      definition: t.definition,
      domain: t.domain,
      inScope: t.review_in_scope === 1,
      domIndex: ordinals.get(t.domain) ?? null,
      card,
    });
  }
  res.json({
    // ★ 汇总吃的是**墙上的那些行**而不是 `byTerm` 全量：文件头承诺了「`summary.totalCards`
    //   是 `wall` 各项之和」这条等式，上面跳过的行一旦存在，取全量就会让它差一。
    summary: summarizeCards(wall.map((w) => w.card)),
    wall,
    logSince: cardsLogSince(ownerId),
    chest: chestState(ownerId),
    tasks: listTasks(ownerId),
    candidates: listCandidates(ownerId, 'pending'),
  } satisfies CardsStateResponse);
});

/**
 * 开一次盒。★ 失败**不返回 200 + 假数据**：三种原因对用户是三句话
 *   （没钥匙／开满了／池子空了），而第三句是最该被听见的那句——它意味着今天不再有新的词。
 */
cardsRouter.post('/chest/open', (req: Request, res: Response) => {
  const ownerId = ownerIdOf(req);
  const r = openChest(ownerId);
  if (!r.ok) {
    const messages: Record<typeof r.reason, string> = {
      exhausted: '今天的免费次数用完了，完成一单任务可以再开一次',
      capped: '今天已经开到上限了，明天请早',
      empty: '词池里没有你没见过的新词了——审一条候选，或者等它变多',
    };
    // ★ 带上**当下的钥匙账**：按钮禁用态要靠它（`left.left === 0` 且 `left.reason` 决定文案），
    //   否则前端只能再发一次 `/state` 才知道自己为什么点不动。
    res.status(409).json({ error: messages[r.reason], code: `CHEST_${r.reason.toUpperCase()}`, chest: chestState(ownerId) });
    return;
  }
  res.json({ draw: r.draw, state: r.state });
});

/** 收下抽到的卡。`review=true` ⇒ 同时纳入复习范围（面板给两枚钮，不替用户默认勾选） */
cardsRouter.post('/chest/accept', (req: Request, res: Response) => {
  const { openId, review } = req.body as { openId?: unknown; review?: unknown };
  if (typeof openId !== 'string' || !openId) {
    res.status(400).json({ error: 'openId 必填' });
    return;
  }
  // ★ 真布尔校验（同 `/api/coach/review` 那条）：脏值 `'false'` 会被 `||` 当成真，
  //   用户点的是「只收下」却把词条塞进了复习队列——静默错语义比 400 难查得多。
  if (typeof review !== 'boolean') {
    res.status(400).json({ error: 'review 必须是布尔值' });
    return;
  }
  const r = acceptDraw(ownerIdOf(req), openId, review);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ termId: r.termId, card: r.cards, inScope: r.inScope });
});

/**
 * 点「我做完了」。★ **判定不在这里**——这一枚钮只是催一次服务端重算，
 * 满足判据才发钥匙。否则一个 POST 就能刷满钥匙，宝箱当天脱钩（`tasks.ts:completeTask`）。
 */
cardsRouter.post('/tasks/:id/done', (req: Request, res: Response) => {
  const r = completeTask(ownerIdOf(req), req.params.id ?? '');
  if (!r.ok) {
    res
      .status(r.reason === 'unknown' ? 404 : 409)
      .json({ error: r.reason === 'unknown' ? '这一单不存在' : '条件还没到位，完成不了这一单', code: r.reason });
    return;
  }
  res.json({ ok: true, keyGranted: r.keyGranted });
});

/** 裁决一条词池候选（通过／驳回）。★ 驳回**同样**算完成补池单——那一单要的是裁决（契约 §5） */
cardsRouter.post('/pool/:id/decide', (req: Request, res: Response) => {
  const { approved } = req.body as { approved?: unknown };
  if (typeof approved !== 'boolean') {
    res.status(400).json({ error: 'approved 必须是布尔值' });
    return;
  }
  const r = decideCandidate(ownerIdOf(req), req.params.id ?? '', approved);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ candidate: r.candidate, keysGranted: r.keysGranted });
});

/** 断线重连后的快照对齐（与 `coach`/`chat` 的 `/live` 同手法，SSE-CONTRACT「断线恢复」） */
cardsRouter.get('/live', (req: Request, res: Response) => {
  res.json({ events: snapshot(cardsChannel(ownerIdOf(req))) });
});

/**
 * 卡牌频道的事件流。★ 频道键 = `cardsChannel(自己的 owner)`，由服务端从会话推导 ⇒
 *   订阅者拿不到别人的键（与 `coachRouter.get('/stream')` 同一条隔离）。
 * ⚠️ 前端要在**累计 3 次 `reconnecting` 失败后关掉流改轮询 `/state`**（契约 §7.3，
 *   Android 微信 X5 的 EventSource 不稳，`PkApp.tsx` 的既有形状）——这条降级在前端，不在这里。
 */
cardsRouter.get('/stream', (req: Request, res: Response) => {
  const since = Number(req.query.since ?? 0) || 0;
  subscribe(cardsChannel(ownerIdOf(req)), res, since);
});
