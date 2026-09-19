/**
 * routes/auth-github 端到端（supertest，同 `routes/auth.test.ts` 手法；契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 钉死可观测承诺，不复述实现：
 *  · `/providers` 如实反映 GitHub 是否配置（前端画不画按钮的唯一依据）；
 *  · `/github` 发 state cookie + 302 到 GitHub 授权页（redirect_uri 与 callback 同源）；
 *  · `/github/callback` 全链：换 token → 拉身份 → **按邮箱归并 / 新建** → 发 `sb_sid` → 302 回 `/`；
 *  · state 不过 = CSRF 拒绝；换 token 失败 / 无已验证邮箱 = 可读错误页，**不建号不发会话**。
 *
 * ★ 网络**绝不真连** github.com：`fetch` 全部桩掉（域层函数收 `fetchImpl`，路由层走
 *   全局 fetch——测试桩在全局上，两层都覆盖到）。
 * ★ 本文件直接 INSERT 既有用户来做归并用例（不走 register 验证码流程）——归并不依赖
 *   密码正确性，绕开验证码限流让用例互不牵连。
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

function insertUser(id: string, email: string, githubId: string | null = null): void {
  getDb()
    .prepare('INSERT INTO users (id, email, password_hash, nickname, github_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, 'x-not-a-real-hash', '老昵称', githubId);
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

describe('routes/auth-github — /providers 可用性探针（§2.8 第 1 条）', () => {
  it('未配置 → github:false；配置后 → github:true', async () => {
    delete process.env.SB_GITHUB_CLIENT_ID;
    const off = await request(app).get('/api/auth/providers');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ providers: { github: false } });

    enableGithub();
    const on = await request(app).get('/api/auth/providers');
    expect(on.body).toEqual({ providers: { github: true } });
  });
});

describe('routes/auth-github — /github 授权跳转（§2.8 第 2 条）', () => {
  it('发 state cookie 并 302 到授权页（redirect_uri 与 callback 同源）', async () => {
    const res = await request(app).get('/api/auth/github').redirects(0);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
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
  it('新邮箱 → 建号（github_id 落库、昵称取 name）+ 发会话 + 回首页', async () => {
    stubGithub({
      token: 'tok-1',
      profile: { id: 9001, login: 'monalisa', name: 'Lisa', email: null },
      emails: [{ email: 'lisa@Example.com', primary: true, verified: true }],
    });
    const gate = await request(app).get('/api/auth/github').redirects(0);
    const state = cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(cookieValue(res.headers, AUTH_COOKIE_NAME)).toContain(`${AUTH_COOKIE_NAME}=`);

    const row = getDb().prepare('SELECT id, email, nickname, github_id FROM users WHERE email = ?').get('lisa@example.com') as
      | { id: string; email: string; nickname: string; github_id: string | null }
      | undefined;
    expect(row?.github_id).toBe('9001');
    expect(row?.nickname).toBe('Lisa');
  });

  it('已验证邮箱命中既有账号 → 归并同一 user（不新建、回填 github_id）', async () => {
    insertUser('u-existing', 'merge@example.com');
    stubGithub({
      token: 'tok-2',
      profile: { id: 9002, login: 'merge-user', name: null, email: 'merge@example.com' },
      emails: [{ email: 'merge@example.com', primary: true, verified: true }],
    });
    const gate = await request(app).get('/api/auth/github').redirects(0);
    const state = cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);
    const before = userCount();

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(302);
    expect(userCount()).toBe(before);
    const row = getDb().prepare('SELECT id, github_id FROM users WHERE email = ?').get('merge@example.com') as
      | { id: string; github_id: string | null }
      | undefined;
    expect(row?.id).toBe('u-existing');
    expect(row?.github_id).toBe('9002');
  });

  it('state 不过 → 400 错误页，不发会话不落库', async () => {
    stubGithub({ token: 'tok-3', profile: { id: 3, login: 'a' }, emails: [] });
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
    const gate = await request(app).get('/api/auth/github').redirects(0);
    const state = cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);
    const before = userCount();
    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(502);
    expect(userCount()).toBe(before);
  });

  it('没有已验证邮箱 → 502 错误页（不拿未验证邮箱建号）', async () => {
    stubGithub({
      token: 'tok-4',
      profile: { id: 9004, login: 'unverified', name: 'U', email: null },
      emails: [{ email: 'un@verified.com', primary: true, verified: false }],
    });
    const gate = await request(app).get('/api/auth/github').redirects(0);
    const state = cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);
    const before = userCount();
    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(502);
    expect(res.text).toContain('验证邮箱');
    expect(userCount()).toBe(before);
  });

  it('github_id 已绑定其他账号（撞号）→ 显式失败，不顶替', async () => {
    insertUser('u-owner', 'owner@example.com', '9005');
    stubGithub({
      token: 'tok-5',
      profile: { id: 9005, login: 'squatter', name: null, email: null },
      emails: [{ email: 'other@example.com', primary: true, verified: true }],
    });
    const gate = await request(app).get('/api/auth/github').redirects(0);
    const state = cookieValue(gate.headers, AUTH_GITHUB_STATE_COOKIE);
    const before = userCount();
    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc', state: state.split('=')[1] })
      .set('Cookie', state)
      .redirects(0);
    expect(res.status).toBe(502);
    expect(userCount()).toBe(before);
    const row = getDb().prepare('SELECT github_id FROM users WHERE email = ?').get('other@example.com') as
      | { github_id: string | null }
      | undefined;
    expect(row).toBeUndefined();
  });
});
