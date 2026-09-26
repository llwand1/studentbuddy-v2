/**
 * learning/tasks.ts — 派单、判完成、发钥匙（契约 `docs/TERM-CARDS-SPEC.md` §4／§5）。
 *
 * 断言分四组，每组挡一类真会烂掉的东西：
 *  ① 派单：去重键必须让"同一件事"只出现一次（`memory-digest.ts` 那笔学费的正面写法）；
 *  ② 完成：**判据在服务端**——用户点钮不算完成，事实到位才算；
 *  ③ 钥匙：只在 `status` 翻转的那一次发（多实例各跑一份 tick 也不许发第二把）；
 *  ④ 归属：别人的单号在我这里必须是"不存在"，不能是"已做完"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHEST_POOL_SEED } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { chestState } from './chest.js';
import { MAX_OPEN_TASKS, completeTask, dispatchTasks, listTasks, reconcileTasks } from './tasks.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tasks-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY1 = new Date(2026, 8, 25, 9, 0, 0);
const DAY2 = new Date(2026, 8, 26, 9, 0, 0);
const TODAY = '2026-09-25';

function ownTerm(id: string, ownerId = '', name = `词条${id}`): void {
  getDb()
    .prepare('INSERT INTO term_library (id, term, definition, domain, owner_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, '释义', '记忆机制', ownerId);
}

let seq = 0;

/** 灌 n 条提及流水（同日也行：提及侧按**行数**计，契约口径 2 只管复习侧） */
function mention(id: string, n: number, ownerId = ''): void {
  for (let i = 0; i < n; i++) {
    getDb()
      .prepare(
        `INSERT INTO term_mention_log (id, term_id, domain, owner_id, mentioned_day) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`m-${++seq}`, id, '记忆机制', ownerId, TODAY);
  }
}

function review(id: string, day: string): void {
  getDb()
    .prepare(`INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_day) VALUES (?, ?, 0, 1, ?)`)
    .run(`r-${id}-${day}`, id, day);
}

function candidate(id: string, term: string, ownerId = ''): void {
  getDb()
    .prepare(
      `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, aliases, status)
       VALUES (?, ?, ?, '学习方法', '候选释义', '[]', 'pending')`,
    )
    .run(id, ownerId, term);
}

/**
 * 把可抽池压到警戒线以下：拥有底座里的前 12 条 ⇒ 只剩 4 条可抽。
 * ⚠️ 第三个参数**必须传**：`drawablePool` 按**词条名**排除已拥有的，而 `ownTerm` 的默认名
 *   是从 id 拼出来的（`词条pool-必要难度` ≠ `必要难度`）——漏了它这函数就只是在库里堆同名词，
 *   池子一条没少，补池单永远不派（14 个用例里 5 个红的根因就在这）。
 */
function drainPool(): void {
  for (const e of CHEST_POOL_SEED.slice(0, CHEST_POOL_SEED.length - 4)) ownTerm(`pool-${e.term}`, '', e.term);
}

describe('派单', () => {
  it('差一张就升星的词条会被派出来，标题写明目标星', () => {
    ownTerm('t1');
    mention('t1', 6); // 1 + 6 = 7 张 ⇒ ★2，差 1 张到 ★3
    const r = dispatchTasks(null, DAY1);
    expect(r.added).toBe(1);
    const [t] = listTasks(null);
    expect(t?.title).toContain('★3');
    expect(t?.kind).toBe('advance');
    expect(t?.targetStar).toBe(3);
  });

  it('重复派单不堆行：同一个意图撞去重键 ⇒ added 0', () => {
    ownTerm('t1');
    mention('t1', 6);
    expect(dispatchTasks(null, DAY1).added).toBe(1);
    expect(dispatchTasks(null, DAY1).added).toBe(0);
    expect(dispatchTasks(null, DAY2).added).toBe(0); // 换一天再来也不该重复
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM study_task').get()).toMatchObject({ n: 1 });
  });

  it('进度没到 60% 的不派（差得远的活儿不该出现在"今天顺手做掉"里）', () => {
    ownTerm('t1');
    mention('t1', 1); // 2 张 ⇒ ★1，距 ★2 的 4 张差 2 张、pct 0 ⇒ 不算"差一点"
    expect(dispatchTasks(null, DAY1).added).toBe(0);
  });

  it('open 集满 `MAX_OPEN_TASKS` 就不再派', () => {
    for (let i = 1; i <= MAX_OPEN_TASKS + 1; i++) {
      ownTerm(`t${i}`);
      mention(`t${i}`, 6);
    }
    expect(dispatchTasks(null, DAY1).added).toBe(MAX_OPEN_TASKS);
    expect(dispatchTasks(null, DAY1).added).toBe(0);
    expect(listTasks(null).filter((t) => !t.done)).toHaveLength(MAX_OPEN_TASKS);
  });

  it('同一条词不会同时吃两单（推进优先于破停滞）', () => {
    ownTerm('t1');
    mention('t1', 6); // 7 张：既在 4~7 停滞档，又差 1 张升星
    const r = dispatchTasks(null, DAY1);
    expect(r.added).toBe(1);
    expect(listTasks(null).map((t) => t.kind)).toEqual(['advance']);
  });

  it('停在 4～7 且今天没复习的，派破停滞单；今天已经复习过的不派', () => {
    ownTerm('a');
    mention('a', 4); // 5 张：★1，距 ★2 差 3 张 ⇒ 不会被 advance 选中
    ownTerm('b');
    mention('b', 4);
    review('b', TODAY);
    const r = dispatchTasks(null, DAY1);
    expect(r.added).toBe(1);
    const tasks = listTasks(null);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'unstall', termId: 'a' });
  });

  it('补池单只在可抽新词不足时出现，且带上那条待审候选的 id', () => {
    ownTerm('near');
    mention('near', 6);
    expect(listTasks(null)).toHaveLength(0); // 池子还满（16 条），不该催人选词
    drainPool();
    candidate('c1', '睡眠周期');
    const r = dispatchTasks(null, DAY1);
    const pool = listTasks(null).find((t) => t.kind === 'review_pool');
    expect(pool?.title).toContain('睡眠周期');
    expect(r.added).toBeGreaterThan(0);
  });
});

describe('完成判据由服务端算', () => {
  it('没到位就点「我做完了」= not_yet，不发钥匙', () => {
    ownTerm('t1');
    mention('t1', 6);
    const id = dispatchTasks(null, DAY1).taskIds[0] as string;
    const r = completeTask(null, id, DAY1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_yet');
    expect(chestState(null, DAY1).earnedKeys).toBe(0);
    expect(listTasks(null)[0]?.done).toBe(false);
  });

  it('事实到位（卡数升上去）⇒ 这单自动判完成，并发一把赚来的钥匙', () => {
    ownTerm('t1');
    mention('t1', 6);
    const id = dispatchTasks(null, DAY1).taskIds[0] as string;
    mention('t1', 1); // 第 8 张 ⇒ ★3
    const r = completeTask(null, id, DAY1);
    expect(r).toEqual({ ok: true, keyGranted: true });
    expect(listTasks(null)[0]?.done).toBe(true);
    expect(chestState(null, DAY1).earnedKeys).toBe(1);
  });

  it('重复完成不再发第二把钥匙', () => {
    ownTerm('t1');
    mention('t1', 6);
    const id = dispatchTasks(null, DAY1).taskIds[0] as string;
    mention('t1', 1);
    expect(completeTask(null, id, DAY1).ok).toBe(true);
    const again = completeTask(null, id, DAY1);
    expect(again).toEqual({ ok: true, keyGranted: false });
    expect(chestState(null, DAY1).earnedKeys).toBe(1);
    // ★ 连 tick 也不该再发：翻转之后 `status` 已经不是 open
    reconcileTasks(null, DAY2);
    expect(chestState(null, DAY2).earnedKeys).toBe(1);
  });

  it('破停滞单：今天复习一次即完成（不看卡数）', () => {
    ownTerm('a');
    mention('a', 4);
    const id = dispatchTasks(null, DAY1).taskIds[0] as string;
    review('a', TODAY);
    expect(completeTask(null, id, DAY1)).toEqual({ ok: true, keyGranted: true });
  });

  it('补池单：**驳回**也算做完——这一单要的是裁决，不是同意', () => {
    drainPool();
    candidate('c1', '睡眠周期');
    dispatchTasks(null, DAY1);
    const id = (listTasks(null).find((t) => t.kind === 'review_pool') as { id: string }).id;
    expect(completeTask(null, id, DAY1).ok).toBe(false);
    getDb()
      .prepare(
        `UPDATE term_pool_candidate SET status = 'rejected', decided_at = datetime('now') WHERE id = 'c1'`,
      )
      .run();
    expect(completeTask(null, id, DAY1)).toEqual({ ok: true, keyGranted: true });
  });

  it('未知 kind 永不自证完成（将来加新意图忘了在这里判，宁可挂着）', () => {
    getDb()
      .prepare(
        `INSERT INTO study_task (id, owner_id, kind, dedupe_key, title, status)
         VALUES ('x1', '', 'brand_new', 'k1', 't', 'open')`,
      )
      .run();
    expect(reconcileTasks(null, DAY1)).toEqual({ completed: [], keysGranted: 0 });
  });

  it('别人的单号在我这里 = unknown，不是"已做完"', () => {
    ownTerm('t1', 'u1');
    mention('t1', 6, 'u1');
    const id = dispatchTasks('u1', DAY1).taskIds[0] as string;
    mention('t1', 1, 'u1');
    const stolen = completeTask('u2', id, DAY1);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toBe('unknown');
    expect(chestState('u2', DAY1).earnedKeys).toBe(0);
  });
});
