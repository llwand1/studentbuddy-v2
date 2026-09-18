/**
 * routes/settings-tenancy — **设置与反馈环归主**的端到端（契约 `docs/TENANCY-SPEC.md` §8.2，M2d-1）。
 *
 * ★ 这份测试的性质与 `routes/tenancy.test.ts` / `routes/providers-tenancy.test.ts` 一样：
 *   测的不是"功能对不对"，而是"**会不会串**"。本片要消灭的是 §8.2 点名的那些洞：
 *     · `app_settings` 是**全局写口** ⇒ A 在设置页改一次出题配比/回答方式/配图开关/搜索 key，
 *       **全站所有人都跟着变**（与 `role_bindings` 同一类隐患）；
 *     · `user_stats` 里存 `xp` ⇒ **A 和 B 的 XP 是同一个数**，等级与连签同理；
 *     · `daily_summaries` 的 `PK(day)` ⇒ **B 直接读到 A 的今日总结**；
 *     · `daily_activity` 的 `PK(day,type)` ⇒ A、B 同一天聊天**直接撞主键**。
 *
 * ★ 三条容易写成"看着对但没测到"的口径，本文件各配一条锁：
 *   ① **"不串"要用"另一人拿到默认值"来断言**，不能只断言"另一人不是 A 的值"——
 *      后者在"两人读到同一行"时也可能偶然通过（值恰好相等）；
 *   ② **无主行（`owner_id = ''`）不是"谁都能看见"**：未登录请求也读不到登录用户的行，
 *      反过来登录用户也读不到无主行（那是本地单人模式的历史数据）；
 *   ③ **单值读（`.get()`）必须带 `owner_id = ?`**：库里同时有 `''` 与 `'u1'` 两行时，
 *      豁免过滤会返回**任意一行**（静默串台）——见 `auth/ownership.ts#ownerForWrite` 的推演。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, DEFAULT_QUIZ_MIX, DEFAULT_ANSWER_STYLE } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-settings-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { wireActivityEvents } = await import('../learning/activity.js');
const { publishEvent } = await import('../events/bus.js');
const request = (await import('supertest')).default;

// ★ 事件订阅只在"直接运行 index.ts"时自动接线（见 index.ts 末尾的 `process.argv[1]` 判断）
//   ⇒ 测试里必须自己接一次。`wireActivityEvents` 是模块单例、幂等，重复调用无害。
wireActivityEvents();

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}

/** 三个薄助手（不写成 `req(method, …)`：动态取方法会让 TS 丢掉 `Test` 类型，`.body` 就没法断言了） */
const req = {
  get: (url: string, cookie = '') => {
    const r = request(app).get(url).set('Origin', origin);
    return cookie ? r.set('Cookie', cookie) : r;
  },
  put: (url: string, cookie: string, body: unknown) =>
    request(app).put(url).set('Origin', origin).set('Cookie', cookie).send(body as object),
  delete: (url: string, cookie: string) =>
    request(app).delete(url).set('Origin', origin).set('Cookie', cookie),
};

// ★ 两个账号只在**模块加载时**建一次：`users` 表不在 `beforeEach` 的清理范围内（清了会连带
//   清掉会话），若每个用例都重新 `createUser` 同一个邮箱，第二次起就撞 `EMAIL_TAKEN`
//   ——那会把 9 个用例一起变成"没跑起来"，红得毫无信息量。
const cookieA = await signUp('a@example.com');
const cookieB = await signUp('b@example.com');

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  // ★ 每个用例从干净状态起：四张表全清。不清的话前一个用例写进 `''` 的行会漏进后一个，
  //   于是「B 拿到默认值」变成「B 拿到了上一个用例的值」——红的是**正确的代码**，极难读。
  const db = getDb();
  for (const t of ['app_settings', 'daily_activity', 'daily_summaries', 'user_stats']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterAll(() => closeDb());

describe('routes/settings-tenancy — app_settings 归主（v30）', () => {
  it('★ 出题配比：A 改了，B 读到的**仍是默认值**（改前是全局写口，A 一改全站都变）', async () => {
    const put = await req.put('/api/settings/quiz-mix', cookieA, { mix: { single: 7, multiple: 0, fill: 0, essay: 0, scenario: 0 } });
    expect(put.status).toBe(200);
    expect(put.body.mix.single).toBe(7);

    const a = await req.get('/api/settings/quiz-mix', cookieA);
    const b = await req.get('/api/settings/quiz-mix', cookieB);
    expect(a.body.mix.single).toBe(7);
    // ★ 断言"等于默认值"而不是"不等于 7"——后者在两人读到同一行时也可能偶然通过
    expect(b.body.mix).toEqual({ ...DEFAULT_QUIZ_MIX });
  });

  it('★ 回答方式偏好：A 配了 → B 的 `configured` 仍是 false（那个标志就是 L1 弹不弹选项卡的依据）', async () => {
    await req.put('/api/settings/answer-style', cookieA, { style: { verbosity: 'brief', tone: 'socratic' } });
    const a = await req.get('/api/settings/answer-style', cookieA);
    const b = await req.get('/api/settings/answer-style', cookieB);
    expect(a.body.configured).toBe(true);
    expect(a.body.style.verbosity).toBe('brief');
    expect(b.body.configured).toBe(false);
    expect(b.body.style).toEqual({ ...DEFAULT_ANSWER_STYLE });
  });

  it('★ 删偏好只删自己的：A 删完，B 那条不受影响（`DELETE` 漏带归属会删掉所有人的）', async () => {
    await req.put('/api/settings/answer-style', cookieA, { style: { verbosity: 'brief' } });
    await req.put('/api/settings/answer-style', cookieB, { style: { verbosity: 'detailed' } });
    const del = await req.delete('/api/settings/answer-style', cookieA);
    expect(del.status).toBe(200);
    const a = await req.get('/api/settings/answer-style', cookieA);
    const b = await req.get('/api/settings/answer-style', cookieB);
    expect(a.body.configured).toBe(false); // 自己的没了
    expect(b.body.configured).toBe(true); // ★ 别人的还在
    expect(b.body.style.verbosity).toBe('detailed');
  });

  it('★ 出题配图开关：A 开了 → B 仍是关（`app_settings` 四处 `ON CONFLICT` 之一）', async () => {
    const put = await req.put('/api/settings/quiz-image', cookieA, { on: true });
    expect(put.status).toBe(200);
    expect(put.body.on).toBe(true);
    expect((await req.get('/api/settings/quiz-image', cookieA)).body.on).toBe(true);
    expect((await req.get('/api/settings/quiz-image', cookieB)).body.on).toBe(false);
  });

  it('★ 搜索 key：A 配了 → A 的 configured 亮、B 的不亮（key 是要花钱的）', async () => {
    const put = await req.put('/api/settings/search-keys', cookieA, { exa: 'exa-secret' });
    expect(put.status).toBe(200);
    const a = await req.get('/api/settings/search-keys', cookieA);
    const b = await req.get('/api/settings/search-keys', cookieB);
    expect(a.body.configured.exa).toBe(true);
    expect(b.body.configured.exa).toBe(false);
    // 落库的是**密文**且带归属（直读库，避免用接口断言接口）
    const row = getDb()
      .prepare(`SELECT owner_id, value FROM app_settings WHERE key = 'search_key_exa'`)
      .get() as { owner_id: string; value: string };
    expect(row.owner_id).not.toBe(''); // 不是无主行
    expect(row.value.startsWith('enc:v1:')).toBe(true);
    expect(row.value).not.toContain('exa-secret');
  });
});

describe('routes/settings-tenancy — 反馈环三表归主（v30）', () => {
  /** 给某人记 n 轮对话（走真实事件总线，与生产同一条路） */
  const chatDone = (ownerId: string, n = 1): void => {
    for (let i = 0; i < n; i++) publishEvent({ type: 'chat_done', sessionId: `s-${i}`, ownerId });
  };

  it('★ 两人各记自己的活动：A 的 xp / 计数只算 A 的，B 的一分不沾', async () => {
    // 通过接口拿不到自己的 user id，但 `GET /api/auth/me` 可以
    const meA = await req.get('/api/auth/me', cookieA);
    const meB = await req.get('/api/auth/me', cookieB);
    const idA = meA.body.user.id as string;
    const idB = meB.body.user.id as string;
    chatDone(idA, 2);
    chatDone(idB, 5);

    const a = await req.get('/api/activity/today', cookieA);
    const b = await req.get('/api/activity/today', cookieB);
    expect(a.body.xp).toBe(2 * 2); // chat_done = 2 XP
    expect(b.body.xp).toBe(5 * 2);
    expect(a.body.activities).toEqual([{ type: 'chat_done', count: 2 }]);
    expect(b.body.activities).toEqual([{ type: 'chat_done', count: 5 }]);
    // 同一天同 type 两人各一条（改前 PK(day,type) 第二个人直接插不进去）
    const rows = getDb()
      .prepare(`SELECT owner_id, count FROM daily_activity WHERE day = date('now') ORDER BY count`)
      .all() as Array<{ owner_id: string; count: number }>;
    expect(rows).toEqual([
      { owner_id: idA, count: 2 },
      { owner_id: idB, count: 5 },
    ]);
  });

  it('★ 今日总结按人各一份：A 的总结只含 A 的活动，B 的一分不沾（改前 `PK(day)` 就是这个洞）', async () => {
    const meA = await req.get('/api/auth/me', cookieA);
    chatDone(meA.body.user.id as string, 1);
    // 没配 summarizer 模型 ⇒ 走降级统计文本（ADR-4），正好是"可断言且含本人数据"的一段
    const a = await req.get('/api/activity/summary', cookieA);
    const b = await req.get('/api/activity/summary', cookieB);
    expect(a.body.content).toContain('chat_done×1');
    expect(b.body.content).not.toContain('chat_done×1'); // B 今天没活动
    expect(b.body.content).toContain('暂无活动');
  });

  it('★ 今日总结的**缓存**按人各一份：库里同时有「无主」与 A 的两条缓存时，两人各读各的', async () => {
    const meA = await req.get('/api/auth/me', cookieA);
    const idA = meA.body.user.id as string;
    // 直接铺缓存（走 LLM 那条路要真配一个模型，本用例要测的是**读缓存时的归属**，不是生成）
    const ins = getDb().prepare(`INSERT INTO daily_summaries (owner_id, day, content) VALUES (?, date('now'), ?)`);
    ins.run('', '无主行的旧总结');
    ins.run(idA, 'A 的缓存总结');

    expect((await req.get('/api/activity/summary', cookieA)).body.content).toBe('A 的缓存总结');
    // ★ B 没有缓存 ⇒ 走降级文本；关键是**不能读到「无主行的旧总结」**（豁免过滤就会读到它）
    const b = await req.get('/api/activity/summary', cookieB);
    expect(b.body.content).not.toBe('无主行的旧总结');
    expect(b.body.content).toContain('暂无活动');
    // 无主行仍在库里（没被误删、也没被误读）——未登录模式才看得见它
    const anon = await req.get('/api/activity/summary');
    expect(anon.body.content).toBe('无主行的旧总结');
  });

  it('★ 未登录读不到任何人的数据（无主 ≠ 谁都能看见），也读不到登录用户的行', async () => {
    const meA = await req.get('/api/auth/me', cookieA);
    chatDone(meA.body.user.id as string, 4);
    const anon = await req.get('/api/activity/today'); // 无 cookie
    expect(anon.body.xp).toBe(0);
    expect(anon.body.activities).toEqual([]);
  });

  it('★ 无主行（`owner_id` 为空串）与登录用户**互相看不见**：本地历史不会漏给任何登录用户', async () => {
    // 模拟"本地单人模式写下的历史"：直接落一行无主数据
    getDb().prepare(`INSERT INTO user_stats (owner_id, key, value) VALUES ('', 'xp', '999')`).run();
    const a = await req.get('/api/activity/today', cookieA);
    expect(a.body.xp).toBe(0); // ★ 不是 999
    // 而未登录（本地模式）看得到它——这正是"鉴权关闭时旧行为不变"
    const anon = await req.get('/api/activity/today');
    expect(anon.body.xp).toBe(999);
  });
});
