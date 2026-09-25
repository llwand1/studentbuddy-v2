/**
 * routes/cards — 卡牌／宝箱／任务清单的端到端（契约 `docs/TERM-CARDS-SPEC.md` §7／§11）。
 *
 * ★ 手法照 `terms-tenancy.test.ts`：真 app + supertest + 两个真账号，**不 mock 归属**。
 *
 * 本文件最该锁的三件事，都不是"返回 200"：
 *  ① **`GET /state` 里的等式**：`summary.totalCards` 必须等于 `wall` 各项卡数之和、
 *     `totalTerms === wall.length`。这条是"一次取数"这个设计的全部意义（文件头①），
 *     拆开取数时它可能偶然成立，一起取数时它恒成立——所以要断言的是**关系**而不是数字；
 *  ② **跨用户零串台**（契约 §11 判据 6）：A 的开盒、A 的单、A 的事件帧，在 B 的 `/state`
 *     与 B 的 `/live` 里必须是**空/默认值**。★ 用"另一个人拿到空"来断言，
 *     不用"不是 A 的值"（后者在两人恰好相等时会假绿，这条判据抄自 tenancy 那片）；
 *  ③ **完成判定不在 HTTP 层**：`POST /tasks/:id/done` 在事实不到位时必须是 409，
 *     而不是 200 —— 否则一个 curl 就能刷满钥匙，整个宝箱与当日 8 次上限当天脱钩。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';
import type { CardsStateResponse } from './cards.js';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-cards-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  return `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`;
}

const req = {
  get: (url: string, cookie = '') => {
    const r = request(app).get(url).set('Origin', origin);
    return cookie ? r.set('Cookie', cookie) : r;
  },
  post: (url: string, cookie: string, body?: unknown) =>
    request(app).post(url).set('Origin', origin).set('Cookie', cookie).send((body ?? {}) as object),
};

const cookieA = await signUp('ca-a@example.com');
const cookieB = await signUp('ca-b@example.com');
const meA = await req.get('/api/auth/me', cookieA);
const meB = await req.get('/api/auth/me', cookieB);
const idA = meA.body.user.id as string;
const idB = meB.body.user.id as string;

/** 玩法这七张表全清（`term_domain` 不清：它由写路径懒建，留着不影响判据，清它会连累别的用例） */
beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  const db = getDb();
  for (const t of [
    'term_library',
    'term_mention_log',
    'term_review_log',
    'chest_keys',
    'chest_open',
    'study_task',
    'term_pool_candidate',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterAll(() => closeDb());

const addTerm = async (term: string, cookie = cookieA, domain = '记忆机制') => {
  const r = await request(app).post('/api/terms').set('Origin', origin).set('Cookie', cookie).send({
    term,
    definition: `${term} 的释义`,
    domain,
  });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
};

/** 灌 n 行提及流水（走 HTTP 也能灌，但这里要的是精确条数，直连更快且零歧义） */
function mention(termId: string, ownerId: string, n: number): void {
  const ins = getDb().prepare(
    'INSERT INTO term_mention_log (id, term_id, domain, owner_id, mentioned_day) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i++) ins.run(`m-${ownerId}-${termId}-${i}`, termId, '记忆机制', ownerId, '2026-09-25');
}

async function state(cookie = cookieA): Promise<CardsStateResponse> {
  const r = await req.get('/api/cards/state', cookie).expect(200);
  return r.body as CardsStateResponse;
}

describe('GET /state', () => {
  it('空库也是 200 且四块齐全（首屏不许白屏，`logSince` 无流水时是 null 而不是编一个日期）', async () => {
    const s = await state();
    expect(s.summary).toMatchObject({ totalTerms: 0, totalCards: 0, almostThere: 0 });
    expect(s.wall).toEqual([]);
    expect(s.logSince).toBeNull();
    expect(s.chest.freeLeft).toBe(3);
    expect(s.tasks).toEqual([]);
    expect(s.candidates).toEqual([]);
  });

  it('★ 汇总与墙是**同一次取数**：totalCards 恒等于墙上各项之和', async () => {
    const a = await addTerm('主动回忆');
    const b = await addTerm('间隔重复');
    mention(a, idA, 3);
    mention(b, idA, 1);
    const s = await state();
    expect(s.wall.map((w) => w.term).sort()).toEqual(['主动回忆', '间隔重复']);
    expect(s.summary.totalTerms).toBe(s.wall.length);
    expect(s.summary.totalCards).toBe(s.wall.reduce((n, w) => n + w.card.cards, 0));
    expect(s.summary.totalCards).toBe(4 + 2); // (1+3) + (1+1)
    expect(s.logSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('`inScope` 回的是**现算的有效范围**（继承领域默认也算），前端不许自己 COALESCE', async () => {
    await addTerm('生成效应');
    const [row] = (await state()).wall;
    expect(row?.inScope).toBe(false); // v28 起新词条默认不在复习范围
    expect(getDb().prepare('SELECT review_enabled FROM term_library').get()).toMatchObject({ review_enabled: null });
  });

  it('★ 领域取色键 `domIndex` = **在册序号**：同域同值、后登记的号更大、未登记的域名给 null', async () => {
    await addTerm('主动回忆'); // 域 '记忆机制'（第一次写词条时懒登记 ⇒ 它是本用例里最早上册的）
    await addTerm('加工层级', cookieA, '记忆机制'); // 同域 ⇒ 与上者同号
    await addTerm('元认知', cookieA, '迁移域'); // 后登记的**领域** ⇒ 号更大（第一个参数是词条名）
    getDb()
      .prepare("INSERT INTO term_library (id, term, definition, domain, owner_id) VALUES ('orphan-1', '孤儿词', '释义', '幽灵域', ?)")
      .run(idA); // ★ 直接插一行、绕过登记，库里真出现"词条的域不在册"那个形状（`domainStats` 的 UNION 支路）

    const wall = (await state()).wall;
    const idxOf = (t: string): number => {
      const v = wall.find((w) => w.term === t)?.domIndex;
      if (typeof v !== 'number') throw new Error(`${t} 的 domIndex 不是数：${String(v)}`);
      return v;
    };
    expect(idxOf('加工层级')).toBe(idxOf('主动回忆'));
    expect(idxOf('元认知')).toBeGreaterThan(idxOf('主动回忆'));
    // ★ 未登记必须是 **null 而不是补一个序号**：补了就等于"多出来的领域会把已有领域的颜色挤掉一档"，
    //   而 `game.css` 的彩环只有 5 支（`--gm-dom-1..5`）——前端拿到 null 走中性档 `gm-d0`。
    expect(wall.find((w) => w.term === '孤儿词')?.domIndex).toBeNull();
  });
});

describe('宝箱', () => {
  it('开一次 ⇒ 200 带抽到的卡与当下的钥匙账；连开四次 ⇒ 第四次 409 且响应里带着禁用的理由', async () => {
    const first = await req.post('/api/cards/chest/open', cookieA).expect(200);
    expect(first.body.draw).toMatchObject({ source: 'seed' });
    expect(first.body.state.freeLeft).toBe(2);
    expect(typeof first.body.draw.definition).toBe('string');
    expect(first.body.draw.definition.length).toBeGreaterThan(0); // ★ 快照带释义（v45 的 `pool_definition`）

    await req.post('/api/cards/chest/open', cookieA).expect(200);
    await req.post('/api/cards/chest/open', cookieA).expect(200);
    const fourth = await req.post('/api/cards/chest/open', cookieA).expect(409);
    expect(fourth.body.code).toBe('CHEST_EXHAUSTED');
    expect(fourth.body.chest.left).toMatchObject({ left: 0, reason: 'exhausted' });
  });

  it('收下 ⇒ 词条进库、天生 ★1；`review` 必须是真布尔（脏值 "false" 要 400，不能静默当真）', async () => {
    const opened = await req.post('/api/cards/chest/open', cookieA).expect(200);
    const openId = opened.body.draw.openId as string;

    await req.post('/api/cards/chest/accept', cookieA, { openId, review: 'false' }).expect(400);
    await req.post('/api/cards/chest/accept', cookieA, { openId }).expect(400);

    const ok = await req.post('/api/cards/chest/accept', cookieA, { openId, review: true }).expect(200);
    expect(ok.body.card).toMatchObject({ cards: 2, star: 1, chestGrants: 1 });
    expect(ok.body.inScope).toBe(true);
    const s = await state();
    expect(s.wall.map((w) => w.term)).toContain(opened.body.draw.term);
    // ★ 同一条再收一次 = 409（收过一次之后它已在库里，重复收下会把卡数灌成 3）
    await req.post('/api/cards/chest/accept', cookieA, { openId, review: false }).expect(409);
  });

  it('不收下的那张仍然烧掉钥匙、仍进"已抽过"集（否则不满意就能白刷到满意）', async () => {
    const opened = await req.post('/api/cards/chest/open', cookieA).expect(200);
    const s = await state();
    expect(s.wall).toHaveLength(0); // 库里没有它
    expect(s.chest.freeLeft).toBe(2); // 钥匙照样少一把
    expect(s.chest.pending).toMatchObject({ openId: opened.body.draw.openId });
    expect(s.chest.pending?.cost).toBeNull(); // ★ 回读时不编造"这次花的是哪本账"
  });
});

describe('任务清单', () => {
  /** 直接插一单推进（派单本身由 `game-tick.test.ts` 锁，这里只验 HTTP 的判定权） */
  function seedAdvanceTask(termId: string, targetStar: number, ownerId = idA): string {
    const id = `task-${termId}-${targetStar}`;
    getDb()
      .prepare(
        `INSERT INTO study_task (id, owner_id, kind, dedupe_key, title, why, term_id, target_star, status)
         VALUES (?, ?, 'advance', ?, ?, '', ?, ?, 'open')`,
      )
      .run(id, ownerId, `advance:${termId}:${targetStar}`, `把「X」推到 ★${targetStar}`, termId, targetStar);
    return id;
  }

  it('★ 事实不到位时点「我做完了」= 409，钥匙一把不发', async () => {
    const termId = await addTerm('交错练习');
    mention(termId, idA, 6); // 7 张 ⇒ ★2，离 ★3 还差一张
    const id = seedAdvanceTask(termId, 3);
    const r = await req.post(`/api/cards/tasks/${id}/done`, cookieA).expect(409);
    expect(r.body.code).toBe('not_yet');
    expect((await state()).chest.earnedKeys).toBe(0);
  });

  it('事实到位 ⇒ 200 发一把；重复点不再发第二把；别人的单号 = 404', async () => {
    const termId = await addTerm('元认知校准');
    mention(termId, idA, 7); // 8 张 ⇒ ★3，判据已满足
    const id = seedAdvanceTask(termId, 3);
    const done = await req.post(`/api/cards/tasks/${id}/done`, cookieA).expect(200);
    expect(done.body).toMatchObject({ ok: true, keyGranted: true });
    const again = await req.post(`/api/cards/tasks/${id}/done`, cookieA).expect(200);
    expect(again.body).toMatchObject({ keyGranted: false });
    expect((await state()).chest.earnedKeys).toBe(1);
    await req.post(`/api/cards/tasks/${id}/done`, cookieB).expect(404);
    expect((await state(cookieB)).chest.earnedKeys).toBe(0); // ★ B 的账没被 A 的单动过
  });
});

describe('词池候选裁决', () => {
  function seedCandidate(id: string, ownerId = idA, term = '睡眠周期'): void {
    getDb()
      .prepare(
        `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, status)
         VALUES (?, ?, ?, '记忆机制', '释义', 'pending')`,
      )
      .run(id, ownerId, term);
  }

  it('通过 ⇒ 进可抽池；再裁决同一条 = 409；驳回也算裁决（补池单要的是动作不是同意）', async () => {
    seedCandidate('c1');
    // ★ 两条候选**必须不同名**：`UNIQUE(owner_id, term, domain)` 是 v45 建表时刻意照抄
    //   `term_library` 的弱约束（它不防别名撞车，防的是同一条被生成两遍）——同名第二条直接进不了库。
    seedCandidate('c2', idA, '系列位置效应');
    const before = (await state()).chest.poolLeft;
    await req.post('/api/cards/pool/c1/decide', cookieA, { approved: true }).expect(200);
    expect((await state()).chest.poolLeft).toBe(before + 1);
    await req.post('/api/cards/pool/c1/decide', cookieA, { approved: false }).expect(409);
    await req.post('/api/cards/pool/c2/decide', cookieA, { approved: false }).expect(200);
    // ★ 驳回的那条**留在表里**（不许删）：下次生成同一个词时它撞 `UNIQUE` 而不再骚扰用户
    expect(getDb().prepare('SELECT status FROM term_pool_candidate WHERE id = ?').get('c2')).toMatchObject({
      status: 'rejected',
    });
    expect((await state()).candidates.map((c) => c.id)).toEqual([]);
  });

  it('裁决一张挂着补池单的候选 ⇒ 顺手把那一单结了（`keysGranted` 回在响应里）', async () => {
    seedCandidate('c3');
    getDb()
      .prepare(
        `INSERT INTO study_task (id, owner_id, kind, dedupe_key, title, why, ref_id, status)
         VALUES ('t-pool', ?, 'review_pool', 'pool:记忆机制:睡眠周期', '审一条新词', '', 'c3', 'open')`,
      )
      .run(idA);
    const r = await req.post('/api/cards/pool/c3/decide', cookieA, { approved: true }).expect(200);
    expect(r.body.keysGranted).toBe(1);
    expect((await state()).chest.earnedKeys).toBe(1);
  });

  it('`approved` 必须是真布尔；不存在的 id = 404（别人的候选也是 404，不泄露"它存在"）', async () => {
    seedCandidate('c4', idB, '注意力残留');
    await req.post('/api/cards/pool/c4/decide', cookieA, { approved: 'yes' }).expect(400);
    await req.post('/api/cards/pool/c4/decide', cookieA, { approved: true }).expect(404);
    await req.post('/api/cards/pool/nope/decide', cookieA, { approved: true }).expect(404);
    expect(getDb().prepare('SELECT status FROM term_pool_candidate WHERE id = ?').get('c4')).toMatchObject({
      status: 'pending',
    });
  });
});

describe('跨用户与跨源', () => {
  it('★★ A 的开盒、单、事件帧，在 B 的 `/state` 与 `/live` 里必须是空（不是"不等于 A 的值"）', async () => {
    await req.post('/api/cards/chest/open', cookieA).expect(200);
    getDb()
      .prepare(
        `INSERT INTO study_task (id, owner_id, kind, dedupe_key, title, why, status)
         VALUES ('only-a', ?, 'unstall', 'unstall:zz', '别让 X 凉掉', '', 'open')`,
      )
      .run(idA);

    const b = await state(cookieB);
    expect(b.wall).toEqual([]);
    expect(b.tasks).toEqual([]);
    expect(b.chest.pending).toBeNull();
    expect(b.chest.freeUsed).toBe(0); // ★ B 的免费次数没被 A 用掉

    const live = await req.get('/api/cards/live', cookieB).expect(200);
    const events = live.body.events as Array<{ type: string }>;
    expect(events.filter((e) => e.type === 'chest_ready')).toEqual([]);
    expect(events.filter((e) => e.type === 'task_dispatched')).toEqual([]);
  });

  it('写接口吃同一道跨源闸门（非法 Origin 的 POST 到不了域层）', async () => {
    const r = await request(app).post('/api/cards/chest/open').set('Origin', 'http://evil.example').set('Cookie', cookieA);
    expect(r.status).toBe(403);
    expect((await state()).chest.freeUsed).toBe(0);
  });

  it('未登录走无主桶：看得见的是 `owner_id` 为空串的那些行，不是全站', async () => {
    await addTerm('双重编码', cookieB);
    const anon = await req.get('/api/cards/state').expect(200);
    expect((anon.body as CardsStateResponse).wall).toEqual([]);
  });
});
