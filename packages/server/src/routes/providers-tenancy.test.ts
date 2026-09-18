/**
 * routes/providers-tenancy — **LLM 成本与配置归主**的端到端（契约 `docs/TENANCY-SPEC.md` §8.1，M2c）。
 *
 * ★ 这份测试的性质与 `routes/tenancy.test.ts` 一样：测的不是"功能对不对"，而是"**会不会串**"。
 *   本片要消灭的是 §8.1 原文点名的那类洞：
 *     · 用户 A 配了 key，**B 的对话烧的是 A 的额度**（读口串）；
 *     · `role_bindings` 是全局表 ⇒ **任何登录用户改一次绑定，全站所有人的模型都跟着变**
 *       （写口串——比"能改别人的"更糟，是"能改所有人的"）。
 *
 * ★ 与数据隔离不同的地方：本片有**两条通道**（BYOK 用户自带 key / 平台免费额度）。
 *   所以"平台 provider 对登录用户可见可用"是**要求**而不是漏洞——不可见就没法把角色绑到
 *   免费通道上；但**不可改**，否则回到"能改所有人的"。这两句的边界正是本文件的重点。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-providers-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { seedIfEmpty } = await import('../llm/router.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const PLATFORM_PROVIDER = 'openai-default'; // 种子平台 provider（owner_id = NULL）

async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}

/** 用某个账号建一个自有 provider，返回 id。 */
async function addProvider(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/providers')
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({ name, baseUrl: `https://${name}.example/v1`, apiKey: `sk-${name}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const listProviders = (cookie: string) =>
  request(app).get('/api/providers').set('Origin', origin).set('Cookie', cookie);

const listBindings = (cookie: string) =>
  request(app).get('/api/providers/roles').set('Origin', origin).set('Cookie', cookie);

const bindRole = (cookie: string, role: string, providerId: string, model: string) =>
  request(app)
    .put(`/api/providers/roles/${role}`)
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({ providerId, model });

/** 库里某归属下某角色的绑定行（直读库，避免用接口断言接口）。 */
const bindingRow = (owner: string | null, role: string) =>
  getDb()
    .prepare(`SELECT provider_id, model FROM role_bindings WHERE role = ? AND owner_id IS ?`)
    .get(role, owner) as { provider_id: string; model: string } | undefined;

let cookieA = '';
let cookieB = '';

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  // ★ 每个用例从干净状态起：清掉**非平台**的 provider 与绑定（平台种子保留）。
  //   不这么做的话，前一个用例建的 provider / 绑定会漏进后一个，于是「B 看不到 A 的」
  //   变成「B 看到了上一个用例留下的」——红的是**正确的代码**，这类失败极难读。
  getDb().prepare(`DELETE FROM providers WHERE owner_id IS NOT NULL`).run();
  getDb().prepare(`DELETE FROM role_bindings WHERE owner_id IS NOT NULL`).run();
  seedIfEmpty(); // 平台 provider + 各角色的平台绑定（幂等）
});

cookieA = await signUp('alice@example.com');
cookieB = await signUp('bob@example.com');

afterAll(() => {
  closeDb();
});

describe('providers 列表：平台可见、别人的不可见', () => {
  it('★ A 建的 provider 不出现在 B 的列表里，但平台 provider 两边都在', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const aIds = ((await listProviders(cookieA)).body as Array<{ id: string }>).map((p) => p.id);
    const bIds = ((await listProviders(cookieB)).body as Array<{ id: string }>).map((p) => p.id);

    expect(aIds).toContain(pA);
    expect(bIds).not.toContain(pA); // ★ 别人的不可见
    expect(aIds).toContain(PLATFORM_PROVIDER); // 平台的必须可见（否则绑不到免费通道）
    expect(bIds).toContain(PLATFORM_PROVIDER);
  });

  it('出站带 ownerId（前端据此区分可改/只读），且**不含 key 明文**', async () => {
    await addProvider(cookieA, 'agnes-a');
    const res = await listProviders(cookieA);
    const rows = res.body as Array<{ id: string; ownerId: string | null }>;
    expect(rows.find((p) => p.id === PLATFORM_PROVIDER)?.ownerId).toBeNull();
    expect(rows.find((p) => p.id !== PLATFORM_PROVIDER)?.ownerId).not.toBeNull();
    expect(JSON.stringify(rows)).not.toContain('sk-agnes-a');
  });
});

describe('providers 写口：平台只读、别人的当不存在', () => {
  it('★ 登录用户改不了平台 provider（403，不是 404——它本来就在他的列表里）', async () => {
    const res = await request(app)
      .put(`/api/providers/${PLATFORM_PROVIDER}`)
      .set('Origin', origin)
      .set('Cookie', cookieA)
      .send({ baseUrl: 'https://evil.example/v1' });
    expect(res.status).toBe(403);
    // 库里的平台 provider 一个字节都没动
    const row = getDb().prepare(`SELECT base_url FROM providers WHERE id = ?`).get(PLATFORM_PROVIDER) as {
      base_url: string;
    };
    expect(row.base_url).not.toBe('https://evil.example/v1');
  });

  it('★ 登录用户删不掉平台 provider（否则全站模型全断）', async () => {
    const res = await request(app)
      .delete(`/api/providers/${PLATFORM_PROVIDER}`)
      .set('Origin', origin)
      .set('Cookie', cookieA);
    expect(res.status).toBe(403);
    expect(getDb().prepare(`SELECT 1 AS ok FROM providers WHERE id = ?`).get(PLATFORM_PROVIDER)).toBeDefined();
  });

  it('★ 别人的 provider：改/删一律 404（不回 403——那等于确认"这个 id 存在"）', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const put = await request(app)
      .put(`/api/providers/${pA}`)
      .set('Origin', origin)
      .set('Cookie', cookieB)
      .send({ baseUrl: 'https://stolen.example/v1' });
    const del = await request(app).delete(`/api/providers/${pA}`).set('Origin', origin).set('Cookie', cookieB);
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
    // 既没被改也没被删
    const row = getDb().prepare(`SELECT base_url FROM providers WHERE id = ?`).get(pA) as { base_url: string };
    expect(row.base_url).toBe('https://agnes-a.example/v1');
  });

  it('自己的 provider 改得动（对照组：上面的 403/404 不是因为接口整体坏了）', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const res = await request(app)
      .put(`/api/providers/${pA}`)
      .set('Origin', origin)
      .set('Cookie', cookieA)
      .send({ baseUrl: 'https://new.example/v1' });
    expect(res.status).toBe(200);
    const row = getDb().prepare(`SELECT base_url FROM providers WHERE id = ?`).get(pA) as { base_url: string };
    expect(row.base_url).toBe('https://new.example/v1');
  });
});

describe('角色绑定：★ 改绑定只影响自己（§8.1 的「能改所有人的」）', () => {
  it('A 与 B 各自绑自己的 provider，两条绑定并存互不影响', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const pB = await addProvider(cookieB, 'agnes-b');
    expect((await bindRole(cookieA, 'explain', pA, 'model-a')).status).toBe(200);
    expect((await bindRole(cookieB, 'explain', pB, 'model-b')).status).toBe(200);

    // 用真库断言两条行并存——主键改成复合 `(owner_id, role)` 之前，这里只可能剩一条
    const rows = getDb()
      .prepare(`SELECT owner_id, provider_id, model FROM role_bindings WHERE role = 'explain' AND owner_id IS NOT NULL ORDER BY owner_id`)
      .all() as Array<{ owner_id: string; provider_id: string; model: string }>;
    expect(rows.map((r) => r.model).sort()).toEqual(['model-a', 'model-b']);
    // 平台那条也还在（没被谁顺手覆盖掉）
    expect(bindingRow(null, 'explain')).toBeDefined();
  });

  it('A 重复绑同一角色是**更新**而不是报错（复合 PK 的冲突目标命中）', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const pA2 = await addProvider(cookieA, 'agnes-a2');
    expect((await bindRole(cookieA, 'coach', pA, 'm1')).status).toBe(200);
    expect((await bindRole(cookieA, 'coach', pA2, 'm2')).status).toBe(200);
    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS c, MAX(model) AS m FROM role_bindings WHERE role = 'coach' AND owner_id IS NOT NULL`)
      .get() as { c: number; m: string };
    expect(rows.c).toBe(1); // 不是插了两条
    expect(rows.m).toBe('m2');
  });

  it('★ 绑定到别人的 provider 被拒（400），不留一条"绑上了却用不到"的幽灵行', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const res = await bindRole(cookieB, 'explain', pA, 'model-a');
    expect(res.status).toBe(400);
    expect(bindingRow(await userIdOf(cookieB), 'explain')).toBeUndefined();
  });

  it('绑定到不存在的 provider 也 400（同一道可见性闸门）', async () => {
    const res = await bindRole(cookieA, 'explain', 'p-does-not-exist', 'm');
    expect(res.status).toBe(400);
  });

  it('★ 用户可以把自己的角色绑到**平台** provider 上（免费通道换模型，必须允许）', async () => {
    const res = await bindRole(cookieA, 'summarizer', PLATFORM_PROVIDER, 'cheap-model');
    expect(res.status).toBe(200);
    expect(bindingRow(await userIdOf(cookieA), 'summarizer')).toEqual({
      provider_id: PLATFORM_PROVIDER,
      model: 'cheap-model',
    });
  });
});

describe('GET /roles：回的是**生效**绑定（本人的覆盖平台的）', () => {
  it('A 覆盖 explain 后看到自己的，B 仍看到平台的', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    await bindRole(cookieA, 'explain', pA, 'model-a');

    const findExplain = (body: unknown): { provider_id: string; model: string } | undefined =>
      (body as { bindings: Array<{ role: string; provider_id: string; model: string }> }).bindings.find(
        (b) => b.role === 'explain',
      );

    expect(findExplain((await listBindings(cookieA)).body)?.model).toBe('model-a');
    const bExplain = findExplain((await listBindings(cookieB)).body);
    expect(bExplain?.model).not.toBe('model-a'); // B 看到的是平台那条
    expect(bExplain?.provider_id).toBe(PLATFORM_PROVIDER);
    // 每个角色只回一条（合成过了），不是把两组都丢给前端让它自己挑
    const bindings = ((await listBindings(cookieA)).body as { bindings: unknown[] }).bindings;
    expect(bindings.length).toBe(new Set(bindings.map((b) => (b as { role: string }).role)).size);
  });
});

describe('删除自有 provider：兜底改绑**只动自己的**', () => {
  it('★ A 删掉自己的 provider，B 的绑定一行不动', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    const pB = await addProvider(cookieB, 'agnes-b');
    await bindRole(cookieA, 'explain', pA, 'model-a');
    await bindRole(cookieB, 'explain', pB, 'model-b');

    const del = await request(app).delete(`/api/providers/${pA}`).set('Origin', origin).set('Cookie', cookieA);
    expect(del.status).toBe(200);

    // A 的绑定被兜底改到平台 provider；B 的绑定原封不动
    expect(bindingRow(await userIdOf(cookieA), 'explain')).toEqual({
      provider_id: PLATFORM_PROVIDER,
      model: 'model-a',
    });
    expect(bindingRow(await userIdOf(cookieB), 'explain')).toEqual({ provider_id: pB, model: 'model-b' });
    // 平台那条也不受影响
    expect(bindingRow(null, 'explain')).toBeDefined();
  });
});

/** 从 cookie 反查 user id（用会话模块的公开 API，不依赖 `auth_sessions` 的内部列名）。 */
async function userIdOf(cookie: string): Promise<string> {
  const token = cookie.slice(AUTH_COOKIE_NAME.length + 1);
  const { verifySession } = await import('../auth/session.js');
  const id = verifySession(token);
  if (!id) throw new Error('测试夹具：会话不存在');
  return id;
}
