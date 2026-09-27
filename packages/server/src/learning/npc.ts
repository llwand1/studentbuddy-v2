/**
 * learning/npc — 知识大陆上的学习伙伴（NPC）域层（契约 `docs/NPC-PARTNER-SPEC.md`）。
 *
 * 本文件只做三件事：**派生伙伴**（谁、在哪、是否遇险）、**读写他的身份**（名字 KV）、
 * **交换**（信物卡 → 同领域新词条）。AI 对话在 `npc-talk.ts`，HTTP 在 `routes/npc.ts`。
 *
 * ★★ **零迁移**：伙伴不占一行新账——位置由 `continent.ts` 的铺格 + `shared/npc.ts` 的哈希派生，
 *   身份落既有 `app_settings`，交换落既有 `chest_open`。任何"给伙伴建张表"的冲动都是走错了路。
 * ★ 位置与遇险结论**只在这里算一次**：前端不重算铺格/领地（双份口径 = 「图上画着伙伴遇险、
 *   任务清单里没有那单」的开端，判据同 `continent-view.ts` 头注）。
 * ★ 伙伴**不占格**：不进 `spreadLands` 的 `blocked`、不改 `walkable` ⇒ 走位/领地/点击分流一行未改。
 */
import { randomUUID } from 'node:crypto';
import {
  npcCapFor,
  NPC_TRADE_MIN_CARDS,
  SETTING_KEY_NPC_PARTNER,
  continentHash,
  layoutTiles,
  localDayKey,
  monsterOccupies,
  npcCountFor,
  npcDistress,
  npcTermsToNext,
  npcTradesLeft,
  normalizeNpcName,
  placeNpcs,
  worldRadiusFor,
  type NpcCandidate,
  type NpcMonster,
  type NpcPlacement,
  type NpcThreat,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { continentMap } from './continent.js';
import { cardsByTerm } from './term-cards.js';
import { drawablePool, type ChestDraw, type PoolItem } from './chest.js';

/** 伙伴对外的形状（HTTP 一行）；`threat` 非空即**遇险**（`distressed` 只是给它一个布尔镜头） */
export interface NpcView extends NpcPlacement {
  distressed: boolean;
  threat: NpcThreat | null;
}

/** `GET /api/npc` 的响应：一次读全（含遇险结论与交换余额），前端不重算任何派生量 */
export interface NpcState {
  /** 主伙伴的显示名（用户起的名字或默认名）；空库时为 `''`（§7.4 空库文案要能说出来） */
  partnerName: string;
  npcs: NpcView[];
  /** 当前**该有**几位伙伴（可能多于 `npcs.length`：空库没格可落脚，§2.1 的空库例外） */
  count: number;
  max: number;
  /** 还差几条词条多一位伙伴；已封顶为 `null`（§7.4 那句激励的数从这里来，UI 不自己算） */
  termsToNext: number | null;
  tradesLeft: number;
}

interface MapScan {
  candidates: NpcCandidate[];
  monsters: NpcMonster[];
  /** 词条总数（★ 数量派生读它，不读格子数：格子被 140 截断过） */
  terms: number;
}

/**
 * 铺一次图，分出"能落脚的地块"与"怪的本体格"。
 * ⚠️ 先过滤怪再取哈希序（§2.2）：不过滤会出现"伙伴和怪站在同一格"。
 * ★ 领地格**可以**站（已占领的格仍是 `!hasMonster`）——伙伴站在怪的地盘上正是"他遇险了"的视觉前提。
 */
function scanMap(ownerId: string | null): MapScan {
  const list = continentMap(ownerId);
  const tiles = layoutTiles(list);
  const candidates: NpcCandidate[] = [];
  const monsters: NpcMonster[] = [];
  for (const t of tiles) {
    const occupied = monsterOccupies(t.term.review.status, t.term.review_in_scope === 1);
    if (occupied) monsters.push({ termId: t.term.id, term: t.term.term, row: t.row, col: t.col });
    else {
      candidates.push({
        termId: t.term.id,
        term: t.term.term,
        domain: t.term.domain,
        row: t.row,
        col: t.col,
      });
    }
  }
  return { candidates, monsters, terms: list.length };
}

/** 读用户给主伙伴起的名字；未配过 / JSON 坏 / 名字已空 ⇒ `''`（= 用默认名，数据容错 ADR-6） */
export function loadPartnerName(ownerId: string | null): string {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_NPC_PARTNER) as { value: string } | undefined;
  if (!row) return '';
  try {
    const v = JSON.parse(row.value) as unknown;
    const name = v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? normalizeNpcName(name) : '';
  } catch {
    return '';
  }
}

/**
 * 存用户给主伙伴起的名字。**空串 = 删键回默认**（同 `resetAnswerStyle` 的手法，契约 §3）。
 * 返回归一后实际生效的名字（`''` = 已恢复默认名）。
 */
export function savePartnerName(ownerId: string | null, input: unknown): string {
  const clean = normalizeNpcName(typeof input === 'string' ? input : '');
  const owner = ownerForWrite(ownerId);
  const db = getDb();
  if (!clean) {
    db.prepare('DELETE FROM app_settings WHERE owner_id = ? AND key = ?').run(owner, SETTING_KEY_NPC_PARTNER);
    return '';
  }
  db.prepare(
    // ★ `ON CONFLICT` 的目标必须带 `owner_id`：主键是 `(owner_id, key)`，只写 `key` 会在运行时
    //   报"找不到匹配的唯一索引"（SQL 是字符串，编译期零信号，v30 迁移注释列过同型连带改动）
    `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
  ).run(owner, SETTING_KEY_NPC_PARTNER, JSON.stringify({ name: clean }));
  return clean;
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
 * 当前大陆上的伙伴（含遇险结论）。
 * ★ 名字覆盖只作用于**第 0 位**（主伙伴，契约 §3）：用户"创建"的是那一位，其余是大陆上别的居民。
 *   名字存在**单键**上而不按 `npcId` 分桶，正是为了加词换主伙伴时**它跟着「他的伙伴」走**。
 */
export function npcList(ownerId: string | null): NpcState {
  const scan = scanMap(ownerId);
  // ★ 世界半径与铺格同源（`layoutTiles` 内部也是 `worldRadiusFor(词条数)`）⇒ 上限不可能与地图大小打架
  const radius = worldRadiusFor(scan.terms);
  const count = npcCountFor(scan.terms, radius);
  const placed = placeNpcs(scan.candidates, count);
  const saved = loadPartnerName(ownerId);
  const npcs: NpcView[] = placed.map((p, i) => {
    const threat = npcDistress(p, scan.monsters);
    return {
      ...p,
      name: i === 0 && saved ? saved : p.name,
      distressed: threat !== null,
      threat,
    };
  });
  return {
    partnerName: npcs[0]?.name ?? '',
    npcs,
    count,
    max: npcCapFor(radius),
    termsToNext: npcTermsToNext(scan.terms, radius),
    tradesLeft: npcTradesLeft(tradesUsedToday(ownerId)),
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

/** 遇险伙伴 id 集（`isDone` 的判据：不在里面 = 已脱险 = 那单完成） */
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