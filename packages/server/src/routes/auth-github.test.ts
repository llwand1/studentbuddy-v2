/**
 * routes/auth-github 端到端（supertest，同 `routes/auth.test.ts` 手法；契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 钉死可观测承诺，不复述实现：
 *  · `/providers` 如实反映 GitHub 是否配置（前端画不画按钮的唯一依据）；
 *  · `/github` 发 state cookie + 302 到 GitHub 授权页（redirect_uri 与 callback 同源）；
 *  · `/github/callback` 全链：换 token → 拉身份 → **按 `github_id` 查号 / 建号** → 发 `sb_sid` → 302 回 `/`；
 *  · state 不过 = CSRF 拒绝；换 token 失败 = 可读错误页，**不建号不发会话**。
 *
 * ★★ **2026-09-21（独立建号批）本文件的立场整体反转**：原口径是「按**邮箱**自动归并」，
 *   新口径是「**只按 `github_id` 认人，同邮箱也建独立账号**」。四处用例因此反转：
 *   ① 「命中既有账号 → 归并同一 user」→ 「**仍建独立账号**」；
 *   ② 「`github_id` 已绑定其他账号 → 撞号失败」→ 「**登入该账号**」；
 *   ③ 「没有已验证邮箱 → 502」→ 「**照常建号**」；
 *   ④ 建号用例的 `email` 断言 → 改为「**占位串 + `github_email`**」。
 *   ⚠️ **这四条正是本次口径变更的判别力所在** —— 只改实现不改测试，改动会被「旧用例已删」掩盖
 *   而新行为无人守。故每组都配一条**反向锁**（如「旧账号的 `github_id` **仍为 NULL**」），
 *   只断言「建了新号」是拦不住「顺手把人也归并了」的。
 *
 * ★ 网络**绝不真连** github.com：`fetch` 全部桩掉（域层函数收 `fetchImpl`，路由层走全局
 *   fetch——测试桩放在全局上，两层都覆盖到）。
 * ★ 本文件直接 INSERT 既有用户来做「同邮箱」用例（不走 register 验证码流程）—— 绕开
 *   验证码限流，让用例互不牵连。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, AUTH_GITHUB_STATE_COOKIE } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-gh-test-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const CLIENT_ID = 'test-client-id';

/** 给当前用例配上 GitHub 凭据；用例结束统一清（`afterEach`），防串到未配置用例。 */
function enableGithub(): void {
  process.env.SB_GITHUB_CLIENT_ID = CLIENT_ID;
  process.env.SB_GITHUB_CLIENT_SECRET = 'test-secret';
}

function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

/** 从 set-cookie 头取指定 cookie 的 `name=value` 段。 */
function cookieValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const hit = arr.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`预期有 ${name} cookie，实际没有`);
  return hit.split(';')[0] ?? '';
}

/** 桩 fetch：按 URL 分流——换 token / 拉身份 / 拉邮箱。 */
function stubGithub(opts: {
  token?: string | null;
  profile?: unknown;
  emails?: unknown;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://github.com/login/oauth/access_token')) {
      if (!opts.token) return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
      return new Response(JSON.stringify({ access_token: opts.token }), { status: 200 });
    }
    if (u === 'https://api.github.com/user') return new Response(JSON.stringify(opts.profile), { status: 200 });
    if (u === 'https://api.github.com/user/emails') return new Response(JSON.stringify(opts.emails), { status: 200 });
    return new Response('unexpected', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function insertUser(id: string, email: string, githubId: string | null = null, githubEmail: string | null = null): void {
  getDb()
    .prepare(
      'INSERT INTO users (id, email, password_hash, nickname, github_id, github_email) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, email, 'x-not-a-real-hash', '老昵称', githubId, githubEmail);
}

/** 走完整授权跳转拿到 state cookie（多数 callback 用例的前置动作）。 */
async function beginAuth(): Promise<string> {
  const gate = await request(app).get('/api/auth/github').redirects(0);
  return cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);
}

/** 用 callback 返回的会话 cookie 调 `/me`，取**用户真正会看到的** email。 */
async function meEmail(headers: Record<string, string | string[] | undefined>): Promise<string> {
  const sid = cookieValue(headers, AUTH_COOKIE_NAME);
  const me = await request(app).get('/api/auth/me').set('Cookie', sid);
  return (me.body as { user: { email: string } }).user.email;
}

interface UserRowShape {
  id: string;
  email: string;
  nickname: string;
  github_id: string | null;
  github_email: string | null;
}

function rowByGithubId(githubId: string): UserRowShape | undefined {
  return getDb()
    .prepare('SELECT id, email, nickname, github_id, github_email FROM users WHERE github_id = ?')
    .get(githubId) as UserRowShape | undefined;
}

function rowById(id: string): UserRowShape | undefined {
  return getDb()
    .prepare('SELECT id, email, nickname, github_id, github_email FROM users WHERE id = ?')
    .get(id) as UserRowShape | undefined;
}

beforeEach(() => {
  enableGithub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SB_GITHUB_CLIENT_ID;
  delete process.env.SB_GITHUB_CLIENT_SECRET;
});

afterAll(() => {
  closeDb();
});

describe('routes/auth-github — /providers 可用性探针（§2.8 第 1 条 / §2.9 形态）', () => {
  it('未配置 → github:false；配置后 → github:true；本测试进程未开强制鉴权 ⇒ form:local', async () => {
    delete process.env.SB_GITHUB_CLIENT_ID;
    const off = await request(app).get('/api/auth/providers');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ providers: { github: false, demo: false }, form: 'local' });

    enableGithub();
    const on = await request(app).get('/api/auth/providers');
    expect(on.body).toEqual({ providers: { github: true, demo: false }, form: 'local' });
  });
});

describe('routes/auth-github — /github 授权跳转（§2.8 第 2 条）', () => {
  it('发 state cookie 并 302 到授权页（redirect_uri 与 callback 同源）', async () => {
    const res = await request(app).get('/api/auth/github').redirects(0);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    // ★ scope 仍是 user:email —— 邮箱虽不再作身份依据，但**账号菜单要显示它**，
    //   唯一来源就是 /user/emails。⚠️ 别把它当成"缩到最小"的实施遗漏（契约 §2.8 已说明）。
    expect(location.searchParams.get('scope')).toBe('user:email');
    expect(location.searchParams.get('redirect_uri')).toContain('/api/auth/github/callback');
    // state 同时出现在跳转 URL 与 httpOnly cookie 里——callback 比对的就是这两份
    const state = cookieValue(res.headers, AUTH_GITHUB_STATE_COOKIE);
    expect(location.searchParams.get('state')).toBe(state.split('=')[1]);
  });

  it('未配置 → 503 可读错误页，不跳转不建号', async () => {
    delete process.env.SB_GITHUB_CLIENT_ID;
    const res = await request(app).get('/api/auth/github').redirects(0);
    expect(res.status).toBe(503);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('邮箱');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('routes/auth-github — /github/callback 全链（§2.8 第 4 条）', () => {
  it('新 GitHub 账号 → 建号；email 列写占位串、github_email 存真实邮箱、昵称取 name', async () => {
    stubGithub({
      token: 'tok-1',
      profile: { id: 9001, login: 'monalisa', name: 'Lisa', email: null },
      emails: [{ email: 'lisa@Example.com', primary: true, verified: true }],
    });
    const state = await beginAuth();
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(userCount()).toBe(before + 1);

    const row = rowByGithubId('9001');
    expect(row?.nickname).toBe('Lisa');
    // ★ `users.email` 是**占位串**（RFC 2606 保留域），不是真实邮箱 —— 同邮箱要能另起一行账号
    expect(row?.email).toBe('gh-9001@users.noreply.invalid');
    // ★ 真实邮箱存在 github_email 列，且**刻意不做 normalize**（它是展示值、不是身份键，尊重原样）
    expect(row?.github_email).toBe('lisa@Example.com');

    // ★★ 反向锁：接口返回里**绝不能**出现占位串（AccountTrigger 会把它直接渲染进账号菜单）
    const seen = await meEmail(res.headers);
    expect(seen).toBe('lisa@Example.com');
    expect(seen).not.toContain('noreply.invalid');
  });

  it('★★ 同邮箱命中既有账号 → 仍建**独立**账号（不归并、不登入、不回填）', async () => {
    insertUser('u-existing', 'merge@example.com');
    stubGithub({
      token: 'tok-2',
      profile: { id: 9002, login: 'merge-user', name: null, email: 'merge@example.com' },
      emails: [{ email: 'merge@example.com', primary: true, verified: true }],
    });
    const state = await beginAuth();
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(302);

    // ★ ① 新建了一个账号（**不是**归并到 u-existing）
    expect(userCount()).toBe(before + 1);
    const fresh = rowByGithubId('9002');
    expect(fresh).toBeDefined();
    expect(fresh?.id).not.toBe('u-existing');
    expect(fresh?.email).toBe('gh-9002@users.noreply.invalid');
    expect(fresh?.github_email).toBe('merge@example.com');

    // ★★ ② 反向锁：既有账号**一格都没被动过** —— 没回填 github_id、没改 email
    //   （只断言"建了新号"是拦不住"顺手也把人归并了"的，所以这条必须单独钉）
    const old = rowById('u-existing');
    expect(old?.github_id).toBeNull();
    expect(old?.email).toBe('merge@example.com');

    // ★ ③ 登入的是**新**账号，不是旧账号
    const seen = await meEmail(res.headers);
    expect(seen).toBe('merge@example.com');
    expect(fresh?.id).not.toBe(old?.id);
  });

  it('★★ 同一 github_id 二次登录 → 回到**同一**账号（绝不重复建号）', async () => {
    const stub = () =>
      stubGithub({
        token: 'tok-3',
        profile: { id: 9003, login: 'twice', name: 'Twice', email: null },
        emails: [{ email: 'twice@example.com', primary: true, verified: true }],
      });
    // 第一次
    stub();
    const s1 = await beginAuth();
    await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: s1.split('=')[1] })
      .set('Cookie', s1)
      .redirects(0);
    const afterFirst = userCount();
    const firstId = rowByGithubId('9003')?.id;

    // 第二次（同 id）
    stub();
    const s2 = await beginAuth();
    const res2 = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: s2.split('=')[1] })
      .set('Cookie', s2)
      .redirects(0);
    expect(res2.status).toBe(302);

    // ★★ 这是「查号键必须是 github_id」的判别力所在：退化成"每次新建"时用户数据会全丢
    expect(userCount()).toBe(afterFirst);
    expect(rowByGithubId('9003')?.id).toBe(firstId);
  });

  it('★ 不同 github_id 用同一邮箱 → 建**两个**互相独立的账号（不撞 UNIQUE）', async () => {
    const withEmail = (id: number) =>
      stubGithub({
        token: `tok-${id}`,
        profile: { id, login: `gh${id}`, name: null, email: null },
        emails: [{ email: 'shared@example.com', primary: true, verified: true }],
      });
    const before = userCount();
    for (const id of [9101, 9102]) {
      withEmail(id);
      const s = await beginAuth();
      const r = await request(app)
        .get('/api/auth/github/callback')
        .query({ code: 'abc', state: s.split('=')[1] })
        .set('Cookie', s)
        .redirects(0);
      expect(r.status).toBe(302);
    }
    expect(userCount()).toBe(before + 2);
    expect(rowByGithubId('9101')?.github_email).toBe('shared@example.com');
    expect(rowByGithubId('9102')?.github_email).toBe('shared@example.com');
  });

  it('★ GitHub 账号不占用真实邮箱位：邮箱注册的查重看不到它（EMAIL_TAKEN 不误报）', async () => {
    stubGithub({
      token: 'tok-4',
      profile: { id: 9103, login: 'holder', name: null, email: null },
      emails: [{ email: 'taken@example.com', primary: true, verified: true }],
    });
    const s = await beginAuth();
    await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: s.split('=')[1] })
      .set('Cookie', s)
      .redirects(0);

    // ★ 真实邮箱**没有**进 email 列 ⇒ 邮箱注册的 `findByEmailRow` 查不到它 ⇒ 不会误报 EMAIL_TAKEN。
    //   这正是「两个独立账号」在库层的落实方式（若哪天有人把真实邮箱写回 email 列，这条当场红）。
    const occupying = getDb()
      .prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?')
      .get('taken@example.com') as { c: number };
    expect(occupying.c).toBe(0);
  });

  it('state 不过 → 400 错误页，不发会话不落库', async () => {
    stubGithub({ token: 'tok-5', profile: { id: 3, login: 'a' }, emails: [] });
    const before = userCount();
    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: 'forged-state' })
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.type).toBe('text/html');
    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))).toBe(false);
    expect(userCount()).toBe(before);
  });

  it('换 token 失败（GitHub 返回 error）→ 502 错误页，不落库', async () => {
    stubGithub({ token: null });
    const state = await beginAuth();
    const before = userCount();
    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(502);
    expect(userCount()).toBe(before);
  });

  it('★★ 没有已验证邮箱 → **照常建号**（旧口径的 502 已取消），展示邮箱退到 noreply', async () => {
    stubGithub({
      token: 'tok-6',
      profile: { id: 9006, login: 'unverified', name: 'U', email: null },
      emails: [{ email: 'un@verified.com', primary: true, verified: false }],
    });
    const state = await beginAuth();
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    // ★ 反转点：旧口径此处是 502「先去 GitHub 验证邮箱」，新口径邮箱不作身份依据 ⇒ 正常放行
    expect(res.status).toBe(302);
    expect(userCount()).toBe(before + 1);

    const row = rowByGithubId('9006');
    // ★ 未验证的邮箱**不采用**（它会误导用户），退到 GitHub 官方的 noreply 格式
    expect(row?.github_email).toBe('unverified@users.noreply.github.com');
    expect(row?.email).toBe('gh-9006@users.noreply.invalid');

    const seen = await meEmail(res.headers);
    expect(seen).toBe('unverified@users.noreply.github.com');
    expect(seen).not.toContain('noreply.invalid');
  });

  it('★ 完全拿不到邮箱（profile.email 为 null 且 emails 为空）→ 仍建号，昵称退到 login', async () => {
    stubGithub({
      token: 'tok-7',
      profile: { id: 9007, login: 'no-mail', name: null, email: null },
      emails: [],
    });
    const state = await beginAuth();
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(302);
    expect(userCount()).toBe(before + 1);

    const row = rowByGithubId('9007');
    expect(row?.github_email).toBe('no-mail@users.noreply.github.com');
    expect(row?.nickname).toBe('no-mail'); // name 为空 ⇒ 退到 login（不再依赖邮箱派生）
  });

  it('★ github_id 已在库中（旧口径的「撞号失败」）→ 登入该账号，不新建不报错', async () => {
    insertUser('u-owner', 'owner@example.com', '9008', 'owner-gh@example.com');
    stubGithub({
      token: 'tok-8',
      profile: { id: 9008, login: 'squatter', name: null, email: null },
      emails: [{ email: 'other@example.com', primary: true, verified: true }],
    });
    const state = await beginAuth();
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    // ★ 反转点：旧口径按邮箱查、发现 github_id 已绑别的邮箱 ⇒ 502；新口径按 github_id 认人，
    //   这个 id 本来就属于 u-owner ⇒ 正常登入
    expect(res.status).toBe(302);
    expect(userCount()).toBe(before);
    expect(rowByGithubId('9008')?.id).toBe('u-owner');

    // ★ 展示邮箱被对齐到本次拿到的真实值（`syncGithubEmail` 幂等），不再停留在旧值
    expect(rowByGithubId('9008')?.github_email).toBe('other@example.com');
  });
});
