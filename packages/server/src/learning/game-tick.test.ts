/**
 * learning/game-tick — 6 小时心跳上的三件主动事（契约 `docs/TERM-CARDS-SPEC.md` §5／§7.2）。
 *
 * ★ 观察方式同 `card-announce.test.ts`：进程内驱动 + 读 `sse-bus` 缓冲区，不 mock `publish`。
 *   ⚠️ 缓冲区是模块级单例，`beforeEach` 重开库清不掉 ⇒ 一切断言走**差值**口径。
 *
 * 本文件最该锁的一条是 ①「只存了词、还没聊过天的人也在名单里」——它是 `gameOwners()`
 * 不按 `trendOwners()`（那张是提及流水）取人的**唯一**理由，也是本功能立项理由
 * （产品没有主动性）能不能成立的判据。这条一旦有人"顺手统一成 trendOwners"，
 * 全体新用户在第一周都不会收到任何主动通知，而**没有任何别的用例会红**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHEST_POOL_SEED, cardsChannel, type SseEvent } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { snapshot } from '../chat/sse-bus.js';
import { chestState, openChest } from './chest.js';
import { gameOwners, runGameTick } from './game-tick.js';
import { saveOneTerm } from './terms.js';
import { listTasks } from './tasks.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-game-tick-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY1 = new Date(2026, 8, 25, 9, 0, 0);
const DAY2 = new Date(2026, 8, 26, 9, 0, 0);

function ownTerm(term: string, ownerId = ''): string {
  return saveOneTerm(term, `${term} 的释义`, '记忆机制', ownerId).id ?? '';
}

/** 把某人的可抽池压到警戒线以下（拥有底座前 12 条 ⇒ 只剩 4 条），并塞一条待审候选 */
function drainAndSeedCandidate(ownerId: string): string {
  for (const e of CHEST_POOL_SEED.slice(0, CHEST_POOL_SEED.length - 4)) ownTerm(e.term, ownerId);
  getDb()
    .prepare(
      `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, status)
       VALUES ('c1', ?, '睡眠周期', '记忆机制', '候选释义', 'pending')`,
    )
    .run(ownerId);
  return 'c1';
}

function frames<T extends SseEvent['type']>(ownerId: string | null, type: T, mark: number) {
  return snapshot(cardsChannel(ownerId))
    .filter((e): e is Extract<SseEvent, { type: T }> => e.type === type)
    .slice(mark);
}

let seq = 0;

/** 灌 n 行提及流水（同日也行：提及侧按行数计，契约 §1 口径 2 只管复习侧） */
function mention(termId: string, ownerId: string, n: number): void {
  const ins = getDb().prepare(
    'INSERT INTO term_mention_log (id, term_id, domain, owner_id, mentioned_day) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i++) ins.run(`m-${++seq}`, termId, '记忆机制', ownerId, '2026-09-25');
}

describe('gameOwners', () => {
  it('① 取人的起点是**词条库**，不是提及流水：只存了词、没聊过天的人也在名单里', () => {
    ownTerm('必要难度', 'u-new');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_mention_log').get()).toMatchObject({ n: 0 });
    expect(gameOwners()).toEqual(['u-new']);
  });

  it('具名 owner 存在时不再为匿名桶跑（无主行是老数据，不该收到主动通知）', () => {
    ownTerm('系列位置效应'); // 无主行
    expect(gameOwners()).toEqual([null]);
    ownTerm('睡眠巩固', 'u1');
    expect(gameOwners()).toEqual(['u1']);
  });
});

describe('派单那一帧', () => {
  it('补池单在 tick 里派出，并广播 `task_dispatched`；再跑一次 tick 不重复派、不重复推', () => {
    drainAndSeedCandidate('u1');
    const before = frames('u1', 'task_dispatched', 0).length;
    const r = runGameTick(DAY1);
    expect(r.added).toBe(1);
    expect(frames('u1', 'task_dispatched', before)).toHaveLength(1);
    expect(listTasks('u1').map((t) => t.kind)).toEqual(['review_pool']);
    // ★ 幂等键 + `MAX_OPEN_TASKS` 双重挡重复：第二圈既不多一行也不多发帧
    const b2 = frames('u1', 'task_dispatched', 0).length;
    expect(runGameTick(DAY1).added).toBe(0);
    expect(frames('u1', 'task_dispatched', b2)).toHaveLength(0);
  });

  it('事实早已到位的单在 tick 里就被判完成，钥匙跟着翻转发一次', () => {
    const id = ownTerm('组块', 'u2');
    mention(id, 'u2', 6); // 7 张 ⇒ ★2，距 ★3（8 张）差 1 张、进度 75% ⇒ 会被派推进单
    runGameTick(DAY1);
    const open = listTasks('u2').filter((t) => !t.done);
    expect(open.map((t) => t.kind)).toEqual(['advance']);
    expect(chestState('u2', DAY1).earnedKeys).toBe(0);
    // 再提一张 ⇒ 推进单的条件到位（★3 = 8 张），tick 尾部的对账该把它翻成 done 并发钥匙
    mention(id, 'u2', 1);
    runGameTick(DAY1);
    expect(chestState('u2', DAY1).earnedKeys).toBe(1);
    runGameTick(DAY2);
    expect(chestState('u2', DAY2).earnedKeys).toBe(1); // ★ 第二圈不再发第二把
  });
});

describe('提醒开箱那一帧', () => {
  it('一天只推一条：同一天跑三次 tick 只有一帧，换日才再来一条', () => {
    ownTerm('精细加工', 'u3');
    expect(frames('u3', 'chest_ready', 0)).toHaveLength(0);
    runGameTick(DAY1);
    runGameTick(DAY1);
    expect(frames('u3', 'chest_ready', 0)).toHaveLength(1);
    expect(frames('u3', 'chest_ready', 0)[0]).toMatchObject({ openedDay: '2026-09-25', left: 3 });
    runGameTick(DAY2);
    expect(frames('u3', 'chest_ready', 1)).toHaveLength(1);
  });

  it('没得可开就不推（免费三次用完后，tick 不会催一个人去点开不动的箱子）', () => {
    ownTerm('学习错觉', 'u4');
    for (let i = 0; i < 3; i++) expect(openChest('u4', DAY1).ok).toBe(true);
    runGameTick(DAY1);
    expect(frames('u4', 'chest_ready', 0)).toHaveLength(0);
    // ★★ 反向半句（第一版用例把这条写错了，写成了"第二天也不推"——那才是错的读法）：
    //   换到第二天 3 把免费重新到手，**就该推**。挡它的是"没钥匙"，不是"昨天推过"。
    //   这一格必须留着：它区分了 `left === 0` 与日级闸门这两个不同的挡板，
    //   哪天有人把闸门写成"永远只推一次"，只有这半句会红。
    runGameTick(DAY2);
    expect(frames('u4', 'chest_ready', 0)).toHaveLength(1);
  });

  it('池子空了也不推：提醒一个人去开一个抽不出东西的箱子，比不提醒更坏', () => {
    for (const e of CHEST_POOL_SEED) ownTerm(e.term, 'u5');
    const before = frames('u5', 'chest_ready', 0).length;
    runGameTick(DAY1);
    expect(frames('u5', 'chest_ready', before)).toHaveLength(0);
    // ★ 反向半句：闸门是"没词"这一条挡的，不是"没钥匙"（他三次免费全没动）
    expect(chestState('u5', DAY1).left.left).toBe(3);
  });
});
