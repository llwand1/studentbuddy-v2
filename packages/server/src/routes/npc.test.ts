/**
 * routes/npc — 学习伙伴的端到端（契约 `docs/NPC-PARTNER-SPEC.md` §7.1／§8）。
 *
 * ★ 手法照 `cards.test.ts`：真 app + supertest + 两个真账号，**不 mock 归属**。
 *
 * 本文件最该锁的四件事，都不是"返回 200"：
 *  ① **伙伴的形状一次给全**：`quota`／`spots`／`tradesLeft` 与 `npcs[]` 的
 *     `row/col/bio/distressed/threat` 必须同一次响应里齐备——前端少一样就得自己算，
 *     而自己算就是第二份口径（「图上画着伙伴遇险、清单里没有那单」的开端）；
 *  ② **创建是"玩家点格"**：`row/col` 非整数 ⇒ 400；落不到合法格上 ⇒ 409 **且带一句具体的话**
 *     （禁静默：静默的失败会被读成"这个功能坏了"）；
 *  ③ **talk 没有失败态**（除入参错与伙伴不存在）：无 key 时是 **200 + `source:'fallback'`**，
 *     不是 5xx、更不是空串。降级可以，假装没降级不行（ADR-5 的等价物）；
 *  ④ **跨用户零串台**：A 的花名册，在 B 的 `GET /api/npc` 里必须是**空**。
 *     ★ 用"另一个人拿到空"来断言，不用"不是 A 的值"（后者在两人恰好相等时会假绿）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, cellKey, newWorld, npcNameFromPool, spiralCells } from '@sb/shared';
import type { NpcState } from '../learning/npc.js';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-npc-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;
const { saveWorld } = await import('../learning/continent-world.js');

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<{ cookie: string; id: string }> {
  const user = await createUser(email, 'good-password-1', undefined);
  return { cookie: `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`, id: user.id };
}

const req = {
  get: (url: string, cookie: string) => request(app).get(url).set('Origin', origin).set('Cookie', cookie),
  put: (url: string, cookie: string, body?: unknown) =>
    request(app).put(url).set('Origin', origin).set('Cookie', cookie).send((body ?? {}) as object),
  del: (url: string, cookie: string) =>
    request(app).delete(url).set('Origin', origin).set('Cookie', cookie),
  post: (url: string, cookie: string, body?: unknown) =>
    request(app).post(url).set('Origin', origin).set('Cookie', cookie).send((body ?? {}) as object),
};

const A = await signUp('np-a@example.com');
const B = await signUp('np-b@example.com');

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  const db = getDb();
  for (const t of ['term_library', 'term_mention_log', 'term_review_log', 'chest_keys', 'chest_open', 'study_task']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`DELETE FROM app_settings WHERE key IN ('npc_party', 'continent_world')`).run();
  // ★ 开拓制：先把螺旋铺格序整片视为已开拓（本文件锁伙伴，不锁开拓）
  for (const u of [A.id, B.id]) {
    const w = newWorld(1);
    spiralCells(9).forEach((c, i) => (w.cells[cellKey(c.row, c.col)] = { t: null, lv: 0, n: i }));
    saveWorld(u, w);
  }
});

afterAll(() => closeDb());

/** 直接固化一份**空花名册**：跳过"自愈迁移那一位"，专门测"第一位由玩家创建"（无条件） */
function sealEmptyParty(userId: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO app_settings (owner_id, key, value) VALUES (?, 'npc_party', ?)`)
    .run(userId, '{"members":[]}');
}

async function addTerm(term: string, cookie = A.cookie, domain = '记忆机制'): Promise<string> {
  const r = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({ term, definition: `${term} 的释义`, domain });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

async function npcState(cookie = A.cookie): Promise<NpcState> {
  const r = await req.get('/api/npc', cookie).expect(200);
  return r.body as NpcState;
}

describe('GET /api/npc', () => {
  it('① 一次读全：伙伴形状 + 名额门票 + 可落位格 + 交换余额（前端一样都不用自己算）', async () => {
    await addTerm('主动回忆');
    await addTerm('间隔重复'); // ★ 要有第二条，才有"空着的格"可站（迁移那一位已占了第一条的格）
    const s = await npcState();
    // ★ 自愈迁移：旧库那一位（旧口径第 0 位）就地固化 ⇒ 读到的就是"他"
    expect(s.npcs).toHaveLength(1);
    expect(s.quota).toMatchObject({ count: 1, max: 6, doneTasks: 0, needTasks: 3, canCreate: false });
    expect(s.quota.blockedBy).toContain('还差 3 单');
    expect(s.tradesLeft).toBe(2);
    expect(s.spots.length).toBeGreaterThan(0); // 可落位格由服务端给（前端不重算铺格）
    // ★ 迁移取的是**哈希序第 0 位**，两位候选时是哪一条不由测试决定 ⇒ 只断言"是这两条之一"
    expect(['主动回忆', '间隔重复']).toContain(s.npcs[0]?.term);
    expect(s.npcs[0]).toMatchObject({ domain: '记忆机制', distressed: false, threat: null });
    expect(s.npcs[0]?.id).toMatch(/^npc:/);
    expect(s.npcs[0]?.bio).toBeTruthy(); // 人设文案在位（迁移用本地模板）
    expect(typeof s.npcs[0]?.row).toBe('number');
    expect(typeof s.npcs[0]?.col).toBe('number');
  });

  it('①b 空库：一位都没有、名字为空，且**空册已固化**（加词条后也不会凭空冒人）', async () => {
    const s = await npcState();
    expect(s).toMatchObject({ partnerName: '', npcs: [] });
    expect(s.quota).toMatchObject({ count: 0, needTasks: 0, canCreate: false });
    expect(s.quota.blockedBy).toContain('还没有词条');
    await addTerm('后来加的');
    expect((await npcState()).npcs).toEqual([]);
  });
});

describe('POST /api/npc（创建：玩家点的那一格）', () => {
  it('② 首位无条件：落位成功 ⇒ 回**整份新状态** + 新伙伴 id + 起名来源', async () => {
    await addTerm('主动回忆');
    sealEmptyParty(A.id); // 空册 ⇒ 第一位由玩家创建（不消耗"开局那一位"）
    const before = await npcState();
    expect(before.quota.canCreate).toBe(true);
    const spot = before.spots[0];
    if (!spot) throw new Error('应该有空位可站');

    const r = await req.post('/api/npc', A.cookie, { row: spot.row, col: spot.col }).expect(200);
    const body = r.body as { state: NpcState; memberId: string; source: string };
    expect(body.memberId).toMatch(/^npc:/);
    expect(body.source).toBe('fallback'); // 隔离库没绑模型 ⇒ 本地起名（降级要说真话）
    expect(body.state.npcs).toHaveLength(1);
    expect(body.state.npcs[0]?.name).toBe(npcNameFromPool(body.state.npcs[0]?.termId ?? ''));
    expect(body.state.npcs[0]?.row).toBe(spot.row);
    expect(body.state.quota.count).toBe(1);
  });

  it('②b 落不到合法格 ⇒ 409 且带一句具体的话；row/col 非整数 ⇒ 400', async () => {
    await addTerm('主动回忆');
    sealEmptyParty(A.id); // ★ 空册 ⇒ 门票为 0，这一段测的是**逐格判定**
    const far = await req.post('/api/npc', A.cookie, { row: -20, col: -20 }).expect(409);
    expect((far.body as { error: string }).error).toContain('不能安置');
    await req.post('/api/npc', A.cookie, { row: 1.5, col: 2 }).expect(400);
    await req.post('/api/npc', A.cookie, {}).expect(400);
  });

  it('②c 门票：第 2 位要 3 单已完成任务（不够 → 409 且说清还差几单）', async () => {
    await addTerm('主动回忆');
    // ★ 不固化空册 ⇒ 自愈迁移给出"开局那一位" ⇒ 这一次点击要的是**第 2 位**，门票 3 单
    const s = await npcState();
    expect(s.quota).toMatchObject({ count: 1, needTasks: 3 });
    // 门票判定排在逐格之前，故这里的坐标其实无关（用迁移之后仍空着的那一格更贴近真实点击）
    const spot = s.spots[0] ?? { row: 0, col: 0 };
    const deny = await req.post('/api/npc', A.cookie, { row: spot.row, col: spot.col }).expect(409);
    expect((deny.body as { error: string }).error).toContain('还差 3 单');
  });
});

describe('PUT /:id（改名）与 DELETE /:id（让他回家）', () => {
  it('③ 改名成功、空串 400、未知伙伴 404；改名后 `partnerName` 跟着变', async () => {
    await addTerm('主动回忆');
    const id = encodeURIComponent((await npcState()).npcs[0]?.id ?? '');

    const named = await req.put(`/api/npc/${id}`, A.cookie, { name: '  小满  ' }).expect(200);
    expect((named.body as { state: NpcState }).state.partnerName).toBe('小满');
    expect((await npcState()).partnerName).toBe('小满');

    await req.put(`/api/npc/${id}`, A.cookie, { name: '' }).expect(400);
    await req.put(`/api/npc/${id}`, A.cookie, { name: 123 }).expect(400);
    await req.put('/api/npc/npc:nobody', A.cookie, { name: '甲' }).expect(404);
  });

  it('④ 解散：真删（新状态里他不在了）＋ 位置与名额都空出来；不存在的给 404', async () => {
    await addTerm('主动回忆');
    const before = await npcState();
    const id = encodeURIComponent(before.npcs[0]?.id ?? '');
    const spotsBefore = before.spots.length;

    const gone = await req.del(`/api/npc/${id}`, A.cookie).expect(200);
    const state = (gone.body as { state: NpcState }).state;
    expect(state.npcs).toEqual([]);
    expect(state.partnerName).toBe('');
    expect(state.spots.length).toBeGreaterThan(spotsBefore);

    await req.del(`/api/npc/${id}`, A.cookie).expect(404);
  });
});

describe('POST /:id/talk', () => {
  it('⑤ 没有可用模型 ⇒ 200 + source=fallback（不 5xx、不空串），且话里带他守的词条', async () => {
    await addTerm('主动回忆');
    const npc = (await npcState()).npcs[0];
    const r = await req
      .post(`/api/npc/${encodeURIComponent(npc?.id ?? '')}/talk`, A.cookie, { text: '你在干嘛' })
      .expect(200);
    expect(r.body.source).toBe('fallback');
    expect(r.body.reply as string).toContain('主动回忆');
  });

  it('⑥ 空文本 ⇒ 400；伙伴不存在 ⇒ 404（两种都不是 200）', async () => {
    await addTerm('主动回忆');
    const npc = (await npcState()).npcs[0];
    const url = `/api/npc/${encodeURIComponent(npc?.id ?? '')}/talk`;
    await req.post(url, A.cookie, { text: '   ' }).expect(400);
    await req.post(url, A.cookie, { text: 5 }).expect(400);
    await req.post('/api/npc/npc:nobody/talk', A.cookie, { text: '喂' }).expect(404);
  });
});

describe('POST /:id/trade', () => {
  it('⑦ 未知伙伴 404、信物不在库 409、缺参 400（三种各一句，不许压成一句）', async () => {
    const termId = await addTerm('我的信物');
    const id = encodeURIComponent((await npcState()).npcs[0]?.id ?? '');
    await req.post(`/api/npc/${id}/trade`, A.cookie, { termId: 'no-such' }).expect(409);
    await req.post('/api/npc/npc:nobody/trade', A.cookie, { termId }).expect(404);
    await req.post(`/api/npc/${id}/trade`, A.cookie, {}).expect(400);
  });

  it('⑦b 信物 ★0 拿不出手 ⇒ 409（卡是读数不是道具，门槛只能落在"我熟不熟"上）', async () => {
    const termId = await addTerm('刚记下的词');
    const id = encodeURIComponent((await npcState()).npcs[0]?.id ?? '');
    const r = await req.post(`/api/npc/${id}/trade`, A.cookie, { termId }).expect(409);
    expect((r.body as { error: string }).error).toContain('★1');
  });
});

describe('归属隔离', () => {
  it('⑧ A 的花名册与名字在 B 那里是空的（用"另一个人拿到空"断言，不用"不是 A 的值"）', async () => {
    await addTerm('主动回忆');
    await req
      .put(`/api/npc/${encodeURIComponent((await npcState()).npcs[0]?.id ?? '')}`, A.cookie, { name: '小满' })
      .expect(200);

    const a = await npcState(A.cookie);
    expect(a.partnerName).toBe('小满');
    expect(a.npcs).toHaveLength(1);

    const b = await npcState(B.cookie);
    expect(b.partnerName).toBe('');
    expect(b.npcs).toEqual([]);
    expect(b.spots).toEqual([]); // B 库里没词条 ⇒ 也没有可落位的地

    // B 也不能改到 A 的名字
    await req.put('/api/npc/npc:x', B.cookie, { name: '别人的伙伴' }).expect(404);
    expect((await npcState(A.cookie)).partnerName).toBe('小满');
  });
});