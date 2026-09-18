/**
 * routes/terms-tenancy — **词条库 / 领域归主**的端到端（契约 `docs/TENANCY-SPEC.md` §8.2，M2d-2）。
 *
 * ★ 本片要消灭的洞，性质与 M2d-1 不同：那批是「**别人能改到你**」，这批是「**别人能撞到你**」。
 *   `term_domain` 的 `name` 是**单列主键**、`term_library` 是 `UNIQUE(term, domain)`——
 *   两个用户各自建一个 `物理` 领域、各自存一条「牛顿第二定律/物理」，在库里**就是同一行**：
 *     · 谁后建谁**建不出来**（`INSERT` 直接撞主键，报错或静默忽略）；
 *     · 后存的词条被**并入**先存的那条（`UNIQUE(term,domain)` 的 upsert 语义），
 *       于是 A 改自己的释义，**B 的词条跟着变**。
 *   ⇒ 这批的核心承诺不是"看不见"，而是"**A、B 同名不冲突、各存各的**"。
 *
 * ★ 三条容易写成"看着对但没测到"的口径，本文件各配一条锁：
 *   ① **"不串"要用"另一人拿到空/默认值"来断言**，不能只断言"另一人不是 A 的值"——
 *      后者在"两人读到同一行"时也可能偶然通过（值恰好相等）；
 *   ② **同名领域必须两人各一份**：只断言"B 也能建"不够（幂等语义下会 200 返回**A 的行**），
 *      要断言"库里 `物理` 有两行、owner 分别是谁"；
 *   ③ **`general` 是每用户懒建的**：读路径补建 ⇒ 新用户第一次 `GET /domains` 就该有它；
 *      而**删域迁 general 只迁自己那份**——迁到别人的 `general` 比不迁更糟（数据串台）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-terms-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}

const req = {
  get: (url: string, cookie = '') => {
    const r = request(app).get(url).set('Origin', origin);
    return cookie ? r.set('Cookie', cookie) : r;
  },
  post: (url: string, cookie: string, body: unknown) =>
    request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body as object),
  put: (url: string, cookie: string, body: unknown) =>
    request(app).put(url).set('Origin', origin).set('Cookie', cookie).send(body as object),
  delete: (url: string, cookie: string) =>
    request(app).delete(url).set('Origin', origin).set('Cookie', cookie),
};

// ★ 两个账号只在**模块加载时**建一次（同 settings-tenancy 的理由：`users` 表不在清理范围内，
//   每个用例重跑 `createUser` 同一邮箱会撞 `EMAIL_TAKEN`，把全部用例变成"没跑起来"）。
const cookieA = await signUp('ta@example.com');
const cookieB = await signUp('tb@example.com');
let idA = '';
let idB = '';
{
  const meA = await req.get('/api/auth/me', cookieA);
  const meB = await req.get('/api/auth/me', cookieB);
  idA = meA.body.user.id as string;
  idB = meB.body.user.id as string;
}

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  // ★ 每个用例从干净状态起：三张表全清（含 `general` —— 它由读路径懒建，清掉才测得到补建）。
  const db = getDb();
  for (const t of ['term_library', 'term_domain', 'term_mention_log']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterAll(() => closeDb());

describe('routes/terms-tenancy — term_domain / term_library 归主（v31）', () => {
  it('★★ 跨用户撞键：A、B 各建同名领域 `物理`，库里必须是**两行**、owner 各一（改前 name 单列 PK 直接撞）', async () => {
    const a = await req.post('/api/terms/domains', cookieA, { name: '物理' });
    const b = await req.post('/api/terms/domains', cookieB, { name: '物理' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201); // ★ 改前这里是 200（幂等返回 A 的那行）或直接 500
    const rows = getDb()
      .prepare(`SELECT owner_id FROM term_domain WHERE name = '物理' ORDER BY owner_id`)
      .all() as Array<{ owner_id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.owner_id).sort()).toEqual([idA, idB].sort());
  });

  it('★★ 跨用户撞键：A、B 各存同 `(term, domain)` 词条，必须各存各的（改前 UNIQUE(term,domain) 会把 B 并进 A）', async () => {
    await req.post('/api/terms', cookieA, { term: '牛顿第二定律', definition: 'A 的释义', domain: '物理' });
    await req.post('/api/terms', cookieB, { term: '牛顿第二定律', definition: 'B 的释义', domain: '物理' });
    const rows = getDb()
      .prepare(`SELECT owner_id, definition FROM term_library WHERE term = '牛顿第二定律' ORDER BY owner_id`)
      .all() as Array<{ owner_id: string; definition: string }>;
    expect(rows.length).toBe(2); // ★ 改前只有 1 行（B 的写入被 upsert 并进 A 那条）
    const mineA = rows.find((r) => r.owner_id === idA);
    const mineB = rows.find((r) => r.owner_id === idB);
    expect(mineA?.definition).toBe('A 的释义');
    expect(mineB?.definition).toBe('B 的释义');
  });

  it('★ 可见性：A 存了词条，B 的列表**是空的**（不是"不含 A 那条"，而是压根没有）', async () => {
    await req.post('/api/terms', cookieA, { term: '闭包', definition: 'A 的词条', domain: 'general' });
    const a = await req.get('/api/terms', cookieA);
    const b = await req.get('/api/terms', cookieB);
    expect(a.body.length).toBe(1);
    expect(b.body.length).toBe(0); // ★ 改前 B 会看到 A 的那条
  });

  it('★ 领域统计按人各算：B 的 `物理` 计数是 0，A 的是 1（改前两人共用一个 count）', async () => {
    await req.post('/api/terms', cookieA, { term: '动量守恒', definition: 'A', domain: '物理' });
    const a = await req.get('/api/terms/domains', cookieA);
    const b = await req.get('/api/terms/domains', cookieB);
    const pick = (body: { domains: Array<{ domain: string; count: number }> }, name: string) =>
      body.domains.find((d) => d.domain === name)?.count;
    expect(pick(a.body, '物理')).toBe(1);
    // ★ B 从未建过 `物理` ⇒ 它**不该出现在 B 的列表里**（不是 count=0，而是没有这一项）
    expect(pick(b.body, '物理')).toBeUndefined();
    expect(a.body.total).toBe(1);
    expect(b.body.total).toBe(0);
  });

  it('★ `general` 每用户懒建：新用户第一次读领域就**恒有一格 general**（读路径补建，老板拍板）', async () => {
    const b = await req.get('/api/terms/domains', cookieB);
    const general = b.body.domains.find((d: { domain: string }) => d.domain === 'general');
    expect(general).toBeDefined();
    // ★ 库里必须有一行**属于 B 自己**的 general（不是平台行、也不是 A 的）
    const row = getDb()
      .prepare(`SELECT owner_id FROM term_domain WHERE name = 'general'`)
      .all() as Array<{ owner_id: string }>;
    expect(row.map((r) => r.owner_id)).toEqual([idB]);
  });

  it('★ 删域迁 general **只迁自己那份**：A 删 `物理`，B 的同名域与词条纹丝不动', async () => {
    await req.post('/api/terms/domains', cookieA, { name: '物理' });
    await req.post('/api/terms/domains', cookieB, { name: '物理' });
    await req.post('/api/terms', cookieA, { term: 'A 的词', definition: 'a', domain: '物理' });
    await req.post('/api/terms', cookieB, { term: 'B 的词', definition: 'b', domain: '物理' });
    const del = await req.delete('/api/terms/domains/物理', cookieA);
    expect(del.status).toBe(200);
    const db = getDb();
    // A 的词条迁到了 **A 自己的** general
    const aTerm = db.prepare(`SELECT owner_id, domain FROM term_library WHERE term = 'A 的词'`).get() as {
      owner_id: string;
      domain: string;
    };
    expect(aTerm.owner_id).toBe(idA);
    expect(aTerm.domain).toBe('general');
    // B 的域还在、B 的词条还在原域
    expect(db.prepare(`SELECT 1 FROM term_domain WHERE name = '物理' AND owner_id = ?`).get(idB)).toBeDefined();
    const bTerm = db.prepare(`SELECT owner_id, domain FROM term_library WHERE term = 'B 的词'`).get() as {
      owner_id: string;
      domain: string;
    };
    expect(bTerm.owner_id).toBe(idB);
    expect(bTerm.domain).toBe('物理'); // ★ 改前会被 A 的删除连带迁走
  });

  it('★ 无主行（`owner_id = \'\'`）与登录用户**互相看不见**：本地历史不会漏给任何登录用户', async () => {
    // 直接写一行无主词条（模拟本地单人模式的历史数据）
    getDb()
      .prepare(
        `INSERT INTO term_library (owner_id, id, term, definition, domain) VALUES ('', 'orphan-1', '孤儿词条', '本地历史', 'general')`,
      )
      .run();
    const a = await req.get('/api/terms', cookieA);
    expect(a.body.length).toBe(0); // ★ 无主 ≠ 谁都能看见
    // 反向：拿无主行的 id 也**删不掉**它（写侧严格本人）。
    // ★ 断言的是"库里那行还在"，**不是** HTTP 状态码——`DELETE /:id` 是本批之前就有的
    //   **幂等**语义（恒回 `{ok:true}`，不区分"删掉了"与"本来就没有"）。状态码在这里
    //   证明不了任何事；真正的安全属性是"别人的行没被删"。
    await req.delete('/api/terms/orphan-1', cookieA);
    expect(getDb().prepare(`SELECT 1 FROM term_library WHERE id = 'orphan-1'`).get()).toBeDefined();
  });

  it('★ 拿别人词条的 id 也删不掉：A 删 B 的词条，B 的行必须还在', async () => {
    const created = await req.post('/api/terms', cookieB, { term: 'B 的私有词条', definition: 'b', domain: 'general' });
    const id = created.body.id as string;
    await req.delete(`/api/terms/${id}`, cookieA);
    expect(getDb().prepare(`SELECT 1 FROM term_library WHERE id = ?`).get(id)).toBeDefined();
    // 而 B 自己删得掉（确认上面那条不是因为"删除整个坏了"才通过的）
    await req.delete(`/api/terms/${id}`, cookieB);
    expect(getDb().prepare(`SELECT 1 FROM term_library WHERE id = ?`).get(id)).toBeUndefined();
  });
});
