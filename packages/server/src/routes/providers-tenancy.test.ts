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
import { AUTH_COOKIE_NAME } from '@sb/shared';
import { boot, TEST_ORIGIN } from '../testing/http.js';

const { app, request, getDb, closeDb, signUp } = await boot('routes-providers');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches } = await import('../auth/users.js');
const { seedIfEmpty } = await import('../llm/router.js');
const { MODEL_ROLES, roleReady } = await import('../llm/router.js');

const origin = TEST_ORIGIN;
const PLATFORM_PROVIDER = 'openai-default'; // 种子平台 provider（owner_id = NULL）

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

cookieA = (await signUp('alice@example.com')).cookie;
cookieB = (await signUp('bob@example.com')).cookie;

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

// ── 2026-09-21 本批：一键默认设置 + 免费额度查询 + 平台行拉模型 ────────────────
/** 临时改 env，用完还原（`SB_PLATFORM_*` 是进程级全局，漏还原会污染同文件后续用例）。 */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const oneClick = (cookie: string) =>
  request(app).post('/api/providers/roles/default').set('Origin', origin).set('Cookie', cookie);

/** 某归属下的全部绑定行（直读库，避免用接口断言接口）。 */
const bindingRows = (owner: string | null) =>
  getDb()
    .prepare('SELECT role, provider_id, model FROM role_bindings WHERE owner_id IS ?')
    .all(owner) as Array<{ role: string; provider_id: string; model: string }>;

describe('一键默认设置（POST /roles/default）', () => {
  it('★ 只写**自己的** 8 条绑定；平台行与别人的绑定一行不动', async () => {
    const pA = await addProvider(cookieA, 'agnes-a');
    await bindRole(cookieA, 'explain', pA, 'a-model'); // A 先配了 BYOK
    const pB = await addProvider(cookieB, 'agnes-b');
    await bindRole(cookieB, 'explain', pB, 'b-model');
    const platformBefore = bindingRow(null, 'explain');

    const res = await oneClick(cookieA);
    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe(PLATFORM_PROVIDER);
    // env 未配 ⇒ 回落常量。回给前端的是"配完实际会用哪个模型"，不是让用户猜
    expect(res.body.model).toBe('agnes-2.5-flash');
    expect(res.body.roles).toBe(MODEL_ROLES.length);

    const uid = await userIdOf(cookieA);
    const mine = bindingRows(uid);
    expect(mine.length).toBe(MODEL_ROLES.length);
    // 8 个角色全部指向平台 provider，且 model **留空**（单一真相源：绑定表 > env > 常量）
    for (const r of mine) {
      expect(r.provider_id).toBe(PLATFORM_PROVIDER);
      expect(r.model).toBe('');
    }
    // ★ 不是管理员动作：B 的 BYOK 绑定与平台行都必须原封不动
    expect(bindingRow(await userIdOf(cookieB), 'explain')).toEqual({ provider_id: pB, model: 'b-model' });
    expect(bindingRow(null, 'explain')).toEqual(platformBefore);
  });

  it('★ 幂等：连点两次不会插出重复行（复合 PK 命中 DO UPDATE）', async () => {
    await oneClick(cookieA);
    await oneClick(cookieA);
    const uid = await userIdOf(cookieA);
    expect(bindingRows(uid).length).toBe(MODEL_ROLES.length);
  });

  it('★ 一键默认之后角色**真的就绪**（不能"配了却报该角色还没绑定模型"）', async () => {
    await withEnv(
      { SB_PLATFORM_API_KEY: 'sk-platform-ENV', SB_PLATFORM_BASE_URL: 'https://relay.example/v1' },
      async () => {
        await oneClick(cookieA);
        const uid = await userIdOf(cookieA);
        // 每个角色都要就绪 —— 这是本批的核心承诺：一键配完 = 立刻能用
        for (const { role } of MODEL_ROLES) {
          expect(roleReady(role, uid)).toEqual({ ok: true, reason: '' });
        }
      },
    );
  });

  it('★ 没配 key 时**不许**假装就绪（reason 指向密钥，不是"没绑模型"）', async () => {
    await oneClick(cookieA);
    const uid = await userIdOf(cookieA);
    const r = roleReady('explain', uid);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('密钥');
  });

  it('★ 平台 provider 全停用 ⇒ 409，不写任何绑定、不假装成功', async () => {
    const uid = await userIdOf(cookieA);
    getDb().prepare(`UPDATE providers SET enabled = 0 WHERE owner_id IS NULL`).run();
    try {
      const res = await oneClick(cookieA);
      expect(res.status).toBe(409);
      expect(bindingRows(uid).length).toBe(0); // 一条都没写
    } finally {
      getDb().prepare(`UPDATE providers SET enabled = 1 WHERE owner_id IS NULL`).run(); // 别漏给后续用例
    }
  });
});

describe('平台免费额度查询（GET /quota）', () => {
  it('登录用户回窗口用量与上限（前端显示"还剩 N 次"）', async () => {
    const res = await request(app).get('/api/providers/quota').set('Origin', origin).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body.limited).toBe(true);
    expect(res.body.limit).toBe(250);
    expect(res.body.used).toBe(0);
  });
});

describe('平台服务商拉模型列表：走 env 凭据', () => {
  it('★ 库里的 key 是空的，但列表必须拉得到（否则设置页的下拉永远是空的）', async () => {
    // 前提：平台行的 api_key 确实是空串（v39 起 key 只在 env）
    const row = getDb().prepare(`SELECT api_key FROM providers WHERE id = ?`).get(PLATFORM_PROVIDER) as {
      api_key: string;
    };
    expect(row.api_key).toBe('');

    await withEnv(
      { SB_PLATFORM_API_KEY: 'sk-platform-ENV', SB_PLATFORM_BASE_URL: 'https://relay.example/v1' },
      async () => {
        const calls: Array<{ url: string; auth: string }> = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: unknown, init: unknown) => {
          const i = init as { headers?: Record<string, string> } | undefined;
          calls.push({ url: String(url), auth: String(i?.headers?.Authorization ?? '') });
          return new Response(JSON.stringify({ data: [{ id: 'agnes-2.5-flash' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch;
        try {
          const res = await request(app)
            .get(`/api/providers/${PLATFORM_PROVIDER}/models`)
            .set('Origin', origin)
            .set('Cookie', cookieA);
          expect(res.status).toBe(200);
          expect(res.body.models).toEqual(['agnes-2.5-flash']);
          // 打的是 env 里的地址、带的是 env 里的 key（而不是库里那个空的）
          expect(calls.length).toBe(1);
          expect(calls[0]?.url).toBe('https://relay.example/v1/models');
          expect(calls[0]?.auth).toBe('Bearer sk-platform-ENV');
          // ★ 老板要求 key 对用户不可见：响应体里一个字节都不许有
          expect(JSON.stringify(res.body)).not.toContain('sk-platform-ENV');
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });
});
