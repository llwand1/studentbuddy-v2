/**
 * learning/npc-party — 学习伙伴的**花名册**：存哪几位、创建、改名、解散（契约 `docs/NPC-PARTNER-SPEC.md` §2/§3）。
 *
 * ★★ **零迁移**：花名册落既有 `app_settings` 的 `npc_party` 键（值 = `{ members: NpcPartyMember[] }`），
 *   不建表、不加列、不加索引。任何"给伙伴建张表"的冲动都是走错了路（§0 红线）。
 *
 * ★★ 2026-09-27 批 12（玩家创建制）**改口径**：老板原话「npc 不要那么多，由玩家来创建比较好」。
 *   旧口径的"每 8 条词条自动多一位"整套退役 ⇒ **位置改为存库**（玩家点的那一格）。
 *   位置存得起，靠的是批 11 的**有符号固定中心坐标**：世界半径只增不减 ⇒ 已存坐标永不失效。
 *   换成"旧坐标 = 世界左上角起算"的老口径，这张表一加词就整体失效——这就是它必须存下来的代价。
 *
 * ★ 本文件与视图层（`npc.ts`）的分工：这里只管**谁在册 + 能不能再创建**（会写库），
 *   `npc.ts` 只管**他们的处境**（在哪／守哪条／是否遇险）与交换（会写 `chest_open`）。
 *   分开住的两条理由：① `npc.ts` 已贴 400 行红线；② 写侧权力不同（这里是名册，那边是流水）。
 */
import {
  NPC_TRADE_MIN_CARDS,
  SETTING_KEY_NPC_PARTY,
  continentHash,
  npcCapFor,
  npcIdOf,
  npcNameFromPool,
  npcTasksRequiredFor,
  npcTemplateBio,
  normalizeNpcName,
  parseNpcParty,
  worldRadiusFor,
  type NpcPartyMember,
  // ★ `NpcQuota` 的形状定义在 `@sb/shared`（两端都要读它：地图页说"能不能创建"、任务清单说
  //   "还差几单"）；本文件只负责**算**它。定义与计算分家，是为了不让 web 再写一份镜像。
  type NpcQuota,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { cardsByTerm } from './term-cards.js';
import { scanMap, type MapScan } from './npc-map.js';
import { generateNpcIdentity } from './npc-genesis.js';

// ★ 再导出一次：调用方（`routes/cards.ts`）只要 import 本文件，就能同时拿到**算法**与**形状**，
//   不必再从 `@sb/shared` 引一遍（`@sb/shared` 与本文件在同一段 import 里出现两次也会踩 no-duplicates）
export type { NpcQuota };

/** 写侧结果（改名／解散）：失败必带一句人话（ADR-5 禁静默） */
export type NpcWriteResult = { ok: true } | { ok: false; status: number; error: string };

export type NpcCreateResult =
  | { ok: true; member: NpcPartyMember; source: 'ai' | 'fallback' }
  | { ok: false; status: number; error: string };

/** 读花名册原文；`null` = **这个库还没初始化过**（自愈迁移的判据，见 `syncParty`） */
function readPartyRaw(ownerId: string | null): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_NPC_PARTY) as { value: string } | undefined;
  return row ? row.value : null;
}

/** 花名册（**不触发迁移、不铺图**）：给改名／解散这类"只要名单"的路径用 */
export function loadParty(ownerId: string | null): NpcPartyMember[] {
  const raw = readPartyRaw(ownerId);
  return raw === null ? [] : parseNpcParty(raw);
}

/**
 * 写花名册。**永远写、从不删键**：键在 = "这个库已经初始化过"。
 * ★ 若空册时删键，自愈迁移会在下一次读到时**又把开局伙伴放回来**——"让他回家"当场失效。
 */
export function saveParty(ownerId: string | null, members: readonly NpcPartyMember[]): void {
  getDb()
    .prepare(
      // ★ `ON CONFLICT` 的目标必须带 `owner_id`：主键是 `(owner_id, key)`，只写 `key` 会在运行时
      //   报"找不到匹配的唯一索引"（SQL 是字符串，编译期零信号）
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_NPC_PARTY, JSON.stringify({ members }));
}

/** 词条数（名额上限与"有没有地"都读它） */
export function termCountFor(ownerId: string | null): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM term_library WHERE owner_id = ?')
    .get(ownerForWrite(ownerId)) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 已完成任务数：★ 既有 `study_task` 的现算，零新表、零新列（门票的账本就这一句） */
export function doneTaskCountFor(ownerId: string | null): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM study_task WHERE owner_id = ? AND status = 'done'`)
    .get(ownerForWrite(ownerId)) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 现有伙伴数（**便宜口径**：只读 `app_settings` + 两条 COUNT，不铺图）。
 * ★ 键缺失（旧库）时不能报 0：`syncParty` 会在下次读到地图时把**开局伙伴**固化下来，
 *   所以"该有的数"是 1；报 0 会让任务清单说"可创建 1 位"、而地图上立刻已经有 1 位
 *   ——两条记录互相打脸（`TERM-CARDS-SPEC` §5 那条学费的同类）。
 * ★ 库里还没词条时才是 0：此时迁移会把**空册**固化，第一位由玩家无条件创建。
 */
export function partyCountFor(ownerId: string | null): number {
  const raw = readPartyRaw(ownerId);
  if (raw !== null) return parseNpcParty(raw).length;
  return termCountFor(ownerId) > 0 ? 1 : 0;
}

/**
 * 名额与门票的读数。★ 三条判据各一句人话，**不许压成一句"暂时不能创建"**：
 *   用户点不动时必须知道是"还差几单任务"、"名额满了"还是"库里还没词条"。
 */
export function npcQuotaFor(ownerId: string | null, count: number): NpcQuota {
  const terms = termCountFor(ownerId);
  const max = npcCapFor(worldRadiusFor(terms));
  const doneTasks = doneTaskCountFor(ownerId);
  const needTasks = npcTasksRequiredFor(count + 1);
  let blockedBy = '';
  if (terms === 0) {
    blockedBy = '大陆上还没有词条——伙伴得有块地守，先去「词条」页加几条。';
  } else if (count >= max) {
    blockedBy = `这块大陆最多站 ${max} 位伙伴——先让一位回家，位置就空出来了。`;
  } else if (doneTasks < needTasks) {
    blockedBy = `还差 ${needTasks - doneTasks} 单任务，就能再创建一位伙伴。`;
  }
  return { count, max, doneTasks, needTasks, canCreate: blockedBy === '', blockedBy };
}

/** 名额与门票的读数（按名册现算；`GET /api/cards/state` 那条便宜路径走这个） */
export function npcQuota(ownerId: string | null): NpcQuota {
  return npcQuotaFor(ownerId, partyCountFor(ownerId));
}

/**
 * 自愈迁移：**旧库那一位**就地固化。
 * ★ 定序原样保留旧口径 `placeNpcs` 的 `continentHash('npc|' + termId)` 升序（同值按 termId 升序）——
 *   这样迁移下来的那一位，与升级前用户在地图上看到的是**同一位**（位置一致，用户无感）。
 * ★ 没有可落位的地块 ⇒ `null`（有词条却没一块没冒怪的地：留着不写，等下次再试，§2.1 空库例外）。
 */
function starterMember(scan: MapScan): NpcPartyMember | null {
  const ranked = [...scan.candidates].sort((a, b) => {
    const ha = continentHash(`npc|${a.termId}`);
    const hb = continentHash(`npc|${b.termId}`);
    if (ha !== hb) return ha - hb;
    return a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0;
  });
  const first = ranked[0];
  if (!first) return null;
  return {
    id: npcIdOf(first.termId),
    name: npcNameFromPool(first.termId),
    bio: npcTemplateBio(first.term),
    termId: first.termId,
    row: first.row,
    col: first.col,
  };
}

/**
 * 读花名册（**会写库的两条例外都在这里**）：
 *   ① **自愈迁移**：键缺失 + 库里有词条 ⇒ 固化开局伙伴；键缺失 + 空库 ⇒ 固化**空册**
 *      （免得以后加了词条凭空冒出一位——玩家创建的才该出现在地图上）。
 *   ② **防挂单**：锚定词条被删掉的伙伴自动出册——他守的知识没了，"他是谁"就说不清了。
 * ★ `scan` 可传入复用（调用方本来就要铺图时，别铺两遍）。
 */
export function syncParty(ownerId: string | null, scan: MapScan = scanMap(ownerId)): NpcPartyMember[] {
  const raw = readPartyRaw(ownerId);
  if (raw === null) {
    if (scan.terms === 0) {
      saveParty(ownerId, []);
      return [];
    }
    const starter = starterMember(scan);
    if (!starter) return []; // 有词条却没地可站 ⇒ 不写键，下次读到地图再试
    saveParty(ownerId, [starter]);
    return [starter];
  }
  const members = parseNpcParty(raw);
  const known = new Set<string>();
  for (const c of scan.candidates) known.add(c.termId);
  for (const m of scan.monsters) known.add(m.termId);
  const alive = members.filter((m) => known.has(m.termId));
  if (alive.length !== members.length) saveParty(ownerId, alive);
  return alive;
}

/**
 * 创建一位伙伴（玩家点的那一格 ⇒ 他守那一格上的词条）。
 *
 * 门票三条（老板 2026-09-27 裁定「完成一定量的任务等多个条件」）：
 *   ① **名额**：在册数 < `npcCapFor(世界半径)`（跟世界涨）；
 *   ② **任务**：已完成任务数 ≥ `npcTasksRequiredFor(在册数 + 1)`（第 1 位＝0，第 N≥2 位＝3×(N-1)）；
 *   ③ **熟度**（第 2 位起）：他守的那条词条要 `cards >= 2`（★1 以上）——他得有块你懂的地。
 * ★ 失败**必带一句具体的人话**（哪一条没过、差多少），禁静默。
 * ★ 位置校验：那一格必须是**没冒怪的词条格**，且同一条词条不能已经有伙伴守着。
 * ★ 名字与人设由 `generateNpcIdentity` 现生成（AI 优先，失败回退本地池子），返回 `source` 供 UI 说实话。
 */
export async function createPartner(
  ownerId: string | null,
  row: number,
  col: number,
): Promise<NpcCreateResult> {
  const scan = scanMap(ownerId);
  const members = syncParty(ownerId, scan);
  const quota = npcQuotaFor(ownerId, members.length);
  if (!quota.canCreate) return { ok: false, status: 409, error: quota.blockedBy };

  const cell = scan.candidates.find((c) => c.row === row && c.col === col);
  if (!cell) {
    const beast = scan.monsters.find((m) => m.row === row && m.col === col);
    return {
      ok: false,
      status: 409,
      error: beast
        ? `这一格被「${beast.term}」的怪占着——先把怪清掉，再安置伙伴。`
        : '这一格不能安置伙伴：得挑一块「有词条、没冒怪」的地——他得有块知识可守。',
    };
  }
  if (members.some((m) => m.termId === cell.termId)) {
    return { ok: false, status: 409, error: `「${cell.term}」已经有一位伙伴守着了——换一格吧。` };
  }
  if (members.length >= 1) {
    const cards = cardsByTerm(ownerId).get(cell.termId);
    if (!cards || cards.cards < NPC_TRADE_MIN_CARDS) {
      return {
        ok: false,
        status: 409,
        error: `这位伙伴得守一条你熟的词条（★1 以上，至少 2 张卡）——先把「${cell.term}」复习起来。`,
      };
    }
  }

  const identity = await generateNpcIdentity({
    ownerId,
    termId: cell.termId,
    term: cell.term,
    domain: cell.domain,
  });
  const member: NpcPartyMember = {
    id: npcIdOf(cell.termId),
    name: identity.name,
    bio: identity.bio,
    termId: cell.termId,
    row: cell.row,
    col: cell.col,
  };
  saveParty(ownerId, [...members, member]);
  return { ok: true, member, source: identity.source };
}

/** 改名。★ 空串**不再**表示"恢复默认名"（批 12 起每位伙伴都有存下来的名字）⇒ 空串是入参错 */
export function renamePartner(ownerId: string | null, id: string, input: unknown): NpcWriteResult {
  const clean = normalizeNpcName(typeof input === 'string' ? input : '');
  if (!clean) return { ok: false, status: 400, error: '名字不能为空——不想改就别动它' };
  const members = syncParty(ownerId);
  const at = members.findIndex((m) => m.id === id);
  if (at < 0) return { ok: false, status: 404, error: '这位伙伴不在大陆上，刷新一下地图' };
  const next = [...members];
  next[at] = { ...(members[at] as NpcPartyMember), name: clean };
  saveParty(ownerId, next);
  return { ok: true };
}

/**
 * 「让他回家」：把一位伙伴从名册里**真的删掉**。
 * ★ 必须真删而不是打标记：门票按名册序号算，留一个隐身位就是"免费刷位"（`npcTasksRequiredFor` 那条判据）。
 * ★ 他守的词条、卡、复习流水**一律不动**（伙伴不占格、不发卡，边界①）。
 */
export function removePartner(ownerId: string | null, id: string): NpcWriteResult {
  const members = syncParty(ownerId);
  if (!members.some((m) => m.id === id)) {
    return { ok: false, status: 404, error: '这位伙伴不在大陆上，刷新一下地图' };
  }
  saveParty(
    ownerId,
    members.filter((m) => m.id !== id),
  );
  return { ok: true };
}