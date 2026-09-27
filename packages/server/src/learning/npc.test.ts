/**
 * learning/npc（含 `npc-party`）— 花名册、创建门票、处境与交换（契约 `docs/NPC-PARTNER-SPEC.md` §2/§3/§6）。
 *
 * 断言分五组，每组挡一类真会烂掉的东西：
 *  ① **自愈迁移**：旧库（没有 `npc_party` 键）读一次就该把**旧口径那一位**固化下来，
 *     且位置与独立重算的哈希第 0 位逐字段相同——迁移错了，用户升级后会看到"他的伙伴换了人"；
 *  ② **创建的三条门票**（名额／任务／熟度）各自拒绝、各自说清为什么：压成一句"不能创建"，
 *     用户就永远不知道该去做什么；
 *  ③ **逐格校验**（空格／怪占着／已有伙伴守着）：这是"玩家自己点格子放"唯一可能静默失败的地方；
 *  ④ **处境同源**：遇险结论必须等于 `@sb/shared` 的 `npcDistress`，两条读口（列表/派单）不得各算一遍；
 *  ⑤ **交换的两道闸门**：信物 `cards>=2` 与每日 2 次。★ 卡是**读数不是道具**（`TERM-CARDS-SPEC` §1），
 *     扣不了，所以闸门只能落在这里。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHEST_POOL_SEED,
  NPC_TRADE_MIN_CARDS,
  continentHash,
  layoutTiles,
  monsterOccupies,
  npcCapFor,
  npcDistress,
  npcNameFromPool,
  npcTemplateBio,
  worldRadiusFor,
  type NpcMonster,
} from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { continentMap } from './continent.js';
import { acceptDraw, chestState, drawablePool, type PoolItem } from './chest.js';
import { completeTask, dispatchTasks, listTasks, reconcileTasks } from './tasks.js';
import {
  createPartner,
  npcQuota,
  removePartner,
  renamePartner,
  saveParty,
  syncParty,
} from './npc-party.js';
import { distressedNpcIds, distressedNpcs, npcList, npcTrade } from './npc.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-npc-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY1 = new Date(2026, 8, 25, 9, 0, 0);
const DAY2 = new Date(2026, 8, 26, 9, 0, 0);

/** 未来的入库时间 ⇒ 复习状态恒 `upcoming` ⇒ 不冒怪（跨运行日都稳，不依赖"今天是几号"） */
const FRESH = '2030-01-01 00:00:00';
/** 很久以前的入库时间 ⇒ `overdue` ⇒ 冒怪（前提：在复习范围内） */
const STALE = '2020-01-01 00:00:00';

interface TermOpts {
  domain?: string;
  createdAt?: string;
  /** 纳入复习范围（`review_enabled = 1`）——★ 范围外永不冒怪，故它同时是"能不能当威胁源"的开关 */
  inScope?: boolean;
}

function ownTerm(id: string, name: string, opts: TermOpts = {}, ownerId = ''): void {
  getDb()
    .prepare(
      `INSERT INTO term_library (id, term, definition, domain, owner_id, created_at, review_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, `${name} 的释义`, opts.domain ?? '记忆机制', ownerId, opts.createdAt ?? FRESH, opts.inScope ? 1 : 0);
}

/** 灌一条复习流水（★ 卡数按**不同复习日**计，所以这天数要跟别处错开） */
function review(id: string, day: string): void {
  getDb()
    .prepare(`INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_day) VALUES (?, ?, 0, 1, ?)`)
    .run(`r-${id}-${day}`, id, day);
}

/** 灌一条**已完成**的任务（门票按 `status='done'` 行数算——这是它唯一的口径） */
function doneTask(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO study_task (id, owner_id, kind, dedupe_key, title, why, status, dispatched_at, done_at)
       VALUES (?, '', 'advance', ?, 't', 'w', 'done', datetime('now'), datetime('now'))`,
    )
    .run(id, `k-${id}`);
}

/** 直接写花名册（跳过创建流程：测"名额满""已有伙伴守着"这类判据时要用它摆局面） */
function setParty(members: Array<{ termId: string; row: number; col: number; name?: string }>): void {
  const rows = members.map((m, i) => ({
    id: `npc:${m.termId}`,
    name: m.name ?? `名${i}`,
    bio: '守着它',
    termId: m.termId,
    row: m.row,
    col: m.col,
  }));
  getDb()
    .prepare(`INSERT OR REPLACE INTO app_settings (owner_id, key, value) VALUES ('', 'npc_party', ?)`)
    .run(JSON.stringify({ members: rows }));
}

function partyRaw(): { members: Array<{ id: string; name: string; termId: string; row: number; col: number }> } {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE owner_id = '' AND key = 'npc_party'`)
    .get() as { value: string } | undefined;
  return JSON.parse(row?.value ?? '{"members":[]}') as { members: never[] };
}

/**
 * 一条词条在**图上**的格。
 * ★★ 别写死坐标：批 11 起世界是**有符号固定中心**坐标（中心恒为 `(0,0)`），
 *   旧世界的 `(5,7)` 已经不存在了——写死就会造出"伙伴离怪十万八千里"的假局面。
 */
function tileOf(termId: string): { row: number; col: number } {
  const t = layoutTiles(continentMap(null)).find((x) => x.term.id === termId);
  if (!t) throw new Error(`图上没有 ${termId} 这一格`);
  return { row: t.row, col: t.col };
}

/** 固化一份**空花名册**：跳过"自愈迁移那一位"，专门测"第一位由玩家无条件创建" */
function sealEmptyParty(): void {
  setParty([]);
}

/** 旧口径的定序（**独立重算**，故意不走 `npc-party.ts`，否则就是自己证自己） */
function rankedCandidates(ownerId: string | null = null) {
  const tiles = layoutTiles(continentMap(ownerId)).filter(
    (t) => !monsterOccupies(t.term.review.status, t.term.review_in_scope === 1),
  );
  return [...tiles].sort((a, b) => {
    const ha = continentHash(`npc|${a.term.id}`);
    const hb = continentHash(`npc|${b.term.id}`);
    if (ha !== hb) return ha - hb;
    return a.term.id < b.term.id ? -1 : a.term.id > b.term.id ? 1 : 0;
  });
}

describe('自愈迁移（旧库那一位）', () => {
  it('① 键缺失 + 有词条 ⇒ 读一次就固化为**旧口径第 0 位**（位置与独立重算逐字段相同）', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    ownTerm('t3', '组块');
    expect(partyRaw().members).toEqual([]); // 前提：这个库还没有花名册

    const want = rankedCandidates()[0];
    const got = npcList(null);

    expect(got.npcs).toHaveLength(1);
    expect(got.npcs[0]).toMatchObject({
      id: `npc:${want?.term.id}`,
      termId: want?.term.id,
      term: want?.term.term,
      domain: want?.term.domain,
      row: want?.row,
      col: want?.col,
    });
    // ★ 迁移是"就地固化"：它真的写进了 `app_settings`（不是每次读都现算）
    expect(partyRaw().members).toHaveLength(1);
    expect(partyRaw().members[0]?.id).toBe(`npc:${want?.term.id}`);
  });

  it('①b 键缺失 + 空库 ⇒ 固化**空册**；之后加词条也不凭空冒人（第一位该由玩家创建）', () => {
    expect(npcList(null).npcs).toEqual([]);
    expect(partyRaw().members).toEqual([]);
    // ★ 空册已固化 ⇒ 迁移不会再触发
    getDb()
      .prepare(`INSERT INTO term_library (id, term, definition, domain, owner_id, created_at) VALUES ('t1','甲','d','域','','${FRESH}')`)
      .run();
    expect(npcList(null).npcs).toEqual([]);
  });

  it('①c 已有名册 ⇒ 原样读回（不按哈希重排、不覆盖名字）', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    setParty([{ termId: 't2', row: 0, col: 0, name: '老伙计' }]);
    const got = npcList(null);
    expect(got.npcs.map((n) => [n.termId, n.name, n.row, n.col])).toEqual([['t2', '老伙计', 0, 0]]);
    expect(got.partnerName).toBe('老伙计');
  });

  it('①d 防挂单：锚定的词条被删 ⇒ 那位伙伴自动出册（他守的知识没了）', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    setParty([
      { termId: 't1', row: 0, col: 0 },
      { termId: 't2', row: 1, col: 1 },
    ]);
    getDb().prepare(`DELETE FROM term_library WHERE id = 't1'`).run();
    expect(npcList(null).npcs.map((n) => n.termId)).toEqual(['t2']);
    expect(partyRaw().members.map((m) => m.termId)).toEqual(['t2']);
  });
});

describe('创建与门票（名额 / 任务 / 熟度）', () => {
  /** 造两块"能站的地"：三条没冒怪的词条，返回哈希序第一格的坐标（旧口径那套定序） */
  function ground(): { row: number; col: number } {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    ownTerm('t3', '组块');
    const cell = rankedCandidates()[0];
    if (!cell) throw new Error('没造出可落位的地块');
    return { row: cell.row, col: cell.col };
  }

  it('② 首位**无条件**：空册 + 0 单任务也能创建（门票 needTasks=0），名字与人设走本地兜底', async () => {
    const cell = ground();
    sealEmptyParty(); // ★ 空册 ⇒ 这一位就是"玩家创建的第一位"（迁移那一位已被跳过）
    const q = npcQuota(null);
    expect(q).toMatchObject({ count: 0, doneTasks: 0, needTasks: 0, canCreate: true, blockedBy: '' });

    const r = await createPartner(null, cell.row, cell.col);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★ 无可用模型（隔离库没绑角色）⇒ source='fallback'，名字取自名字池、人设取自模板
    expect(r.source).toBe('fallback');
    expect(r.member.name).toBe(npcNameFromPool(r.member.termId));
    expect(r.member.bio).toBe(npcTemplateBio(r.member.termId === 't1' ? '主动回忆' : ''));
    expect(partyRaw().members).toHaveLength(1);
  });

  it('③ 第 2 位要 3 单任务：不够时 409 且说清"还差几单"；凑够 3 单再换一条熟词才放行', async () => {
    const cell = ground();
    sealEmptyParty();
    expect((await createPartner(null, cell.row, cell.col)).ok).toBe(true); // 首位落地（无条件）
    expect(npcQuota(null)).toMatchObject({ count: 1, needTasks: 3, canCreate: false });
    expect(npcQuota(null).blockedBy).toContain('还差 3 单');

    const second = rankedCandidates()[1];
    if (!second) throw new Error('需要第二块地');
    const deny = await createPartner(null, second.row, second.col);
    expect(deny.ok).toBe(false);
    if (!deny.ok) {
      expect(deny.status).toBe(409);
      expect(deny.error).toContain('还差 3 单');
    }

    doneTask('d1');
    doneTask('d2');
    doneTask('d3');
    expect(npcQuota(null)).toMatchObject({ doneTasks: 3, canCreate: true });
    // ★ 门票的第二条：他守的那条词条得是**你熟的**（★1 以上 ≥ 2 张卡）
    const poor = await createPartner(null, second.row, second.col);
    expect(poor.ok).toBe(false);
    if (!poor.ok) expect(poor.error).toContain('★1');
    review(second.term.id, '2026-09-24'); // 1(建卡) + 1(复习日) = 2 张
    expect((await createPartner(null, second.row, second.col)).ok).toBe(true);
    expect(partyRaw().members).toHaveLength(2);
  });

  it('④ 逐格校验三种拒绝各一句：荒地／怪占着／已经有伙伴守着', async () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    ownTerm('t3', '组块');
    sealEmptyParty(); // ★ 空册 ⇒ 门票为 0，这一段测的全是**逐格判定**
    // 把 t2 变成怪（老词 + 纳入复习范围）——★ 用 UPDATE 而不是再 INSERT（同一个 id 会撞主键）
    getDb()
      .prepare(`UPDATE term_library SET created_at = ?, review_enabled = 1 WHERE id = 't2'`)
      .run(STALE);
    const beast = tileOf('t2');
    const cell = rankedCandidates()[0];
    if (!cell) throw new Error('没造出可落位的地块');

    // ① 没有词条的荒地（世界很大，随便挑一个远处格）
    const empty = await createPartner(null, -20, -20);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.status).toBe(409);
      expect(empty.error).toContain('不能安置');
    }

    // ② 怪占着的那一格（★ 这一条排在"已经有一位"之前：先告诉他这格本来就不能站）
    const occupied = await createPartner(null, beast.row, beast.col);
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.error).toContain('怪占着');

    // ③ 首位落地（无条件）
    expect((await createPartner(null, cell.row, cell.col)).ok).toBe(true);

    // ④ 同一条词条的格已经有伙伴了（★ 同一条词条不能被两位伙伴守）
    //    ⚠️ 判据顺序：门票在逐格之前 ⇒ 要把第 2 位的 3 单任务补上才走得到这一步
    doneTask('d1');
    doneTask('d2');
    doneTask('d3');
    const again = await createPartner(null, cell.row, cell.col);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('已经有一位');
  });

  it('⑤ 名额上限（跟世界半径涨）：在册满了就拒绝，并说清"先让一位回家"', async () => {
    for (let i = 1; i <= 6; i += 1) ownTerm(`t${i}`, `词${i}`);
    const max = npcCapFor(worldRadiusFor(6));
    expect(max).toBe(6); // 小世界 ⇒ 下限 6
    // ★ 每位守一条**不同**的词条：`parseNpcParty` 按 `npc:<termId>` 去重，六位挤同一条词条只剩一位
    setParty(Array.from({ length: max }, (_, i) => ({ termId: `t${i + 1}`, row: i, col: 0, name: `名${i}` })));
    expect(syncParty(null)).toHaveLength(max);
    const r = await createPartner(null, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain('最多站 6 位');
    }
  });
});

describe('改名与解散', () => {
  function one(): string {
    ownTerm('t1', '主动回忆');
    const npc = npcList(null).npcs[0];
    if (!npc) throw new Error('没造出伙伴');
    return npc.id;
  }

  it('⑥ 改名：空串 400（不再是"恢复默认"）、未知伙伴 404、成功则归一化后落库', () => {
    const id = one();
    expect(renamePartner(null, id, '   ')).toMatchObject({ ok: false, status: 400 });
    expect(renamePartner(null, 'npc:nobody', '甲')).toMatchObject({ ok: false, status: 404 });
    expect(renamePartner(null, id, '  小白  ')).toEqual({ ok: true });
    expect(npcList(null).npcs[0]?.name).toBe('小白');
    expect(npcList(null).partnerName).toBe('小白');
    // 超长按码点截到 12
    renamePartner(null, id, '一二三四五六七八九十十一十二十三');
    expect(npcList(null).npcs[0]?.name).toBe('一二三四五六七八九十十一');
  });

  it('⑦ 解散是**真删**（门票按名册序号算，留个隐身位就是免费刷位）；不存在的给 404', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    setParty([
      { termId: 't1', row: 0, col: 0 },
      { termId: 't2', row: 1, col: 1 },
    ]);
    expect(removePartner(null, 'npc:nobody')).toMatchObject({ ok: false, status: 404 });
    expect(removePartner(null, 'npc:t1')).toEqual({ ok: true });
    expect(partyRaw().members.map((m) => m.termId)).toEqual(['t2']);
    // ★ 他守的词条与流水一律不动（伙伴不占格、不发卡）
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM term_library`).get()).toMatchObject({ n: 2 });
  });
});

describe('处境：位置、遇险、可落位格', () => {
  it('⑧ 遇险结论与 `npcDistress` 完全一致，且两条读口（列表/派单）同源', () => {
    // 螺旋铺格按 `created_at` 升序填：t2（2020，怪）落中心、t1（2030，候选）落它右边一格
    ownTerm('t1', '中心词', { createdAt: FRESH });
    ownTerm('t2', '威胁词', { createdAt: STALE, inScope: true });
    setParty([{ termId: 't1', row: tileOf('t1').row, col: tileOf('t1').col }]); // 与他锚定的词条格一致
    const monsters: NpcMonster[] = layoutTiles(continentMap(null))
      .filter((t) => monsterOccupies(t.term.review.status, t.term.review_in_scope === 1))
      .map((t) => ({ termId: t.term.id, term: t.term.term, row: t.row, col: t.col }));

    const npc = npcList(null).npcs[0];
    expect(npc?.termId).toBe('t1');
    expect(npc?.threat).toEqual(npcDistress(npc ?? { row: -1, col: -1 }, monsters));
    expect(npc?.distressed).toBe(true);
    expect(npc?.threat?.termId).toBe('t2');
    expect(distressedNpcIds(null).has(npc?.id ?? '')).toBe(true);
    expect(distressedNpcs(null)).toEqual([
      { id: npc?.id, name: npc?.name, threatTermId: 't2', threatTerm: '威胁词' },
    ]);
  });

  it('⑨ ★ 距离 0 也算遇险：怪正好压在他守的那一格上（"地被夺走了"，批 12 起不再自动搬走）', () => {
    ownTerm('t1', '中心词', { createdAt: FRESH });
    // ★ 世界中心恒为 (0,0)：只有一条词条时它必落在那里
    setParty([{ termId: 't1', row: tileOf('t1').row, col: tileOf('t1').col }]);
    // 把**他守的那条词条**变成怪（老词 + 纳入复习范围）⇒ 怪就冒在他脚下
    getDb()
      .prepare(`UPDATE term_library SET created_at = ?, review_enabled = 1 WHERE id = 't1'`)
      .run(STALE);
    const npc = npcList(null).npcs[0];
    expect(npc?.distressed).toBe(true);
    expect(npc?.threat).toMatchObject({ termId: 't1', distance: 0 });
  });

  it('⑩ 可落位格 = 没冒怪的词条格 −（已被占的格／已被守的词条）', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    ownTerm('t3', '组块');
    const at = tileOf('t3');
    setParty([{ termId: 't3', row: at.row, col: at.col }]);
    const spots = npcList(null).spots;
    // 三格减去"他守的那一格" ⇒ 还剩两位能站（可落位格由服务端给，前端不重算）
    const others = layoutTiles(continentMap(null))
      .filter((t) => t.term.id !== 't3')
      .map((t) => ({ row: t.row, col: t.col }));
    expect(spots).toHaveLength(2);
    for (const o of others) expect(spots).toContainEqual(o);
  });
});

describe('与任务清单联动（求救单 npc_rescue）', () => {
  /** 造一个"伙伴被相邻的怪堵住"的局面：t2（2020，在范围内）落中心当怪、t1（2030）落它右边当伙伴 */
  function siege(): { npcId: string; threatId: string } {
    ownTerm('t1', '中心词', { createdAt: FRESH });
    ownTerm('t2', '威胁词', { createdAt: STALE, inScope: true });
    setParty([{ termId: 't1', row: tileOf('t1').row, col: tileOf('t1').col }]);
    const npc = npcList(null).npcs.find((n) => n.termId === 't1');
    if (!npc?.distressed) throw new Error('没造出遇险的伙伴');
    return { npcId: npc.id, threatId: 't2' };
  }

  it('⑪ 派单：求救单进清单、置首、字段齐全；连跑两次只落一行（幂等）', () => {
    const { npcId } = siege();
    const first = dispatchTasks(null, DAY1);
    expect(first.added).toBe(1);

    const t = listTasks(null)[0];
    expect(t).toMatchObject({ kind: 'npc_rescue', termId: 't2', done: false });
    expect(t?.title).toContain('去救');
    expect(t?.why).toContain('威胁词');

    const again = dispatchTasks(null, DAY1);
    expect(again.added).toBe(0);
    const row = getDb()
      .prepare(`SELECT ref_id, dedupe_key FROM study_task WHERE kind = 'npc_rescue'`)
      .get() as { ref_id: string; dedupe_key: string };
    expect(row.ref_id).toBe(npcId);
    expect(row.dedupe_key).toBe(`npc_rescue:${npcId}`);
  });

  it('⑫ 脱险 ⇒ 那单自动翻 done 并发一把钥匙（判据是"他不再遇险"）', () => {
    siege();
    dispatchTasks(null, DAY1);
    expect(listTasks(null)[0]?.done).toBe(false);
    expect(chestState(null, DAY1).earnedKeys).toBe(0);

    // 怪散了（这里用"移出复习范围"这条既有路径：范围外不冒怪）
    getDb().prepare(`UPDATE term_library SET review_enabled = 0 WHERE id = 't2'`).run();
    expect(distressedNpcs(null)).toEqual([]);
    const r = reconcileTasks(null, DAY1);
    expect(r.keysGranted).toBe(1);
    expect(listTasks(null)[0]?.done).toBe(true);
    expect(chestState(null, DAY1).earnedKeys).toBe(1);
  });

  it('⑬ 完成判据不由前端回执决定：怪还在时 `completeTask` 必须 `not_yet`（一个 POST 刷不出钥匙）', () => {
    siege();
    dispatchTasks(null, DAY1);
    expect(completeTask(null, listTasks(null)[0]?.id ?? '', DAY1)).toEqual({ ok: false, reason: 'not_yet' });
    expect(chestState(null, DAY1).earnedKeys).toBe(0);
  });

  it('⑭ 解散遇险的伙伴 ⇒ 那单自动完成（他不在遇险集里了，§5.3 的"缺失即完成"）', () => {
    const { npcId } = siege();
    dispatchTasks(null, DAY1);
    expect(removePartner(null, npcId)).toEqual({ ok: true });
    expect(reconcileTasks(null, DAY1).keysGranted).toBe(1);
    expect(listTasks(null)[0]?.done).toBe(true);
  });
});

describe('交换（两道闸门 + 落既有 chest_open）', () => {
  /** 一位伙伴 + 可当信物的那条词条（迁移把这对同一条词条同时当作"他守的地"与用户信物） */
  function partnerTerm(domain = '记忆机制'): { id: string; termId: string } {
    ownTerm('trust', '我的信物', { domain });
    const npc = npcList(null).npcs[0];
    if (!npc) throw new Error('没造出伙伴');
    return { id: npc.id, termId: 'trust' };
  }

  /** 把整池记成"已抽过" ⇒ 没有"没见过"的词可换（**不加词条**，以免挪动伙伴的落位） */
  function drainPool(): void {
    const ins = getDb().prepare(
      `INSERT INTO chest_open (id, owner_id, opened_day, source_kind, pool_slug, pool_term, pool_domain, pool_definition)
       VALUES (?, '', '2026-09-01', 'seed', ?, ?, ?, '')`,
    );
    for (const e of CHEST_POOL_SEED) ins.run(`drained-${e.term}`, `seed:${e.term}`, e.term, e.domain);
  }

  it('⑮ 信物 cards=1 拒绝（那是"刚记下来"不是"我熟"），补到 ★1 才放行', () => {
    const { id, termId } = partnerTerm();
    const poor = npcTrade(null, id, termId, DAY1);
    expect(poor.ok).toBe(false);
    if (!poor.ok) expect(poor.status).toBe(409);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chest_open`).get()).toMatchObject({ n: 0 });

    review(termId, '2026-09-24'); // 卡数 1(建卡) + 1(复习日) = 2 = NPC_TRADE_MIN_CARDS
    expect(NPC_TRADE_MIN_CARDS).toBe(2);
    expect(npcTrade(null, id, termId, DAY1).ok).toBe(true);
  });

  it('⑮b 三种拒绝各给一句：未知伙伴 404、信物不在库 409、信物不是自己的 409', () => {
    const { id, termId } = partnerTerm();
    review(termId, '2026-09-24');
    expect(npcTrade(null, 'npc:nobody', termId, DAY1)).toMatchObject({ ok: false, status: 404 });
    expect(npcTrade(null, id, 'no-such-term', DAY1)).toMatchObject({ ok: false, status: 409 });
    ownTerm('others', '别人的词', {}, 'u2'); // ★ 归属：别人库里的词条不算我的信物
    review('others', '2026-09-24');
    expect(npcTrade(null, id, 'others', DAY1)).toMatchObject({ ok: false, status: 409 });
  });

  it('⑯ 换回同领域新词，只落一行 chest_open(source_kind=npc)，且不花任何钥匙', () => {
    const { id, termId } = partnerTerm('记忆机制');
    review(termId, '2026-09-24');
    const r = npcTrade(null, id, termId, DAY1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.domainMatched).toBe(true);
    expect(r.draw.source).toBe('npc');
    expect(r.draw.cost).toBeNull(); // ★ 没有任何一本钥匙账被动过 ⇒ null，不编一个 'free'
    expect(r.draw.domain).toBe('记忆机制');
    expect(r.tradesLeft).toBe(1);

    const row = getDb()
      .prepare(`SELECT source_kind, pool_slug, opened_day, accepted FROM chest_open WHERE id = ?`)
      .get(r.draw.openId) as { source_kind: string; pool_slug: string; opened_day: string; accepted: number };
    expect(row.source_kind).toBe('npc');
    expect(row.pool_slug).toBeTruthy(); // 去重集的键仍在（否则明天还会抽到同一条）
    expect(row.opened_day).toBe('2026-09-25');
    expect(row.accepted).toBe(0);

    expect(chestState(null, DAY1)).toMatchObject({ freeUsed: 0, openedToday: 0, earnedKeys: 0 });
    // ★ 抽过的进"已抽过"去重集——★ 要在**收下之前**判，收下之后它因"库里已有"被排除，断言会退化成恒真
    expect(drawablePool(null).some((p: PoolItem) => p.entry.term === r.draw.term)).toBe(false);
    const a = acceptDraw(null, r.draw.openId, false);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.cards).toMatchObject({ cards: 2, star: 1, chestGrants: 1 });
  });

  it('⑯b 信物的领域里没得换 ⇒ 回落全池并如实标记 domainMatched=false', () => {
    const { id, termId } = partnerTerm('冷门领域');
    review(termId, '2026-09-24');
    const r = npcTrade(null, id, termId, DAY1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.domainMatched).toBe(false);
    expect(r.draw.domain).not.toBe('冷门领域');
  });

  it('⑰ 池子空了 ⇒ 409，且文案与宝箱的 empty 同口径', () => {
    const { id, termId } = partnerTerm();
    review(termId, '2026-09-24');
    drainPool();
    expect(drawablePool(null)).toHaveLength(0); // 前提成立才谈得上这条判据
    const r = npcTrade(null, id, termId, DAY1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain('没有你没见过的新词');
    }
  });

  it('⑱ 每日 2 次闸门：同一天第三次拒绝、跨日恢复；信物可反复用（卡不会被扣）', () => {
    const { id, termId } = partnerTerm();
    review(termId, '2026-09-24');

    const first = npcTrade(null, id, termId, DAY1);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.tradesLeft).toBe(1);
    const second = npcTrade(null, id, termId, DAY1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.tradesLeft).toBe(0);

    const third = npcTrade(null, id, termId, DAY1);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(409);
      expect(third.error).toContain('今天已经换过两次');
    }
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chest_open`).get()).toMatchObject({ n: 2 });

    // ★ 跨日恢复：闸门读的是 `opened_day`（既有列），不是内存计数
    expect(npcTrade(null, id, termId, DAY2).ok).toBe(true);
    // ★ 信物没有被消耗：同一条词条可以一直拿出来换（§6.3 如实记的代价）
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM term_library WHERE id = 'trust'`).get()).toMatchObject({ n: 1 });
  });

  it('⑱b 归属隔离：别人库里的词条与别人的伙伴都不串到我的名册上', () => {
    ownTerm('mine', '我的词');
    const mine = npcList(null).npcs[0];
    if (!mine) throw new Error('没造出伙伴');
    expect(saveParty).toBeTypeOf('function'); // 花名册写口只有本域在用（下面直接摆局面）
    setParty([{ termId: 'mine', row: mine.row, col: mine.col }]);
    expect(npcList(null).npcs.map((n) => n.termId)).toEqual(['mine']);
  });
});