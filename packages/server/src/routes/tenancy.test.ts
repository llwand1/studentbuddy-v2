/**
 * routes/tenancy — 多租户隔离端到端（契约 docs/TENANCY-SPEC.md §8 验收判据）。
 *
 * ★ 这份测试的性质与别处不同：它测的不是"功能对不对"，而是"**会不会泄露**"。
 *   上线前的最后一道闸门就是这里——任何一条红掉，都意味着访客能看见别人的数据。
 *
 * 钉死的承诺：
 *  · 自己的会话只有自己列得出来；别人的会话 id **直接访问一律 404**（不回 403，
 *    否则等于泄露"这个 id 存在"）；
 *  · 子表（messages）随父会话继承归属，不需要也不存在 `messages.user_id`；
 *  · 孤儿行（`user_id IS NULL` 的老数据）对**任何**登录用户都不可见；
 *  · 未登录请求维持本地单人旧行为（不加过滤），不回归老板平时的本地用法。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-tenancy-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { upsertMemoryItems } = await import('../chat/memory.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

/**
 * 建一个账号并取出会话 cookie（`register` 直接下发登录态，见 AUTH-SPEC §2）。
 *
 * ★ M1.6（契约 §2.7「注册即验证」）起 `POST /api/auth/register` **必带 `code`**，
 *   而本文件的主体是**数据归属隔离**、不是注册流程 ⇒ 夹具直接落在**账号 + 会话**这两层，
 *   不再借道注册端点。两条理由：
 *     ① 省掉一次发信打桩（注册码只能从邮件里拿）；
 *     ② **不吃注册用途的限流名额**——注册的 IP 上限只有 5/小时，而测试全走同一个出口 IP，
 *        借道注册会让「注册阈值一改，本文件跟着红」。
 *   注册端点本身的端到端覆盖在 `routes/auth.test.ts`。
 */
async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}

/** 建一个属于自己的会话，返回 id。 */
async function createSession(cookie: string): Promise<string> {
  const res = await request(app).post('/api/sessions').set('Origin', origin).set('Cookie', cookie).send({});
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const listSessions = (cookie: string) =>
  request(app).get('/api/sessions').set('Origin', origin).set('Cookie', cookie);

let cookieA = '';
let cookieB = '';
let sessA = '';

beforeEach(async () => {
  resetRateLimits();
  resetAuthCaches();
});

// 两个账号只需建一次（注册有按邮箱 UNIQUE 限制，重复注册会 409）
cookieA = await signUp('alice@example.com');
cookieB = await signUp('bob@example.com');
sessA = await createSession(cookieA);

// 画像归属要用真实的 users.id 落库，故先取一次（A 的 cookie 全程复用）
const meA = await request(app).get('/api/auth/me').set('Origin', origin).set('Cookie', cookieA);
// ★ `/me` 的响应是 `{ user: {...} }`（AUTH-SPEC §2），取错层会拿到 undefined ⇒ 画像落成无主行
const uidA = meA.body.user.id as string;

describe('会话归属：自己的只有自己列得出来', () => {
  it('A 能看到自己建的会话，B 看不到', async () => {
    const a = await listSessions(cookieA);
    expect(a.status).toBe(200);
    expect(a.body.map((s: { id: string }) => s.id)).toContain(sessA);

    const b = await listSessions(cookieB);
    expect(b.status).toBe(200);
    expect(b.body.map((s: { id: string }) => s.id)).not.toContain(sessA);
  });

  it('建会话时归属已落库（不是靠查询时才过滤）', () => {
    const row = getDb().prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessA) as { user_id: string | null };
    expect(row.user_id).not.toBeNull();
    expect(row.user_id).toMatch(/^u-/); // users.id 前缀（AUTH-SPEC v21）
  });
});

describe('跨用户访问：一律 404（不回 403，避免泄露 id 存在）', () => {
  it('B 直接读 A 的会话消息 → 404', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessA}/messages`)
      .set('Origin', origin)
      .set('Cookie', cookieB);
    expect(res.status).toBe(404);
  });

  it('B 改 A 的置顶 → 404，且 A 的置顶没被改动', async () => {
    const res = await request(app)
      .patch(`/api/sessions/${sessA}/pinned`)
      .set('Origin', origin)
      .set('Cookie', cookieB)
      .send({ pinned: true });
    expect(res.status).toBe(404);

    const row = getDb().prepare('SELECT pinned FROM sessions WHERE id = ?').get(sessA) as { pinned: number };
    expect(row.pinned).toBe(0);
  });

  it('B 删 A 的会话 → 404，且会话仍在（删除是最该拦住的写操作）', async () => {
    const res = await request(app).delete(`/api/sessions/${sessA}`).set('Origin', origin).set('Cookie', cookieB);
    expect(res.status).toBe(404);

    const row = getDb().prepare('SELECT deleted_at FROM sessions WHERE id = ?').get(sessA) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it('B 订阅 A 的 SSE 流 → 404', async () => {
    const res = await request(app)
      .get(`/api/chat/stream?sessionId=${sessA}`)
      .set('Origin', origin)
      .set('Cookie', cookieB);
    expect(res.status).toBe(404);
  });

  it('B 往 A 的会话发消息 → 404（不能往别人的会话里写）', async () => {
    const res = await request(app)
      .post('/api/chat/send')
      .set('Origin', origin)
      .set('Cookie', cookieB)
      .send({ sessionId: sessA, text: '蹭一下别人的会话' });
    expect(res.status).toBe(404);
  });
});

describe('孤儿行（老数据）：对任何登录用户都不可见', () => {
  it('user_id 为 NULL 的会话不出现在列表里，直接访问也 404', async () => {
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES ('s-orphan', '升级前的老会话')`).run();

    const a = await listSessions(cookieA);
    expect(a.body.map((s: { id: string }) => s.id)).not.toContain('s-orphan');

    const direct = await request(app)
      .get('/api/sessions/s-orphan/messages')
      .set('Origin', origin)
      .set('Cookie', cookieA);
    expect(direct.status).toBe(404); // ★ 老数据不会被判给任何一个登录用户
  });
});

/**
 * 长期画像（`user_memory`）归属（契约 §7；迁移 v24）。
 *
 * ★ 为什么画像必须单列一组：它是**全站唯一一处「自动写入」的跨会话个人数据**
 *   （模型自己决定记什么，用户从不手动填）。会话至少是用户自己建的、id 自己握着；
 *   画像是系统在后台攒的，串台了用户根本无从察觉——只会觉得「AI 怎么知道我的事」。
 */
describe('长期画像归属：跨会话数据也不串台', () => {
  it('A 的画像只有 A 列得出来', async () => {
    upsertMemoryItems([{ kind: 'profile', content: 'A 的私密画像', importance: 0.9 }], null, uidA);

    const a = await request(app).get('/api/memory').set('Origin', origin).set('Cookie', cookieA);
    expect(a.status).toBe(200);
    const mine = a.body as Array<{ id: string; content: string }>;
    expect(mine.map((m) => m.content)).toContain('A 的私密画像');

    const b = await request(app).get('/api/memory').set('Origin', origin).set('Cookie', cookieB);
    expect(b.status).toBe(200);
    expect((b.body as Array<{ content: string }>).map((m) => m.content)).not.toContain('A 的私密画像');
  });

  it('B 删 A 的画像 → 404 且没真删（删不掉别人的东西）', async () => {
    const a = await request(app).get('/api/memory').set('Origin', origin).set('Cookie', cookieA);
    const target = (a.body as Array<{ id: string; content: string }>).find((m) => m.content === 'A 的私密画像');
    expect(target).toBeDefined();

    const del = await request(app)
      .delete(`/api/memory/${target?.id ?? ''}`)
      .set('Origin', origin)
      .set('Cookie', cookieB);
    expect(del.status).toBe(404);

    const still = getDb().prepare('SELECT COUNT(*) AS c FROM user_memory WHERE id = ?').get(target?.id ?? '') as { c: number };
    expect(still.c).toBe(1);
  });

  it('拿别人的 sessionId 读/清会话摘要 → 404（M2a 漏掉的旁路，本批补）', async () => {
    const read = await request(app)
      .get(`/api/memory/summary/${sessA}`)
      .set('Origin', origin)
      .set('Cookie', cookieB);
    expect(read.status).toBe(404);

    const clear = await request(app)
      .delete(`/api/memory/summary/${sessA}`)
      .set('Origin', origin)
      .set('Cookie', cookieB);
    expect(clear.status).toBe(404);
  });
});

describe('未登录请求：维持本地单人旧行为（不回归）', () => {
  it('不带 cookie 时仍列全量会话（鉴权强制开关默认关，过滤只在有身份时生效）', async () => {
    const res = await request(app).get('/api/sessions').set('Origin', origin);
    expect(res.status).toBe(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(sessA);
    expect(ids).toContain('s-orphan'); // 孤儿行对"无人认领"的本地模式仍可见
  });
});

afterAll(() => {
  closeDb();
});
