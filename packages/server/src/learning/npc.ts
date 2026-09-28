/**
 * learning/npc — 学习伙伴的**视图层**：他们的处境（在哪／守哪条／是否遇险）与交换
 * （契约 `docs/NPC-PARTNER-SPEC.md`）。
 *
 * 本文件只做两件事：① **读花名册并算出处境**（含求救单的读口）；② **交换**（信物卡 → 同领域新词条）。
 * 花名册的读写与创建／改名／解散在 `npc-party.ts`，起名在 `npc-genesis.ts`，AI 对话在 `npc-talk.ts`，
 * HTTP 在 `routes/npc.ts`。
 *
 * ★★ **零迁移**：伙伴不占一行新账——花名册落既有 `app_settings`，求救单落既有 `study_task`，
 *   交换落既有 `chest_open`。任何"给伙伴建张表"的冲动都是走错了路（§0 红线）。
 * ★★ 2026-09-27（玩家创建制）：位置**改为存库**（玩家点的那一格）。存得起靠
 *   **有符号固定中心坐标**——世界半径只增不减 ⇒ 已存坐标永不失效。
 * ★ 处境**只在这里算一次**：前端不重算铺格/领地（双份口径 = 「图上画着伙伴遇险、任务清单里没有那单」）。
 * ★ 伙伴**不占格**：不进 `spreadLands` 的 `blocked`、不改 `walkable` ⇒ 走位/领地/点击分流一行未改。
 */
import { randomUUID } from 'node:crypto';
import {
  NPC_TRADE_MIN_CARDS,
  continentHash,
  localDayKey,
  npcDistress,
  npcTradesLeft,
  type NpcPartyMember,
  type NpcSpot,
  type NpcThreat,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { scanMap } from './npc-map.js';
import { npcQuotaFor, syncParty, type NpcQuota } from './npc-party.js';
import { moveParty } from './npc-move.js';
import { cardsByTerm } from './term-cards.js';
import { drawablePool, type ChestDraw, type PoolItem } from './chest.js';

/** 伙伴对外的形状（HTTP 一行）；`threat` 非空即**遇险**（`distressed` 只是给它一个布尔镜头） */
export interface NpcView extends NpcPartyMember {
  /** 他守的那条词条名（锚点词条被删时他会被 `syncParty` 出册 ⇒ 这里几乎不会缺） */
  term: string;
  domain: string;
  distressed: boolean;
  threat: NpcThreat | null;
}

/** `GET /api/npc` 的响应：一次读全（含遇险结论、名额门票、可落位格），前端不重算任何派生量 */
export interface NpcState {
  /** 名册第 0 位的名字（还没有伙伴时 `''`） */
  partnerName: string;
  npcs: NpcView[];
  tradesLeft: number;
  quota: NpcQuota;
  /** 可落位的空格（选位态高亮用）；★ 由服务端算，前端不重算铺格/领地 */
  spots: NpcSpot[];
  /**
   * 全部词条格（伙伴会游走那次改动新增）。
   * ★ 主动搭话要知道「他此刻站的这一格是哪条词条」——话题由脚下这块地决定（§11）。
   *   放进同一次响应而不是另开一个口：两处各铺一遍图，就会出现"图上站在 A、气泡在聊 B"。
   */
  cells: Array<{ termId: string; term: string; domain: string; row: number; col: number }>;
}

/** 今天已经交换过几次：★ 读既有 `chest_open` 的 `source_kind + opened_day`，零迁移拿到日级闸门 */
export function tradesUsedToday(ownerId: string | null, now = new Date()): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM chest_open
        WHERE owner_id = ? AND source_kind = 'npc' AND opened_day = ?`,
    )
    .get(ownerForWrite(ownerId), localDayKey(now)) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 当前大陆上的伙伴（含处境与名额读数）。
 * ★ 名字与位置**一律读花名册**（玩家创建制）：这里不再有"第 0 位用另一个键覆盖名字"那套——
 *   每位伙伴都有自己的名字（创建时 AI 起，可改），名册就是唯一真相。
 */
export function npcList(ownerId: string | null): NpcState {
  const scan = scanMap(ownerId);
  // ★★ 先自愈迁移（旧库补册、锚点没了的出册），**再**把位置推进到此刻
  //   （`moveParty` 内部会重读一次名册，所以顺序不能反：反了就是拿旧册去走位）。
  syncParty(ownerId, scan);
  const members = moveParty(ownerId, scan);
  // ★ 锚点词条的名字/领域从**同一次扫描**里取（两个桶合起来就是全部词条格）：不额外查库、不铺第二遍图
  const where = new Map<string, { term: string; domain: string }>();
  for (const c of scan.candidates) where.set(c.termId, { term: c.term, domain: c.domain });
  for (const m of scan.monsters) where.set(m.termId, { term: m.term, domain: m.domain });

  const npcs: NpcView[] = members.map((m) => {
    const threat = npcDistress(m, scan.monsters);
    const info = where.get(m.termId);
    return {
      ...m,
      term: info?.term ?? '这条词条',
      domain: info?.domain ?? '',
      distressed: threat !== null,
      threat,
    };
  });
  // ★ 可落位格要避开的是**家**而不是当前站位：伙伴会走，拿会动的位置当"占用"会让
  //   绿框每 45 秒闪一下（明明那一格没人安家）。一格只许安一个家，这才是安置的约束。
  const takenHomes = new Set(members.map((m) => `${m.homeRow},${m.homeCol}`));
  const takenTerms = new Set(members.map((m) => m.termId));
  const spots: NpcSpot[] = scan.candidates
    .filter((c) => !takenHomes.has(`${c.row},${c.col}`) && !takenTerms.has(c.termId))
    .map((c) => ({ row: c.row, col: c.col }));

  return {
    partnerName: npcs[0]?.name ?? '',
    npcs,
    tradesLeft: npcTradesLeft(tradesUsedToday(ownerId)),
    // ★ 用**真在册数**（刚 `syncParty` 过）而不是那份便宜口径：两条路径在同一次响应里必须同一个数
    quota: npcQuotaFor(ownerId, members.length),
    spots,
    cells: [...scan.candidates, ...scan.monsters].map((c) => ({
      termId: c.termId,
      term: c.term,
      domain: c.domain,
      row: c.row,
      col: c.col,
    })),
  };
}

/** 遇险伙伴（派单用）：与 `npcList` 同一份派生量，绝不另算一遍 */
export interface DistressedNpc {
  id: string;
  name: string;
  /** 威胁怪本体所锚定的词条——答对它 = 怪散 = 脱险 */
  threatTermId: string;
  threatTerm: string;
}

export function distressedNpcs(ownerId: string | null): DistressedNpc[] {
  const out: DistressedNpc[] = [];
  for (const n of npcList(ownerId).npcs) {
    if (!n.threat) continue;
    out.push({ id: n.id, name: n.name, threatTermId: n.threat.termId, threatTerm: n.threat.term });
  }
  return out;
}

/** 遇险伙伴 id 集（`isDone` 的判断标准：不在里面 = 已脱险 = 那单完成） */
export function distressedNpcIds(ownerId: string | null): Set<string> {
  return new Set(distressedNpcs(ownerId).map((d) => d.id));
}

/**
 * 落一行"已抽到但**没花钥匙**"的流水（交换专用，契约 §6）。
 *
 * ★ 为什么在**这里**而不是 `learning/chest.ts`：那是"扣钥匙开盒"的写规则，这是"拿信物交换"的
 *   写规则——同一张 `chest_open`，两套付账方式（那份文件也因此守住了 400 行红线）。
 * ★★ 必须写 `pool_slug`：它是抽卡**去重集**的键（`drawablePool` 靠它判"本人已抽过"），
 *   不写则用户明天还会被换到同一条词。
 * ★ **不动 `chest_keys`**：不扣免费次数、不扣赚来的钥匙 ⇒ 每日闸门只能落在
 *   「`source_kind='npc'` + `opened_day` 的行数」上（`tradesUsedToday`）。这正是 §6.3
 *   「信物无法被消耗」那条如实记下的代价。
 * ★ `cost: null` 不是欠数据：确实没有任何一本钥匙账被动过，编一个 'free' 会让面板显示假的"−1"。
 */
function grantTradeDraw(ownerId: string | null, item: PoolItem, now: Date): ChestDraw {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO chest_open (id, owner_id, opened_day, source_kind, pool_slug, pool_term, pool_domain, pool_definition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ownerForWrite(ownerId),
      localDayKey(now),
      'npc',
      item.slug,
      item.entry.term,
      item.entry.domain,
      item.entry.definition,
    );
  return {
    openId: id,
    term: item.entry.term,
    domain: item.entry.domain,
    definition: item.entry.definition,
    source: 'npc',
    cost: null,
  };
}

export type NpcTradeResult =
  | { ok: true; draw: ChestDraw; domainMatched: boolean; tradesLeft: number }
  | { ok: false; status: number; error: string };

/**
 * 交换：拿一条自己的信物卡，换一条**同领域没见过**的新词条（契约 §6）。
 *
 * ★ **不花钥匙、不落信物账**：卡是流水派生的**读数**不是道具（`TERM-CARDS-SPEC` §1 边界①），
 *   扣它必然要么伪造流水、要么开旁路账，两者都被明令禁止。⇒ 真实代价只有两道闸门：
 *   信物门槛 `cards >= 2`（★1 以上）＋ 每日 2 次。文案必须照实说（`NPC_TRADE_COST_LINE`）。
 * ★★ 信物**不落** `pool_slug`：那是抽卡去重集的键，兼存会破坏 `drawablePool` 的去重（§6.2 的实测纠正）。
 */
export function npcTrade(
  ownerId: string | null,
  npcId: string,
  termId: string,
  now = new Date(),
): NpcTradeResult {
  const npc = npcList(ownerId).npcs.find((n) => n.id === npcId);
  if (!npc) return { ok: false, status: 404, error: '这位伙伴不在大陆上，刷新一下地图' };

  // ★ 三种拒绝各一句（§6.4）：压成一句"换不了"，用户就不知道是没这张卡、还是今天换满了
  const owner = ownerForWrite(ownerId);
  const trust = getDb()
    .prepare('SELECT domain FROM term_library WHERE id = ? AND owner_id = ?')
    .get(termId, owner) as { domain: string } | undefined;
  if (!trust) return { ok: false, status: 409, error: '这条信物不在你的词条库里' };
  const cards = cardsByTerm(ownerId).get(termId);
  if (!cards || cards.cards < NPC_TRADE_MIN_CARDS) {
    return { ok: false, status: 409, error: '这条词条还没到 ★1，拿不出手当信物' };
  }

  const used = tradesUsedToday(ownerId, now);
  if (npcTradesLeft(used) <= 0) return { ok: false, status: 409, error: '今天已经换过两次了，明天再来' };

  const pool = drawablePool(ownerId);
  if (pool.length === 0) {
    return { ok: false, status: 409, error: '词池里没有你没见过的新词了——审一条候选，或者等它变多' };
  }

  // ★ 确定性选词（§6.4）：**信物同领域**优先，按 `continentHash(npcId|slug)` 升序取第一。
  //   不随机 ⇒ 同一伙伴同一次选择稳定、可单测、可复现（与宝箱的 `Math.random` 是两种不同取舍：
  //   宝箱要"抽"的手感，交换要"他挑了哪条"的确定性）。
  const same = pool.filter((p) => p.entry.domain === trust.domain);
  const domainMatched = same.length > 0;
  const ranked = [...(domainMatched ? same : pool)].sort((a, b) => {
    const ha = continentHash(`${npcId}|${a.slug}`);
    const hb = continentHash(`${npcId}|${b.slug}`);
    if (ha !== hb) return ha - hb;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const pick = ranked[0] as PoolItem;
  const draw = grantTradeDraw(ownerId, pick, now);
  return { ok: true, draw, domainMatched, tradesLeft: npcTradesLeft(used + 1) };
}

/**
 * 按**领域**换一条新词（对话式交换的入口，`NPC-PARTNER-SPEC` §13）。
 *
 * ★★ 2026-09-28「原住民」那次改动把交换从**下拉框选信物**改成**对话里说一句**。
 *   语义上的关键一步：信物**本来就只是用来定领域的**（§6.3 钉死了"卡是读数不是道具，
 *   给出信物没有真实损耗"）——既然它不被消耗、只决定方向，那么让用户从下拉框里挑一张，
 *   就是**为了一个纯参数去点三下**。改成：领域 = **伙伴此刻站的那一格**，
 *   信物 = 这个领域里你最熟的那条（服务端自己挑）。
 *   ⇒ 两道真实闸门**一个没松**：熟度（该领域得有 ★1 以上的卡）＋ 每日 2 次。
 * ★ 挑信物用「卡最多 → termId 升序」的**确定性**排序：同一轮对话重试不会换一张，可单测。
 */
export function npcTradeInDomain(
  ownerId: string | null,
  npcId: string,
  domain: string,
  now = new Date(),
): NpcTradeResult {
  const owner = ownerForWrite(ownerId);
  const rows = getDb()
    .prepare('SELECT id FROM term_library WHERE owner_id = ? AND domain = ?')
    .all(owner, domain) as Array<{ id: string }>;
  const byTerm = cardsByTerm(ownerId);
  const eligible = rows
    .map((r) => ({ id: r.id, cards: byTerm.get(r.id)?.cards ?? 0 }))
    .filter((r) => r.cards >= NPC_TRADE_MIN_CARDS)
    .sort((a, b) => (b.cards !== a.cards ? b.cards - a.cards : a.id < b.id ? -1 : 1));
  const token = eligible[0];
  if (!token) {
    return {
      ok: false,
      status: 409,
      error: `「${domain}」这块地上你还没有 ★1 以上的词条——先把这个领域练熟一条，才换得动。`,
    };
  }
  return npcTrade(ownerId, npcId, token.id, now);
}
