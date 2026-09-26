/**
 * learning/chest — 每日宝箱的钥匙账、抽卡去重、收下入库（契约 `docs/TERM-CARDS-SPEC.md` §3／§6）。
 *
 * ★ 全部走注入的 `now`：跨日归零这件事**不能靠改系统时钟**测（同 `mention.test.ts` 的判据）。
 *   `DAY1` / `DAY2` 是两个本地日历日，晚上十一点那格也在这里覆盖——UTC 日与本地日差一天的
 *   正是那一格（`term-review.ts` 为同一件事写过注释）。
 * 断言分三组，每组挡一类真会犯的错：
 *  ① 钥匙账：三本数（免费已用／赚来的／今日已开）各管各的，合并任何两列都会在这一组红；
 *  ② 去重：同名／撞别名（**两个方向**）／已抽过，三段缺一都会让用户第二天又见到昨天那张卡；
 *  ③ 收下：`accepted` 与 `in_scope` 是三态里的两态，默认不勾复习（v28 口径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHEST_POOL_SEED, DAILY_OPEN_CAP, FREE_OPENS_PER_DAY } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { IN_SCOPE, SCOPE_FROM } from './term-review.js';
import { acceptDraw, chestState, drawablePool, grantEarnedKey, openChest } from './chest.js';
import { termCards } from './term-cards.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chest-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 两个本地日历日：跨日归零与「晚上不该被算成前一天」都靠这一对测 */
const DAY1 = new Date(2026, 8, 25, 9, 0, 0);
const DAY1_LATE = new Date(2026, 8, 25, 23, 30, 0);
const DAY2 = new Date(2026, 8, 26, 9, 0, 0);

function ownTerm(term: string, ownerId = '', aliases: string[] = []): void {
  getDb()
    .prepare('INSERT INTO term_library (id, term, definition, domain, owner_id, aliases) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`t-${term}`, term, '释义', '记忆机制', ownerId, JSON.stringify(aliases));
}

function candidate(term: string, status: 'pending' | 'approved' | 'rejected', ownerId = ''): void {
  getDb()
    .prepare(
      `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, aliases, status)
       VALUES (?, ?, ?, '学习方法', '候选释义', '[]', ?)`,
    )
    .run(`c-${status}-${term}`, ownerId, term, status);
}

/** 连开 n 次；返回成功次数与最后一次的结果，用于日上限那类"数次数"的断言 */
function openTimes(n: number, now = DAY1): { opened: number; lastFail: string | null } {
  let opened = 0;
  let lastFail: string | null = null;
  for (let i = 0; i < n; i++) {
    const r = openChest(null, now);
    if (r.ok) opened += 1;
    else lastFail = r.reason;
  }
  return { opened, lastFail };
}

describe('钥匙账', () => {
  it('新的一天从三把免费开始', () => {
    const s = chestState(null, DAY1);
    expect(s).toMatchObject({ freeUsed: 0, freeLeft: FREE_OPENS_PER_DAY, earnedKeys: 0, openedToday: 0 });
    expect(s.left).toEqual({ left: FREE_OPENS_PER_DAY, reason: 'ok' });
  });

  it('开满三次后 = exhausted，面板要说「完成一单再加一次」那种话', () => {
    expect(openTimes(3)).toEqual({ opened: 3, lastFail: null });
    const fourth = openChest(null, DAY1);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe('exhausted');
    expect(chestState(null, DAY1)).toMatchObject({ freeUsed: 3, freeLeft: 0, earnedKeys: 0 });
  });

  it('赚来的钥匙跨日不清零，免费次数跨日归零', () => {
    grantEarnedKey(null, DAY1);
    grantEarnedKey(null, DAY1);
    expect(openTimes(5, DAY1)).toEqual({ opened: 5, lastFail: null }); // 3 免费 + 2 赚
    const lateNight = chestState(null, DAY1_LATE); // 同一天深夜：仍是今天，不许提前归零
    expect(lateNight).toMatchObject({ freeUsed: 3, earnedKeys: 0, openedToday: 5 });
    const next = chestState(null, DAY2);
    expect(next).toMatchObject({ freeUsed: 0, freeLeft: 3, earnedKeys: 0, openedToday: 0 });
  });

  it('囤 20 把钥匙也一天只能开 8 次，且原因要说得出是「开满了」不是「没钥匙」', () => {
    for (let i = 0; i < 20; i++) grantEarnedKey(null, DAY1);
    const r = openTimes(DAILY_OPEN_CAP + 3, DAY1);
    expect(r.opened).toBe(DAILY_OPEN_CAP);
    expect(r.lastFail).toBe('capped');
    const s = chestState(null, DAY1);
    expect(s.left.reason).toBe('capped');
    expect(s.earnedKeys).toBeGreaterThan(0); // ★ 钥匙还有，只是今天不许多开
  });

  it('失败的那一次不扣钥匙', () => {
    for (const e of CHEST_POOL_SEED) ownTerm(e.term); // 整池都抽不到
    const r = openChest(null, DAY1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
    expect(chestState(null, DAY1)).toMatchObject({ freeUsed: 0, openedToday: 0 });
  });
});

describe('抽卡去重（三段，缺一即重演「昨天那张又来啦」）', () => {
  it('空库 = 底座 16 条全可抽', () => {
    expect(drawablePool(null)).toHaveLength(CHEST_POOL_SEED.length);
  });

  it('① 库里同名的不抽', () => {
    ownTerm('组块');
    const names = drawablePool(null).map((p) => p.entry.term);
    expect(names).not.toContain('组块');
    expect(names).toHaveLength(CHEST_POOL_SEED.length - 1);
  });

  it('② 撞别名两个方向都挡：池子条目的别名撞上正名、正名撞上用户的别名', () => {
    ownTerm('精加工'); // 池子条目「精细加工」的 alias 里有它
    expect(drawablePool(null).map((p) => p.entry.term)).not.toContain('精细加工');
    ownTerm('某个本地叫法', '', ['必要难度']); // 用户给词条起的别名撞上池子正名
    expect(drawablePool(null).map((p) => p.entry.term)).not.toContain('必要难度');
  });

  it('③ 抽过的永不再来：收下与否都算抽过', () => {
    const first = openChest(null, DAY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(drawablePool(null).map((p) => p.entry.term)).not.toContain(first.draw.term);
    expect(chestState(null, DAY1).poolLeft).toBe(CHEST_POOL_SEED.length - 1);
    acceptDraw(null, first.draw.openId, false); // 收下之后仍然不该再抽到同一条
    expect(drawablePool(null).map((p) => p.entry.term)).not.toContain(first.draw.term);
  });

  it('候选：pending / rejected 都不可抽，approved 才进池', () => {
    candidate('睡眠周期', 'pending');
    candidate('编码特异性', 'rejected');
    expect(drawablePool(null).map((p) => p.entry.term)).not.toContain('睡眠周期');
    getDb().prepare(`UPDATE term_pool_candidate SET status = 'approved' WHERE term = '睡眠周期'`).run();
    expect(drawablePool(null).map((p) => p.entry.term)).toContain('睡眠周期');
  });

  it('底座里不许有同名条目（同名 = 两条 slug 撞车，去重判据会看错行）', () => {
    const seen = new Set<string>();
    for (const e of CHEST_POOL_SEED) {
      expect(seen.has(e.term)).toBe(false);
      seen.add(e.term);
    }
  });
});

describe('收下这张卡', () => {
  it('不收下 = 库里没有它，那张卡也就根本不存在（口径 4）', () => {
    const r = openChest(null, DAY1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_library').get()).toMatchObject({ n: 0 });
    expect(termCards(`t-${r.draw.term}`, null)).toBeNull();
  });

  it('收下 = 进本主的库，并且天生 ★1（1 建卡 + 1 宝箱）', () => {
    const r = openChest(null, DAY1);
    if (!r.ok) throw new Error('开盒失败');
    const a = acceptDraw(null, r.draw.openId, false);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.cards).toMatchObject({ cards: 2, star: 1, chestGrants: 1, mentions: 0, reviewDays: 0 });
    const row = getDb()
      .prepare('SELECT term, definition, domain, owner_id, review_enabled FROM term_library WHERE id = ?')
      .get(a.termId) as { term: string; definition: string; domain: string; owner_id: string; review_enabled: number };
    expect(row).toMatchObject({ term: r.draw.term, owner_id: '', review_enabled: null });
    expect(row.definition.length).toBeGreaterThan(4); // ★ 释义来自流水快照，不是空串
    expect(a.inScope).toBe(false);
  });

  it('只有勾了「纳入复习」的那一枚钮才把词条推进复习范围（v28 默认全不选）', () => {
    const r = openChest(null, DAY1);
    if (!r.ok) throw new Error('开盒失败');
    const a = acceptDraw(null, r.draw.openId, true);
    if (!a.ok) throw new Error('收下失败');
    const hit = getDb()
      .prepare(`SELECT t.id FROM ${SCOPE_FROM} WHERE ${IN_SCOPE} AND t.id = ?`)
      .get(a.termId) as { id: string } | undefined;
    expect(hit?.id).toBe(a.termId);
    expect(getDb().prepare('SELECT in_scope FROM chest_open WHERE id = ?').get(r.draw.openId)).toMatchObject({
      in_scope: 1,
    });
  });

  it('重复收下 = 409，不会写出第二条词条', () => {
    const r = openChest(null, DAY1);
    if (!r.ok) throw new Error('开盒失败');
    expect(acceptDraw(null, r.draw.openId, false).ok).toBe(true);
    const again = acceptDraw(null, r.draw.openId, false);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(409);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_library').get()).toMatchObject({ n: 1 });
  });

  it('别人的开盒收不进我的库（404，不是静默成功）', () => {
    const r = openChest(null, DAY1);
    if (!r.ok) throw new Error('开盒失败');
    const stolen = acceptDraw('u2', r.draw.openId, false);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.status).toBe(404);
  });

  it('待处理那张跨请求回读：刷新页面后卡还在，收下后消失', () => {
    const r = openChest(null, DAY1);
    if (!r.ok) throw new Error('开盒失败');
    const s = chestState(null, DAY1);
    expect(s.pending).toMatchObject({ term: r.draw.term, cost: null }); // ★ 库里没存花的是哪本账 ⇒ null，不编
    acceptDraw(null, r.draw.openId, false);
    expect(chestState(null, DAY1).pending).toBeNull();
  });
});
