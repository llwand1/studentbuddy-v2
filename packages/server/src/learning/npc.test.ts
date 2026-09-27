/**
 * learning/npc — 伙伴派生、身份 KV、交换（契约 `docs/NPC-PARTNER-SPEC.md` §2／§3／§6）。
 *
 * 断言分三组，每组挡一类真会烂掉的东西：
 *  ① **派生同源**：服务端给的 `row/col/name` 必须与 `@sb/shared` 的纯函数逐字段相同——
 *     两处各算一遍的开端就是「图上画着伙伴遇险、任务清单里没有那单」；
 *  ② **身份 KV 的容错**：坏 JSON／空串都不许抛，空串＝删键回默认（照 `answer-style.ts` 口径）；
 *  ③ **交换的两道闸门**：信物 `cards>=2` 与每日 2 次。★ 这两条是本册唯一的真实代价——
 *     卡是**读数不是道具**（`TERM-CARDS-SPEC` §1 边界①），扣不了，所以闸门只能落在这里。
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
  npcCountFor,
  npcDistress,
  npcNameFor,
  placeNpcs,
  type NpcCandidate,
  type NpcMonster,
} from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { continentMap } from './continent.js';
import { acceptDraw, chestState, drawablePool, type PoolItem } from './chest.js';
import { completeTask, dispatchTasks, listTasks, reconcileTasks } from './tasks.js';
import {
  distressedNpcIds,
  distressedNpcs,
  loadPartnerName,
  npcList,
  npcTrade,
  savePartnerName,
} from './npc.js';

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

/** 服务端铺格口径的**独立重算**（对照用；故意不走 `learning/npc.ts`，否则就是自己证自己） */
function expected(ownerId: string | null = null): { npcs: NpcCandidate[]; monsters: NpcMonster[]; count: number } {
  const tiles = layoutTiles(continentMap(ownerId));
  const candidates: NpcCandidate[] = [];
  const monsters: NpcMonster[] = [];
  for (const t of tiles) {
    if (monsterOccupies(t.term.review.status, t.term.review_in_scope === 1)) {
      monsters.push({ termId: t.term.id, term: t.term.term, row: t.row, col: t.col });
    } else {
      candidates.push({ termId: t.term.id, term: t.term.term, domain: t.term.domain, row: t.row, col: t.col });
    }
  }
  return { npcs: candidates, monsters, count: npcCountFor(continentMap(ownerId).length) };
}

describe('伙伴派生（与 shared 同源）', () => {
  it('① 位置/名字/数量与 shared 纯函数逐字段相同，且不落在有怪的格上', () => {
    ownTerm('t1', '主动回忆');
    ownTerm('t2', '间隔重复');
    ownTerm('t3', '组块');

    const e = expected();
    const want = placeNpcs(e.npcs, e.count);
    const got = npcList(null);

    expect(got.count).toBe(e.count);
    expect(got.npcs.map((n) => [n.id, n.termId, n.term, n.domain, n.row, n.col, n.name])).toEqual(
      want.map((n) => [n.id, n.termId, n.term, n.domain, n.row, n.col, n.name]),
    );
    expect(got.partnerName).toBe(want[0]?.name);
    expect(got.max).toBe(6);
    // 名字确定性：任意一位伙伴的名字都等于 `npcNameFor(他锚定的词条)`
    for (const n of got.npcs) expect(n.name).toBe(npcNameFor(n.termId));
    // ★ 没有一个伙伴站在怪的本体格上（§2.2 的"先过滤怪再取哈希序"）
    const bodyCells = new Set(e.monsters.map((m) => `${m.row},${m.col}`));
    for (const n of got.npcs) expect(bodyCells.has(`${n.row},${n.col}`)).toBe(false);
  });

  it('①b 伙伴被相邻的怪堵住 ⇒ 遇险结论与 `npcDistress` 完全一致（含威胁怪的词条）', () => {
    // 螺旋铺格按 `created_at` 升序填：t2（2020，怪）落中心、t1（2030，候选）落它右边一格
    // ⇒ 伙伴站在 (5,8)、怪在 (5,7)，曼哈顿距离 1，正是「一步能打到」的位置。
    ownTerm('t1', '中心词', { createdAt: FRESH });
    ownTerm('t2', '威胁词', { createdAt: STALE, inScope: true });

    const e = expected();
    const got = npcList(null);
    const npc = got.npcs[0];
    expect(npc?.termId).toBe('t1');
    const wantThreat = npcDistress(npc ?? { row: -1, col: -1 }, e.monsters);
    expect(npc?.threat).toEqual(wantThreat);
    expect(npc?.distressed).toBe(true);
    expect(npc?.threat?.termId).toBe('t2');
    // 派单用的两个读口与 `npcList` 同源（不是另算一遍）
    expect(distressedNpcIds(null).has(npc?.id ?? '')).toBe(true);
    expect(distressedNpcs(null)).toEqual([
      { id: npc?.id, name: npc?.name, threatTermId: 't2', threatTerm: '威胁词' },
    ]);
  });

  it('①c 范围外的词条永不冒怪 ⇒ 伙伴不遇险（「没纳入复习」不该被算成危险）', () => {
    ownTerm('t1', '中心词', { createdAt: FRESH });
    ownTerm('t2', '范围外老词', { createdAt: STALE, inScope: false });
    const got = npcList(null);
    expect(got.npcs).toHaveLength(npcCountFor(2));
    for (const n of got.npcs) expect(n.distressed).toBe(false);
  });

  it('①d 空库：数量仍是 1（下限）但一格都没有 ⇒ 空数组，且不抛', () => {
    const got = npcList(null);
    expect(got.count).toBe(1);
    expect(got.npcs).toEqual([]);
    expect(got.partnerName).toBe('');
    expect(got.termsToNext).toBe(16); // 下限那一位是白送的 ⇒ 下一位要 16 条
  });
});

describe('身份 KV（名字）', () => {
  it('② 起名落 app_settings；坏 JSON／空串都不许抛，空串＝删键回默认', () => {
    expect(loadPartnerName(null)).toBe('');

    expect(savePartnerName(null, '  小白  ')).toBe('小白');
    expect(loadPartnerName(null)).toBe('小白');
    const row = getDb()
      .prepare(`SELECT value FROM app_settings WHERE owner_id = '' AND key = 'npc_partner'`)
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ name: '小白' });

    // ★ 按码点截断到 12 字（`slice` 会把 emoji 劈成半个）
    expect(savePartnerName(null, '一二三四五六七八九十十一十二十三')).toHaveLength(12);

    // 坏 JSON 回退默认名，不抛（数据容错 ADR-6）
    getDb().prepare(`UPDATE app_settings SET value = 'not-json{' WHERE key = 'npc_partner'`).run();
    expect(loadPartnerName(null)).toBe('');
    expect(npcList(null).partnerName).toBe('');

    // 空串＝删键（恢复默认名）
    savePartnerName(null, '小白');
    expect(savePartnerName(null, '   ')).toBe('');
    expect(
      getDb().prepare(`SELECT 1 AS x FROM app_settings WHERE key = 'npc_partner'`).get(),
    ).toBeUndefined();
  });

  it('②b 起的名字只覆盖**第 0 位**（主伙伴），其余伙伴仍是默认名（§3）', () => {
    for (let i = 0; i < 16; i++) ownTerm(`t${i}`, `词${i}`);
    expect(npcList(null).npcs).toHaveLength(2);
    savePartnerName(null, '老伙计');
    const got = npcList(null);
    expect(got.partnerName).toBe('老伙计');
    expect(got.npcs[0]?.name).toBe('老伙计');
    expect(got.npcs[1]?.name).toBe(npcNameFor(got.npcs[1]?.termId ?? ''));
  });
});

describe('与任务清单联动（求救单 npc_rescue）', () => {
  /**
   * 造一个"伙伴被相邻的怪堵住"的局面：t2（2020，在范围内）落中心当怪、t1（2030）落它右边当伙伴。
   * ★ 与 ①b 同一套几何——螺旋铺格按 `created_at` 升序填，中心是第 0 格、右邻是第 1 格。
   */
  function siege(): { termId: string; threatId: string } {
    ownTerm('t1', '中心词', { createdAt: FRESH });
    ownTerm('t2', '威胁词', { createdAt: STALE, inScope: true });
    const npc = npcList(null).npcs.find((n) => n.termId === 't1');
    if (!npc?.distressed) throw new Error('没造出遇险的伙伴');
    return { termId: npc.id, threatId: 't2' };
  }

  it('① 派单：求救单进清单、置首、字段齐全；连跑两次只落一行（幂等）', () => {
    const { termId } = siege();
    const first = dispatchTasks(null, DAY1);
    expect(first.added).toBe(1);
    expect(first.taskIds).toHaveLength(1);

    const tasks = listTasks(null);
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t).toMatchObject({ kind: 'npc_rescue', termId: 't2', done: false });
    expect(t?.title).toContain('去救');
    expect(t?.why).toContain('威胁词');

    // ★ 幂等：去重键里没有会变的数（`npc_rescue:<npcId>`）⇒ 第二次 tick 增 0 行
    const again = dispatchTasks(null, DAY1);
    expect(again.added).toBe(0);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM study_task WHERE kind = 'npc_rescue'`).get()).toMatchObject({
      n: 1,
    });
    expect(listTasks(null).filter((x) => x.kind === 'npc_rescue')).toHaveLength(1);
    // 单上锚的是伙伴、挂在威胁怪的词条上（答对它 = 怪散 = 脱险）
    const row = getDb()
      .prepare(`SELECT ref_id, dedupe_key FROM study_task WHERE kind = 'npc_rescue'`)
      .get() as { ref_id: string; dedupe_key: string };
    expect(row.ref_id).toBe(termId);
    expect(row.dedupe_key).toBe(`npc_rescue:${termId}`);
  });

  it('② 脱险 ⇒ 那单自动翻 done 并发一把钥匙（同事务；判据是"他不再遇险"）', () => {
    siege();
    dispatchTasks(null, DAY1);
    expect(listTasks(null)[0]?.done).toBe(false);
    expect(chestState(null, DAY1).earnedKeys).toBe(0);

    // 怪散了（这里用"移出复习范围"这条既有路径：范围外不冒怪）
    getDb().prepare(`UPDATE term_library SET review_enabled = 0 WHERE id = 't2'`).run();

    // ★ 判据的原话：这位伙伴**当前不再遇险**。两条路都合法、都表现为同一句判据——
    //   ① 怪散了 ⇒ `npc:t1` 不在遇险集里；② 伙伴本身换了人 ⇒ 旧 id 自然不在集合里（§5.3 的防挂单）
    expect(distressedNpcs(null)).toEqual([]);
    const r = reconcileTasks(null, DAY1);
    expect(r.keysGranted).toBe(1);
    expect(listTasks(null)[0]?.done).toBe(true);
    expect(chestState(null, DAY1).earnedKeys).toBe(1);
  });

  it('③ 完成判据不由前端回执决定：怪还在时 `completeTask` 必须 `not_yet`（一个 POST 刷不出钥匙）', () => {
    siege();
    dispatchTasks(null, DAY1);
    const id = listTasks(null)[0]?.id ?? '';
    const r = completeTask(null, id, DAY1);
    expect(r).toEqual({ ok: false, reason: 'not_yet' });
    expect(chestState(null, DAY1).earnedKeys).toBe(0);
  });
});

describe('交换（两道闸门 + 落既有 chest_open）', () => {
  /**
   * 造一位伙伴，并返回他 + 可当信物的那条词条。
   * ★ **只放一条词条**：`placeNpcs` 按哈希序取前 N 个，两条候选时谁是第 0 位（主伙伴）由哈希决定，
   *   没法在用例里钉住；一条候选时 `npcId` 唯一确定（`npc:trust`），断言才稳。
   *   这条词条同时是他"守的地"和用户的信物——角色重合不影响任何判据。
   */
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

  it('③ 信物 cards=1 拒绝（那是"刚记下来"不是"我熟"），补到 ★1 才放行', () => {
    const { id, termId } = partnerTerm();

    const poor = npcTrade(null, id, termId, DAY1);
    expect(poor.ok).toBe(false);
    if (!poor.ok) expect(poor.status).toBe(409);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chest_open`).get()).toMatchObject({ n: 0 });

    review(termId, '2026-09-24'); // 卡数 1(建卡) + 1(复习日) = 2 = NPC_TRADE_MIN_CARDS
    expect(NPC_TRADE_MIN_CARDS).toBe(2);
    expect(npcTrade(null, id, termId, DAY1).ok).toBe(true);
  });

  it('③b 三种拒绝各给一句：未知伙伴 404、信物不在库 409、信物不是自己的 409', () => {
    const { id, termId } = partnerTerm();
    review(termId, '2026-09-24');

    const unknown = npcTrade(null, 'npc:nobody', termId, DAY1);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(404);

    const missing = npcTrade(null, id, 'no-such-term', DAY1);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(409);

    ownTerm('others', '别人的词', {}, 'u2'); // ★ 归属：别人库里的词条不算我的信物
    review('others', '2026-09-24');
    const stolen = npcTrade(null, id, 'others', DAY1);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.status).toBe(409);
  });

  it('④ 换回同领域新词，只落一行 chest_open(source_kind=npc)，且不花任何钥匙', () => {
    const { id, termId } = partnerTerm('记忆机制');
    review(termId, '2026-09-24');
    const r = npcTrade(null, id, termId, DAY1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.domainMatched).toBe(true);
    expect(r.draw.source).toBe('npc');
    expect(r.draw.cost).toBeNull(); // ★ 没有任何一本钥匙账被动过 ⇒ null，不编一个 'free'
    expect(r.draw.domain).toBe('记忆机制');
    expect(CHEST_POOL_SEED.some((e) => e.term === r.draw.term)).toBe(true);
    expect(r.tradesLeft).toBe(1);

    const row = getDb()
      .prepare(`SELECT source_kind, pool_slug, opened_day, accepted FROM chest_open WHERE id = ?`)
      .get(r.draw.openId) as { source_kind: string; pool_slug: string; opened_day: string; accepted: number };
    expect(row.source_kind).toBe('npc');
    expect(row.pool_slug).toBeTruthy(); // 去重集的键仍在（否则明天还会抽到同一条）
    expect(row.opened_day).toBe('2026-09-25');
    expect(row.accepted).toBe(0);

    // ★ 不花钥匙：免费次数与今日已开都没动（这正是"卡是读数不是道具"的代价所在）
    expect(chestState(null, DAY1)).toMatchObject({ freeUsed: 0, openedToday: 0, earnedKeys: 0 });
    // ★ 抽过的进"已抽过"去重集（否则抽卡去重形同虚设）——★ 要在**收下之前**判，
    //   收下之后它因为"库里已有"而被排除，断言就退化成恒真了
    expect(drawablePool(null).some((p: PoolItem) => p.entry.term === r.draw.term)).toBe(false);
    // 收下走**既有**端点，且天生 ★1（1 建卡 + 1 这次）
    const a = acceptDraw(null, r.draw.openId, false);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.cards).toMatchObject({ cards: 2, star: 1, chestGrants: 1 });
  });

  it('⑤ 信物的领域里没得换 ⇒ 回落全池并如实标记 domainMatched=false（不是"换不了"）', () => {
    const { id, termId } = partnerTerm('冷门领域');
    review(termId, '2026-09-24');
    const r = npcTrade(null, id, termId, DAY1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.domainMatched).toBe(false);
    expect(r.draw.domain).not.toBe('冷门领域');
  });

  it('⑤b 池子空了 ⇒ 409，且文案与宝箱的 empty 同口径', () => {
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

  it('⑥ 每日 2 次闸门：同一天第三次拒绝、跨日恢复；信物可反复用（卡不会被扣）', () => {
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
    const nextDay = npcTrade(null, id, termId, DAY2);
    expect(nextDay.ok).toBe(true);
    // ★ 信物没有被消耗：同一条词条可以一直拿出来换（§6.3 如实记的代价）
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM term_library WHERE id = 'trust'`).get(),
    ).toMatchObject({ n: 1 });
    expect(continentHash('npc|trust')).toBe(continentHash('npc|trust')); // 顺带：哈希确定性
  });
});