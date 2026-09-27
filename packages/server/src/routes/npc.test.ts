/**
 * routes/npc — 学习伙伴的端到端（契约 `docs/NPC-PARTNER-SPEC.md` §7.1／§8）。
 *
 * ★ 手法照 `cards.test.ts`：真 app + supertest + 两个真账号，**不 mock 归属**。
 *
 * 本文件最该锁的三件事，都不是"返回 200"：
 *  ① **伙伴的形状一次给全**：`count/max/termsToNext/tradesLeft` 与 `npcs[]` 的
 *     `row/col/distressed/threat` 必须同一次响应里齐备——前端少一样就得自己算，
 *     而自己算就是第二份口径（「图上画着伙伴遇险、清单里没有那单」的开端）；
 *  ② **talk 没有失败态**（除入参错与伙伴不存在）：无 key 时是 **200 + `source:'fallback'`**，
 *     不是 5xx、更不是空串。降级可以，假装没降级不行（ADR-5 的等价物）；
 *  ③ **跨用户零串台**：A 起的名字、A 的地图，在 B 的 `GET /api/npc` 里必须是**空/默认值**。
 *     ★ 用"另一个人拿到空"来断言，不用"不是 A 的值"（后者在两人恰好相等时会假绿）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, npcNameFor } from '@sb/shared';
import type { NpcState } from '../learning/npc.js';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-npc-'));
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
  get: (url: string, cookie: string) => request(app).get(url).set('Origin', origin).set('Cookie', cookie),
  put: (url: string, cookie: string, body?: unknown) =>
    request(app).put(url).set('Origin', origin).set('Cookie', cookie).send((body ?? {}) as object),
  post: (url: string, cookie: string, body?: unknown) =>
    request(app).post(url).set('Origin', origin).set('Cookie', cookie).send((body ?? {}) as object),
};

const cookieA = await signUp('np-a@example.com');
const cookieB = await signUp('np-b@example.com');

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  const db = getDb();
  for (const t of ['term_library', 'term_mention_log', 'term_review_log', 'chest_keys', 'chest_open', 'study_task']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`DELETE FROM app_settings WHERE key = 'npc_partner'`).run();
});

afterAll(() => closeDb());

async function addTerm(term: string, cookie = cookieA, domain = '记忆机制'): Promise<string> {
  const r = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({ term, definition: `${term} 的释义`, domain });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

async function npcState(cookie = cookieA): Promise<NpcState> {
  const r = await req.get('/api/npc', cookie).expect(200);
  return r.body as NpcState;
}

describe('GET /api/npc', () => {
  it('① 一次读全：伙伴形状 + 数量上界 + 激励差值 + 交换余额（前端一样都不用自己算）', async () => {
    await addTerm('主动回忆');
    const s = await npcState();
    expect(s.max).toBe(6);
    expect(s.count).toBe(1);
    expect(s.termsToNext).toBe(15); // 下限那一位是白送的 ⇒ 下一位要凑满 16 条，已有 1 条 ⇒ 还差 15
    expect(s.tradesLeft).toBe(2);
    expect(s.npcs).toHaveLength(1);
    expect(s.npcs[0]).toMatchObject({
      term: '主动回忆',
      domain: '记忆机制',
      distressed: false,
      threat: null,
    });
    expect(s.npcs[0]?.id).toMatch(/^npc:/);
    expect(s.npcs[0]?.name).toBe(npcNameFor(s.npcs[0]?.termId ?? ''));
    expect(typeof s.npcs[0]?.row).toBe('number');
    expect(typeof s.npcs[0]?.col).toBe('number');
  });

  it('①b 空库：数量仍是 1 但一位也落不下 ⇒ 空数组 + 空名字（§7.4 的空库文案靠它）', async () => {
    const s = await npcState();
    expect(s).toMatchObject({ count: 1, npcs: [], partnerName: '' });
  });
});

describe('PUT /partner（宣传点「创建你的 AI 学习伙伴」的落点）', () => {
  it('② 改名生效；空串＝删键回默认名（回默认时顺手把默认名回给前端）', async () => {
    await addTerm('主动回忆');
    const before = await npcState();
    const defaultName = before.npcs[0]?.name ?? '';
    expect(defaultName).not.toBe('');

    const named = await req.put('/api/npc/partner', cookieA, { name: '  小满  ' }).expect(200);
    expect(named.body.partnerName).toBe('小满');
    expect((await npcState()).partnerName).toBe('小满');

    const reset = await req.put('/api/npc/partner', cookieA, { name: '' }).expect(200);
    expect(reset.body.partnerName).toBe(defaultName);
    expect((await npcState()).partnerName).toBe(defaultName);
    expect(getDb().prepare(`SELECT 1 AS x FROM app_settings WHERE key = 'npc_partner'`).get()).toBeUndefined();
  });

  it('②b 名字必须是字符串（数字/对象 ⇒ 400，不许静默当空串）；超长按码点截到 12 字', async () => {
    await req.put('/api/npc/partner', cookieA, { name: 123 }).expect(400);
    const long = await req.put('/api/npc/partner', cookieA, { name: '一二三四五六七八九十十一十二十三' }).expect(200);
    expect(long.body.partnerName).toBe('一二三四五六七八九十十一');
  });
});

describe('POST /:id/talk', () => {
  it('③ 没有可用模型 ⇒ 200 + source=fallback（不 5xx、不空串），且话里带他守的词条', async () => {
    await addTerm('主动回忆');
    const npc = (await npcState()).npcs[0];
    const r = await req.post(`/api/npc/${encodeURIComponent(npc?.id ?? '')}/talk`, cookieA, {
      text: '你在干嘛',
    }).expect(200);
    expect(r.body.source).toBe('fallback');
    expect(typeof r.body.reply).toBe('string');
    expect((r.body.reply as string).length).toBeGreaterThan(0);
    expect(r.body.reply as string).toContain('主动回忆');
  });

  it('④ 空文本 ⇒ 400；伙伴不存在 ⇒ 404（两种都不是 200）', async () => {
    await addTerm('主动回忆');
    const npc = (await npcState()).npcs[0];
    await req.post(`/api/npc/${encodeURIComponent(npc?.id ?? '')}/talk`, cookieA, { text: '   ' }).expect(400);
    await req.post(`/api/npc/${encodeURIComponent(npc?.id ?? '')}/talk`, cookieA, { text: 5 }).expect(400);
    await req.post('/api/npc/npc:nobody/talk', cookieA, { text: '喂' }).expect(404);
  });
});

describe('POST /:id/trade', () => {
  it('⑤ 未知伙伴 404、信物不在库 409、text/termId 缺参 400（三种各一句，不许压成一句）', async () => {
    const termId = await addTerm('我的信物');
    const npc = (await npcState()).npcs[0];
    const id = encodeURIComponent(npc?.id ?? '');

    await req.post(`/api/npc/${id}/trade`, cookieA, { termId: 'no-such' }).expect(409);
    await req.post('/api/npc/npc:nobody/trade', cookieA, { termId }).expect(404);
    await req.post(`/api/npc/${id}/trade`, cookieA, {}).expect(400);
  });

  it('⑤b 信物 ★0 拿不出手 ⇒ 409（卡是读数不是道具，门槛只能落在"我熟不熟"上）', async () => {
    const termId = await addTerm('刚记下的词');
    const npc = (await npcState()).npcs[0];
    const r = await req.post(`/api/npc/${encodeURIComponent(npc?.id ?? '')}/trade`, cookieA, { termId }).expect(409);
    expect(r.body.error).toContain('★1');
  });
});

describe('归属隔离', () => {
  it('⑥ A 的地图与名字在 B 那里是空的（用"另一个人拿到空"断言，不用"不是 A 的值"）', async () => {
    await addTerm('主动回忆');
    await req.put('/api/npc/partner', cookieA, { name: '小满' }).expect(200);

    const a = await npcState(cookieA);
    expect(a.partnerName).toBe('小满');
    expect(a.npcs.length).toBeGreaterThan(0);

    const b = await npcState(cookieB);
    expect(b.partnerName).toBe('');
    expect(b.npcs).toEqual([]);
    expect(b.count).toBe(1); // 数量派生走的是**自己**的词条数（0 条 ⇒ 下限 1）

    // B 也不能改到 A 的名字
    await req.put('/api/npc/partner', cookieB, { name: '别人的伙伴' }).expect(200);
    expect((await npcState(cookieA)).partnerName).toBe('小满');
  });
});