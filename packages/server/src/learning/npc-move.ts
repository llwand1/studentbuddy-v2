/**
 * learning/npc-move — 把伙伴的位置**推进到此刻应有的样子**（契约 `docs/NPC-PARTNER-SPEC.md` §10）。
 *
 * ★★ 「服务端权威位置」的实现方式是**读时推进**，不是新开一个定时器。两者对外行为一致，
 *   但读时推进少了一整套基础设施，且更难出错：
 *     · 位置是 `(家, 步序, 已过时间, 当时可走的格)` 的**纯函数** ⇒ 谁来读、读几次，结果都一样；
 *     · 没人看地图的时候，"他走到哪了"这个问题没有观察者 —— 为它空转一个 30 秒的定时器，
 *       在一个单用户学习应用里是纯浪费（而且进程重启后定时器的相位还会漂）；
 *     · 定时器写库与请求写库并发，就得处理写冲突；读时推进跑在请求的那一 tick 里，天然串行
 *       （`chest.ts` 头注记过同一条理由）。
 *   ⇒ 代价如实写：**两次读之间伙伴不会动**。地图页开着时前端 20 秒轮询一次（§11），
 *   所以用户看到的就是"他在走"；接口不被调用时位置是"懒的"，但没有人能观察到这个差别。
 *
 * ★ 走位的三条约束都在 `shared/npc-life.ts` 的纯函数里（可单测）：只踩词条格、离家不超过
 *   `NPC_WANDER_RADIUS`、不迈进别的伙伴占着的格。本文件只负责"喂数据 + 落库"。
 */
import {
  NPC_STEP_MS,
  npcStepsDue,
  npcWanderStep,
  type NpcPartyMember,
} from '@sb/shared';
import { scanMap, type MapScan } from './npc-map.js';
import { loadParty, saveParty } from './npc-party.js';

const cellKey = (row: number, col: number): string => `${row},${col}`;

export interface MoveResult {
  members: NpcPartyMember[];
  /** 这次推进真的挪动了几位（0 ⇒ 没写库） */
  moved: number;
}

/**
 * 把一份花名册推进到 `now` 时刻。**纯计算**，不碰库（便于单测与 dry-run）。
 *
 * ★ 逐位依次推进而不是并行算：后走的那位要看见先走的那位**新**占的格，
 *   否则两位会同时迈进同一格（占用集是算出来的，不是查出来的）。
 * ★ 走位期间 `occupied` 里**始终含每位伙伴自己当前的格**，只在他自己挪走时让位 ——
 *   否则 A 让出的格会在同一轮里被 B 抢走，而 A 其实是"想留在原地"。
 */
export function advanceParty(
  members: readonly NpcPartyMember[],
  scan: MapScan,
  now: number,
): MoveResult {
  if (members.length === 0) return { members: [...members], moved: 0 };
  // 可走的格 = 所有词条格（含被怪占的：伙伴不怕站在怪的地盘上，那正是"遇险"的画面前提）
  const walkable = new Set<string>();
  for (const c of scan.candidates) walkable.add(cellKey(c.row, c.col));
  for (const c of scan.monsters) walkable.add(cellKey(c.row, c.col));

  const occupied = new Set<string>(members.map((m) => cellKey(m.row, m.col)));
  const out: NpcPartyMember[] = [];
  let moved = 0;

  for (const m of members) {
    const steps = npcStepsDue(m.lastStepAt, now);
    if (steps === 0) {
      // ★ 新成员（`lastStepAt === 0`）在这里**起表**：不起表他永远走不了第一步
      out.push(m.lastStepAt > 0 ? m : { ...m, lastStepAt: now });
      continue;
    }
    let row = m.row;
    let col = m.col;
    let seq = m.stepSeq;
    occupied.delete(cellKey(row, col)); // 他自己要挪，先把原格让出来
    for (let i = 0; i < steps; i += 1) {
      seq += 1;
      const next = npcWanderStep(
        m.id,
        seq,
        { row, col },
        { row: m.homeRow, col: m.homeCol },
        walkable,
        occupied,
      );
      row = next.row;
      col = next.col;
    }
    occupied.add(cellKey(row, col));
    if (row !== m.row || col !== m.col) moved += 1;
    out.push({
      ...m,
      row,
      col,
      stepSeq: seq,
      // ★ 按**整步**推进 `lastStepAt`，不是直接设成 `now`：
      //   设成 now 会把不足一步的余数抹掉，于是每次读都"刚好差一点"，伙伴越走越慢。
      lastStepAt: m.lastStepAt + steps * NPC_STEP_MS,
    });
  }
  return { members: out, moved };
}

/**
 * 读库 → 推进 → 按需写回。**所有读伙伴的入口都该先过这里**，
 * 否则不同接口会给出不同的位置（"图上在这、气泡说在那"）。
 *
 * ★ `moved === 0` 时**不写库**：轮询每 20 秒来一次，而一步要 45 秒 ⇒ 多数轮询不该产生写。
 *   （`lastStepAt` 的起表那次会写，仅一次。）
 */
export function moveParty(
  ownerId: string | null,
  scan: MapScan = scanMap(ownerId),
  now: number = Date.now(),
): NpcPartyMember[] {
  const before = loadParty(ownerId);
  const { members, moved } = advanceParty(before, scan, now);
  const started = members.some((m, i) => m.lastStepAt !== (before[i]?.lastStepAt ?? 0));
  if (moved > 0 || started) saveParty(ownerId, members);
  return members;
}
