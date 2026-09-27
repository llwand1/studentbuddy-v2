/**
 * shared/npc.test — 地图学习伙伴（NPC）的派生口径锁（契约 `docs/NPC-PARTNER-SPEC.md` §2/§5）。
 *
 * ★ 本文件锁的是「**同一份库必得同一群伙伴**」这条承诺：数量、位置、名字只要有一处随机，
 *   用户每次刷新都会看到伙伴换人，"创建你的 AI 学习伙伴"这句话当场作废。
 *   这类 bug 在 UI 上只表现为"好像换了个名字"，没有断言就会长期无人发现。
 * ★ 另一条容易写错的：**遇险半径 = 正相邻**（与 `canStrike` 同判据）——放宽到 2 会出现
 *   "他说被围住了，我却够不着"。
 */
import { describe, expect, it } from 'vitest';
import {
  NPC_DANGER_RANGE,
  NPC_MAX,
  NPC_NAME_MAX,
  NPC_NAME_POOL,
  NPC_TERMS_PER_NPC,
  NPC_TRADES_PER_DAY,
  npcCountFor,
  npcDistress,
  npcFallbackLine,
  npcIdOf,
  npcNameFor,
  npcRescueDedupeKey,
  npcTermsToNext,
  npcTradesLeft,
  normalizeNpcName,
  placeNpcs,
  type NpcCandidate,
  type NpcMonster,
} from './npc.js';

const cand = (termId: string, row: number, col: number): NpcCandidate => ({
  termId,
  term: `词-${termId}`,
  domain: '测试域',
  row,
  col,
});

describe('npcCountFor — 每 8 条词条解锁一位伙伴，下限 1、上限 6', () => {
  it('① 边界：0/7 条 → 1 位（下限）；8/9 条 → 1 位；16 条 → 2 位；封顶 6 位', () => {
    expect(npcCountFor(0)).toBe(1);
    expect(npcCountFor(7)).toBe(1);
    expect(npcCountFor(NPC_TERMS_PER_NPC)).toBe(1);
    expect(npcCountFor(NPC_TERMS_PER_NPC + 1)).toBe(1);
    expect(npcCountFor(NPC_TERMS_PER_NPC * 2)).toBe(2);
    expect(npcCountFor(NPC_TERMS_PER_NPC * NPC_MAX)).toBe(NPC_MAX);
    expect(npcCountFor(9999)).toBe(NPC_MAX);
  });

  it('①b 脏输入不炸：负数 / 小数 / NaN 一律落到下限', () => {
    expect(npcCountFor(-5)).toBe(1);
    expect(npcCountFor(15.9)).toBe(1);
    expect(npcCountFor(Number.NaN)).toBe(1);
  });

  it('①c 激励文案的差值：下限那一位是白送的，故 0 条时下一次要等到 16 条；封顶后为 null', () => {
    // ★ 与「下限 1」一致：0～15 条都只有 1 位伙伴，加第 2 位要 16 条（说 8 就是骗人）
    expect(npcTermsToNext(0)).toBe(NPC_TERMS_PER_NPC * 2);
    expect(npcTermsToNext(NPC_TERMS_PER_NPC)).toBe(NPC_TERMS_PER_NPC);
    expect(npcTermsToNext(NPC_TERMS_PER_NPC * 2 - 1)).toBe(1);
    expect(npcTermsToNext(NPC_TERMS_PER_NPC * NPC_MAX)).toBeNull();
  });
});

describe('placeNpcs — 确定性落位，锚在词条上', () => {
  const pool: NpcCandidate[] = [
    cand('t1', 5, 7),
    cand('t2', 0, 0),
    cand('t3', 3, 3),
    cand('t4', 9, 13),
    cand('t5', 2, 9),
  ];

  it('② 同输入两次 ⇒ 逐字段完全相同（跨端一致的前提）', () => {
    expect(placeNpcs(pool, 3)).toEqual(placeNpcs(pool, 3));
    expect(placeNpcs(pool, 3)).toEqual(placeNpcs([...pool].reverse(), 3));
  });

  it('③ id 形状为 `npc:<termId>`、名字取自名字池、无重复且只落在候选格', () => {
    const out = placeNpcs(pool, 3);
    expect(out).toHaveLength(3);
    const spots = new Set(pool.map((c) => `${c.termId}@${c.row},${c.col}`));
    for (const n of out) {
      expect(n.id).toBe(npcIdOf(n.termId));
      expect(n.id.startsWith('npc:')).toBe(true);
      expect(NPC_NAME_POOL).toContain(n.name);
      expect(spots.has(`${n.termId}@${n.row},${n.col}`)).toBe(true);
    }
    expect(new Set(out.map((n) => n.id)).size).toBe(3);
  });

  it('④ 候选不足时返回实际条数；⑤ 空候选返回空数组（空库例外，UI 必须说实话）', () => {
    expect(placeNpcs(pool, NPC_MAX)).toHaveLength(pool.length);
    expect(placeNpcs([], 3)).toEqual([]);
    expect(placeNpcs(pool, 0)).toEqual([]);
  });

  it('⑤b 同一 termId 的重复候选只落一位伙伴', () => {
    const dupe = [cand('t1', 0, 0), cand('t1', 1, 1)];
    expect(placeNpcs(dupe, 2)).toHaveLength(1);
  });

  it('⑤c 名字确定性：同一条词条任何端同名', () => {
    expect(npcNameFor('t1')).toBe(npcNameFor('t1'));
  });
});

describe('npcDistress — 正相邻的怪才算威胁', () => {
  const npc = { row: 5, col: 5 };
  const body = (termId: string, row: number, col: number): NpcMonster => ({
    termId,
    term: `怪-${termId}`,
    row,
    col,
  });

  it('⑥ 曼哈顿 ≤1 才给威胁；斜对角（距离 2）不算', () => {
    expect(npcDistress(npc, [body('m1', 5, 6)])).toEqual({ termId: 'm1', term: '怪-m1', distance: 1 });
    expect(npcDistress(npc, [body('m1', 4, 6)])).toBeNull();
    expect(npcDistress(npc, [body('m1', 5, 5)])?.distance).toBe(0);
    expect(npcDistress(npc, [])).toBeNull();
    expect(NPC_DANGER_RANGE).toBe(1);
  });

  it('⑥b 多只怪时取最近的；同距按 termId 升序（确定性）', () => {
    const near = npcDistress(npc, [body('m2', 5, 6), body('m1', 4, 5), body('m3', 9, 9)]);
    expect(near?.distance).toBe(1);
    expect(near?.termId).toBe('m1');
  });
});

describe('键与读数', () => {
  it('⑦ 求救单去重键不含会变的数：同一位伙伴恒同一键', () => {
    const id = npcIdOf('t1');
    expect(npcRescueDedupeKey(id)).toBe(npcRescueDedupeKey(id));
    expect(npcRescueDedupeKey(id)).toBe('npc_rescue:npc:t1');
    expect(npcRescueDedupeKey(id)).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/);
  });

  it('⑦b 每日交换余额与名字归一化', () => {
    expect(npcTradesLeft(0)).toBe(NPC_TRADES_PER_DAY);
    expect(npcTradesLeft(NPC_TRADES_PER_DAY)).toBe(0);
    expect(npcTradesLeft(99)).toBe(0);
    expect(normalizeNpcName('  小 白  ')).toBe('小 白');
    expect(normalizeNpcName('一二三四五六七八九十十一十二十三').length).toBe(NPC_NAME_MAX);
    expect(normalizeNpcName('   ')).toBe('');
  });

  it('⑦c 降级台词：永不空回，替换词条名，且确定性', () => {
    const line = npcFallbackLine(npcIdOf('t1'), 0, '主动回忆');
    expect(line).toContain('主动回忆');
    expect(line).toBe(npcFallbackLine(npcIdOf('t1'), 0, '主动回忆'));
    // 词条名缺失时退成一句通用话，不留 `「」` 空引号
    expect(npcFallbackLine(npcIdOf('t2'), 1, '   ')).not.toContain('「」');
  });
});