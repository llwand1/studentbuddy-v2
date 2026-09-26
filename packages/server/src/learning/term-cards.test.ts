/**
 * learning/term-cards — 卡数的**派生读口**（契约 `docs/TERM-CARDS-SPEC.md` §1）。
 *
 * 本模块没有写入口，所以测试全部是「往两张既有流水里手插行，再读物出来的数对不对」。
 * 断言分五类，每类钉一个会**静默错**的点：
 *  ① 公式：`mentions + 不同复习日 + 1`，且加一行流水**立刻**反映到读数（证明没有落库的缓存列）；
 *  ② 复习侧按**日**去重：一天刷 10 遍只给 1 张——判据与 `EBBINGHAUS-SPEC §10.5` 那条
 *     「同日只推进一次」闸门同源，数行等于把遗忘曲线换成内置作弊器；
 *  ③ **归属不对称**：`term_mention_log` 有 `owner_id`（v31 建）、`term_review_log` 没有
 *     （v22 建、v31 刻意不给）。所以"无主的提及行不能算进登录用户"这一条只有提及侧能违反，
 *     而复习侧是靠**词条集过滤**兜住的——两边各钉一次，改任何一侧的连接写法都会红；
 *  ④ `logSince`：取两侧更早的那个，且**两侧各自的归属过滤都要生效**；
 *  ⑤ `cardWallSummary`：按星/稀有度分桶 + `almostThere` 的窗口（差 ≤2 张且已过 60%）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { cardsByTerm, termCards, cardsLogSince, cardWallSummary } from './term-cards.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-term-cards-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造词条：`owner_id` 走显式列，默认无主（`''`，与 `ownerForWrite(null)` 同口径） */
function seedTerm(id: string, ownerId = ''): void {
  getDb()
    .prepare('INSERT INTO term_library (id, term, definition, domain, owner_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, `词条${id}`, '释义', '测试域', ownerId);
}

/** 手插一条提及流水。★ 不经 `recordMentions`：本模块是**读口**，写入路径已有 `mention.test.ts` 钉 */
function mention(termId: string, day: string, ownerId = ''): void {
  getDb()
    .prepare(
      `INSERT INTO term_mention_log (id, term_id, domain, owner_id, mentioned_day)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`m-${Math.random().toString(36).slice(2)}`, termId, '测试域', ownerId, day);
}

function review(termId: string, day: string, stage = 0): void {
  getDb()
    .prepare(
      `INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_day)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(`r-${Math.random().toString(36).slice(2)}`, termId, stage, day);
}

/** 开一次宝箱并（可选）收下：`accepted = 0` 就是"抽到就走"那一格（口径 4 只数 1） */
function chestGrant(termId: string, accepted: boolean, ownerId = ''): void {
  getDb()
    .prepare(
      `INSERT INTO chest_open (id, owner_id, opened_day, source_kind, pool_term, term_id, accepted)
       VALUES (?, ?, '2026-09-25', 'seed', ?, ?, ?)`,
    )
    .run(`c-${Math.random().toString(36).slice(2)}`, ownerId, termId, termId, accepted ? 1 : 0);
}

describe('卡数派生公式', () => {
  it('一条流水都没有 = 只有建卡那 1 张（★0）', () => {
    seedTerm('t1');
    expect(cardsByTerm(null).get('t1')).toMatchObject({ mentions: 0, reviewDays: 0, cards: 1, star: 0 });
  });

  it('mentions + 复习日 + 1，且星与稀有度取自 shared 的曲线', () => {
    seedTerm('t1');
    mention('t1', '2026-09-20');
    mention('t1', '2026-09-21');
    review('t1', '2026-09-22');
    const c = cardsByTerm(null).get('t1');
    expect(c).toMatchObject({ mentions: 2, reviewDays: 1, cards: 4, star: 2, rarity: 'SR' });
    // ★4 = 2^2 ⇒ 刚好踩在升 ★3 的起点上，进度归零而不是 100%
    expect(c?.progress).toMatchObject({ nextStar: 3, needed: 4, pct: 0 });
  });

  it('加一行流水立刻改变读数 ⇒ 卡数确实是派生值，库里没有缓存列', () => {
    seedTerm('t1');
    mention('t1', '2026-09-20');
    expect(cardsByTerm(null).get('t1')?.cards).toBe(2);
    mention('t1', '2026-09-21');
    expect(cardsByTerm(null).get('t1')?.cards).toBe(3);
  });

  it('不读 usage_count：把计数字段灌满也不影响卡数', () => {
    seedTerm('t1');
    getDb().prepare('UPDATE term_library SET usage_count = 99 WHERE id = ?').run('t1');
    expect(cardsByTerm(null).get('t1')?.cards).toBe(1);
  });

  it('宝箱收下 +1 张、没收下 0 张（口径 4：`accepted = 0` 不算一次接触）', () => {
    seedTerm('t1');
    chestGrant('t1', false);
    expect(cardsByTerm(null).get('t1')).toMatchObject({ chestGrants: 0, cards: 1, star: 0 });
    chestGrant('t1', true);
    // 收下那张 = 2 张 = ★1 ⇒ 宝箱给的新卡天生 ★1，而不是和手动添加完全等价
    expect(cardsByTerm(null).get('t1')).toMatchObject({ chestGrants: 1, cards: 2, star: 1, rarity: 'R' });
  });

  it('宝箱流水也讲归属：别人收下的同一条词条不涨我的卡', () => {
    seedTerm('t1', 'u1');
    chestGrant('t1', true, 'u2'); // 挂在 u1 的词条上、但收下动作属于 u2
    chestGrant('t1', true, ''); // 归主前的无主行
    expect(cardsByTerm('u1').get('t1')).toMatchObject({ chestGrants: 0, cards: 1 });
  });
});

describe('复习侧按日去重（口径 2）', () => {
  it('同一天刷 10 遍只贡献 1 张卡', () => {
    seedTerm('t1');
    for (let i = 0; i < 10; i++) review('t1', '2026-09-23', i);
    const c = cardsByTerm(null).get('t1');
    expect(c).toMatchObject({ reviewDays: 1, cards: 2, star: 1 });
  });

  it('跨到第二天才多给一张', () => {
    seedTerm('t1');
    review('t1', '2026-09-23');
    review('t1', '2026-09-23');
    review('t1', '2026-09-24');
    expect(cardsByTerm(null).get('t1')).toMatchObject({ reviewDays: 2, cards: 3 });
  });
});

describe('归属：两张表的归主方式不同，各钉一次', () => {
  it('无主的提及行不算进登录用户（子查询漏写 owner 条件就是串台）', () => {
    seedTerm('t1', 'u1');
    mention('t1', '2026-09-20', ''); // 归主前落下的无主行
    mention('t1', '2026-09-21');
    mention('t1', '2026-09-22', 'u2'); // 挂在 u1 词条上、但流水归 u2 ⇒ 靠 `m.owner_id = t.owner_id` 挡掉
    expect(cardsByTerm('u1').get('t1')).toMatchObject({ mentions: 0, cards: 1 });
  });

  it('本主的提及行正常计入', () => {
    seedTerm('t1', 'u1');
    mention('t1', '2026-09-22', 'u1');
    expect(cardsByTerm('u1').get('t1')).toMatchObject({ mentions: 1, cards: 2 });
  });

  it('复习侧没有 owner 列：别人的词条根本不出现在我的结果里', () => {
    seedTerm('mine', 'u1');
    seedTerm('theirs', 'u2');
    mention('theirs', '2026-09-22', 'u2');
    review('theirs', '2026-09-22');
    expect([...cardsByTerm('u1').keys()]).toEqual(['mine']);
    expect(termCards('theirs', 'u1')).toBeNull(); // ★ 单条读口同样挡归属
  });

  it('termCards 与 cardsByTerm 对同一条词条给同一个数', () => {
    seedTerm('t1', 'u1');
    mention('t1', '2026-09-20', 'u1');
    mention('t1', '2026-09-21', 'u1');
    review('t1', '2026-09-22');
    expect(termCards('t1', 'u1')).toEqual(cardsByTerm('u1').get('t1'));
  });
});

describe('logSince（UI 自解释用的统计起点）', () => {
  it('两侧都没有流水 = null，不是空串', () => {
    seedTerm('t1');
    expect(cardsLogSince(null)).toBeNull();
  });

  it('取两侧更早的那个日', () => {
    seedTerm('t1');
    review('t1', '2026-09-10');
    mention('t1', '2026-09-20');
    expect(cardsLogSince(null)).toBe('2026-09-10');
  });

  it('别人的流水不能决定我的起点（提及侧按列、复习侧按连接）', () => {
    seedTerm('mine', 'u1');
    seedTerm('theirs', 'u2');
    mention('theirs', '2026-09-01', 'u2');
    review('theirs', '2026-09-02');
    mention('mine', '2026-09-15', 'u1');
    expect(cardsLogSince('u1')).toBe('2026-09-15');
  });
});

describe('cardWallSummary', () => {
  it('按星分桶，下标即星级', () => {
    seedTerm('a');
    seedTerm('b');
    seedTerm('c');
    for (let i = 0; i < 3; i++) mention('c', `2026-09-1${i}`); // c: 1+3=4 张 ⇒ ★2
    mention('b', '2026-09-15'); // b: 2 张 ⇒ ★1
    const s = cardWallSummary(null);
    expect(s.totalTerms).toBe(3);
    expect(s.byStar[0]).toBe(1); // a：只有建卡那张
    expect(s.byStar[1]).toBe(1);
    expect(s.byStar[2]).toBe(1);
    expect(s.byStar.length).toBe(9); // ★0..★8
    expect(s.totalCards).toBe(1 + 2 + 4);
  });

  it('稀有度按卡数分档，全库 ★0 也不会显得空（N 兜底）', () => {
    seedTerm('a');
    seedTerm('b');
    mention('b', '2026-09-15');
    expect(cardWallSummary(null).byRarity).toEqual({ N: 1, R: 1, SR: 0, SSR: 0 });
  });

  it('almostThere 只数「差 ≤2 张且已完成 ≥60%」，封顶的那条不算', () => {
    seedTerm('near'); // 6 张：★2（4）→ ★3（8），差 2 张、pct 0.5 ⇒ 不算
    for (let i = 0; i < 5; i++) mention('near', `2026-09-1${i}`);
    seedTerm('close'); // 7 张：差 1 张、pct 0.75 ⇒ 算
    for (let i = 0; i < 6; i++) mention('close', `2026-09-1${i}`);
    seedTerm('max');
    for (let i = 0; i < 255; i++) mention('max', '2026-09-01'); // 256 张 = ★8 封顶
    const s = cardWallSummary(null);
    expect(s.byStar[8]).toBe(1);
    expect(s.almostThere).toBe(1);
  });
});
