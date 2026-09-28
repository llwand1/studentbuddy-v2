/**
 * npc-move.test — 把一份花名册推进到此刻（契约 `docs/NPC-PARTNER-SPEC.md` §10）。
 *
 * ★ 只测 `advanceParty`（纯函数）。`moveParty` 是它 + 一次读写库的薄壳，
 *   库那一侧由 `npc.test.ts`／`routes/npc.test.ts` 覆盖；在这里再建一次库，
 *   测到的只会是 better-sqlite3 而不是走位。
 *
 * ★★ 这四件事错了都**不会报错**，只会让地图慢慢变得不对劲，所以必须钉死：
 *   ① 两位伙伴**永不重叠**（占用集是逐位现算的，不是查出来的）；
 *   ② 想留在原地的那位**不会被抢位**；
 *   ③ `lastStepAt` 按**整步**推进 —— 抹掉余数会让伙伴越走越慢，这种 bug 肉眼要盯几小时才看得出来；
 *   ④ 没人动时 `moved === 0` —— 它是"这次轮询要不要写库"的唯一依据，恒为真就等于每 20 秒写一次库。
 */
import { describe, it, expect } from 'vitest';
import { NPC_STEP_MS, type NpcPartyMember } from '@sb/shared';
import { advanceParty } from './npc-move.js';
import type { MapScan } from './npc-map.js';

const T0 = 10_000_000;

/** 一块 7×7 全是词条、没有怪的地 */
function scanOf(n = 7): MapScan {
  const candidates = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      candidates.push({ termId: `t${r}-${c}`, term: `词${r}-${c}`, domain: '记忆机制', row: r, col: c });
    }
  }
  return { candidates, monsters: [], terms: candidates.length };
}

function memberOf(over: Partial<NpcPartyMember> = {}): NpcPartyMember {
  return {
    id: 'npc:t3-3',
    name: '小满',
    bio: '',
    termId: 't3-3',
    row: 3,
    col: 3,
    homeRow: 3,
    homeCol: 3,
    lastStepAt: T0,
    stepSeq: 0,
    ...over,
  } as NpcPartyMember;
}

describe('advanceParty — 推进走位', () => {
  it('空名册：不动、不写库', () => {
    expect(advanceParty([], scanOf(), T0)).toEqual({ members: [], moved: 0 });
  });

  it('★ 不到一步的时间 ⇒ moved=0（每 20 秒的轮询多数不该产生写库）', () => {
    const r = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS - 1);
    expect(r.moved).toBe(0);
    expect(r.members[0]).toMatchObject({ row: 3, col: 3 });
  });

  it('满一步 ⇒ 挪一格，stepSeq +1', () => {
    const r = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS);
    expect(r.moved).toBe(1);
    expect(r.members[0]!.stepSeq).toBe(1);
    const m = r.members[0]!;
    expect(Math.abs(m.row - 3) + Math.abs(m.col - 3)).toBe(1);
  });

  it('★ lastStepAt 按整步推进，不抹余数（否则伙伴越走越慢）', () => {
    const r = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS + 12_345);
    expect(r.members[0]!.lastStepAt).toBe(T0 + NPC_STEP_MS);
  });

  it('★ 新成员（lastStepAt=0）这一轮只起表，不瞬移', () => {
    const r = advanceParty([memberOf({ lastStepAt: 0 })], scanOf(), T0);
    expect(r.moved).toBe(0);
    expect(r.members[0]!.lastStepAt).toBe(T0);
    expect(r.members[0]).toMatchObject({ row: 3, col: 3 });
  });

  it('挂机很久 ⇒ 追帧有上限，且仍在活动半径内', () => {
    const r = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS * 9999);
    const m = r.members[0]!;
    expect(m.stepSeq).toBeLessThanOrEqual(8);
    expect(Math.abs(m.row - 3) + Math.abs(m.col - 3)).toBeLessThanOrEqual(3);
  });

  it('★★ 两位伙伴永不重叠（连推 40 轮）', () => {
    let party = [
      memberOf({ id: 'npc:a', termId: 'ta', row: 3, col: 3, homeRow: 3, homeCol: 3 }),
      memberOf({ id: 'npc:b', termId: 'tb', row: 3, col: 4, homeRow: 3, homeCol: 4 }),
      memberOf({ id: 'npc:c', termId: 'tc', row: 4, col: 3, homeRow: 4, homeCol: 3 }),
    ];
    for (let i = 1; i <= 40; i++) {
      party = advanceParty(party, scanOf(), T0 + NPC_STEP_MS * i).members;
      const cells = party.map((m) => `${m.row},${m.col}`);
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it('★ 想留在原地的那位不会被别人抢位', () => {
    // b 还没到时间（lastStepAt 更晚），a 到时间了：a 不许踏进 b 站的那格
    const party = [
      memberOf({ id: 'npc:a', termId: 'ta', row: 0, col: 0, homeRow: 0, homeCol: 0, lastStepAt: T0 }),
      memberOf({
        id: 'npc:b',
        termId: 'tb',
        row: 0,
        col: 1,
        homeRow: 0,
        homeCol: 1,
        lastStepAt: T0 + NPC_STEP_MS,
      }),
    ];
    const r = advanceParty(party, scanOf(), T0 + NPC_STEP_MS);
    expect(`${r.members[0]!.row},${r.members[0]!.col}`).not.toBe('0,1');
    expect(r.members[1]).toMatchObject({ row: 0, col: 1 });
  });

  it('怪的格子照走（"他站在怪的地盘上"正是遇险的画面前提）', () => {
    const scan: MapScan = {
      candidates: [{ termId: 't0', term: '词', domain: 'd', row: 0, col: 0 }],
      monsters: [{ termId: 't1', term: '怪词', domain: 'd', row: 0, col: 1 }],
      terms: 2,
    };
    const m = memberOf({ id: 'npc:t0', termId: 't0', row: 0, col: 0, homeRow: 0, homeCol: 0 });
    const r = advanceParty([m], scan, T0 + NPC_STEP_MS);
    expect(`${r.members[0]!.row},${r.members[0]!.col}`).toBe('0,1');
  });

  it('地图只剩一格 ⇒ 原地不动，moved=0，不抛错', () => {
    const scan: MapScan = {
      candidates: [{ termId: 't0', term: '词', domain: 'd', row: 0, col: 0 }],
      monsters: [],
      terms: 1,
    };
    const m = memberOf({ id: 'npc:t0', termId: 't0', row: 0, col: 0, homeRow: 0, homeCol: 0 });
    const r = advanceParty([m], scan, T0 + NPC_STEP_MS * 3);
    expect(r).toMatchObject({ moved: 0 });
    expect(r.members[0]).toMatchObject({ row: 0, col: 0 });
  });

  it('推进是确定性的：同样的输入两次 ⇒ 同样的位置', () => {
    const a = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS * 5).members[0]!;
    const b = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS * 5).members[0]!;
    expect(`${a.row},${a.col}`).toBe(`${b.row},${b.col}`);
  });

  it('★ 家不变：走位只改 row/col，homeRow/homeCol 与 termId 原样（§9 的救援语义靠它）', () => {
    const r = advanceParty([memberOf()], scanOf(), T0 + NPC_STEP_MS * 6);
    expect(r.members[0]).toMatchObject({ homeRow: 3, homeCol: 3, termId: 't3-3', id: 'npc:t3-3' });
  });
});
