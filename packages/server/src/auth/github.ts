/**
 * auth/github — GitHub OAuth 登录域逻辑（契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 定位：第三条登录通道（密码 / 验证码之外）。**产出与前两条完全相同的会话**
 * （路由层复用同一个 `createSession` + `sb_sid` cookie），不是第二套账号体系——
 * 「证明你是谁」的方式变了，会话与归属逻辑（TENANCY-SPEC）零分支。
 *
 * ★ 归并口径（2026-09-20 老板拍板）：GitHub 的**已验证邮箱**命中现有 `users.email`
 *   ⇒ 直接登入该账号并回填 `github_id`；没命中 ⇒ 新建账号。符合 §0.1
 *   「两套身份映射到同一 user，不新建割裂账号」的既定原则。
 * ★ 建号时 `password_hash` 写**两次 randomUUID 拼接的 scrypt 哈希**：列是 NOT NULL，
 *   而 GitHub 建号的账号没有口令——随机串让密码登录对它永远 `CREDENTIALS_INVALID`
 *   （等价于"口令不可知"，不为此把约束改可空再整表重建）。
 *
 * ★ 域层不碰 HTTP（同 `users.ts` / `code-flow.ts` 手法）：失败抛 `AuthError` 码，
 *   薄路由映射状态码与错误页。网络函数一律收 `fetchImpl` 参数（缺省全局 fetch）——
 *   测试注入桩，**绝不真连 github.com**。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AUTH_NICKNAME_MAX,
  nicknameFromEmail,
  normalizeEmail,
  type AuthError,
  type AuthUser,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { hashPassword } from './password.js';

/** GitHub 身份（`GET /user` + `GET /user/emails` 的最小投影，只取登录要用的字段）。 */
export interface GithubIdentity {
  /** GitHub 数字用户 id（库内 `users.github_id` 存字符串形态） */
  id: number;
  login: string;
  name: string | null;
  /** 已验证邮箱（primary 优先）；拿不到已验证邮箱时上游已抛 `GITHUB_EMAIL_UNAVAILABLE` */
  email: string;
}

type FetchImpl = typeof fetch;

function envValue(key: string): string {
  return (process.env[key] ?? '').trim();
}

/** GitHub OAuth 是否已配置（`/api/auth/providers` 与 `/github` 入口都看它）。 */
export function githubConfigured(): boolean {
  return Boolean(envValue('SB_GITHUB_CLIENT_ID') && envValue('SB_GITHUB_CLIENT_SECRET'));
}

/**
 * 授权页跳转 URL（纯字符串拼接，不网络）。
 * ★ scope 只要 `user:email`：读邮箱（归并的依据）够用；`read:org` / repo 类权限一概不要
 *   ——OAuth 最小权限，多要一个 scope 用户授权页就多一行吓人的说明。
 */
export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: envValue('SB_GITHUB_CLIENT_ID'),
    redirect_uri: redirectUri,
    scope: 'user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * 授权码换 access token（`POST /login/oauth/access_token`）。
 * ★ `redirect_uri` **必须与授权步一致**：GitHub 对两步的 redirect_uri 做比对，
 *   不一致直接 `redirect_uri_mismatch`——所以两端点必须用同一个 `baseUrl(req)` 派生。
 */
export async function exchangeCode(code: string, redirectUri: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: envValue('SB_GITHUB_CLIENT_ID'),
        client_secret: envValue('SB_GITHUB_CLIENT_SECRET'),
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
  }
  if (!res.ok) throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
  }
  return body.access_token;
}

/** 从 `/user/emails` 里挑归并依据：**已验证**优先级下 primary → verified 任一 → 无 ⇒ 抛码。 */
export function pickVerifiedEmail(
  emails: Array<{ email: string; primary: boolean; verified: boolean }>,
): string | null {
  const primary = emails.find((e) => e.primary && e.verified);
  if (primary) return primary.email;
  const anyVerified = emails.find((e) => e.verified);
  return anyVerified ? anyVerified.email : null;
}

/** 拉取 GitHub 用户身份（`/user` + `/user/emails`）。★ GitHub API 强制要求 User-Agent。 */
export async function fetchGithubIdentity(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<GithubIdentity> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'studentbuddy-v2',
  };
  let profile: { id?: unknown; login?: unknown; name?: unknown; email?: unknown };
  let emails: Array<{ email: string; primary: boolean; verified: boolean }>;
  try {
    const [pRes, eRes] = await Promise.all([
      fetchImpl('https://api.github.com/user', { headers }),
      fetchImpl('https://api.github.com/user/emails', { headers }),
    ]);
    if (!pRes.ok || !eRes.ok) throw new Error('GITHUB_AUTH_FAILED');
    profile = (await pRes.json()) as typeof profile;
    emails = (await eRes.json()) as typeof emails;
  } catch {
    throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
  }
  if (typeof profile.id !== 'number' || typeof profile.login !== 'string') {
    throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
  }
  // ★ 只认「已验证」邮箱：未验证的邮箱任何人都能往 GitHub 账号上填，拿它归并等于
  //   把「知道某人的邮箱」升级成「能登入某人的账号」——归并的正确性建立在
  //   GitHub 的邮箱验证体系上，不建立在我们自己的邮箱验证上。
  const email = pickVerifiedEmail(Array.isArray(emails) ? emails : []) ?? (profile.email && typeof profile.email === 'string' ? profile.email : null);
  if (!email) throw new Error('GITHUB_EMAIL_UNAVAILABLE' satisfies AuthError);
  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === 'string' ? profile.name : null,
    email,
  };
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  nickname: string;
  github_id: string | null;
  created_at: string;
}

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, nickname: row.nickname, createdAt: row.created_at };
}

/** GitHub 昵称：name → login → 邮箱派生，统一截到 `AUTH_NICKNAME_MAX`（与邮箱注册同口径）。 */
function nicknameFromIdentity(identity: GithubIdentity, email: string): string {
  const raw = (identity.name ?? '').trim() || identity.login.trim();
  if (!raw) return nicknameFromEmail(email);
  return raw.slice(0, AUTH_NICKNAME_MAX);
}

function findRowByEmail(email: string): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) ?? null;
}

function findRowById(id: string): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

/**
 * GitHub 登录 / 建号（契约 §2.8 第 4 条）。返回契约用户，路由层据此发会话。
 * ★ 回填 `github_id` 是**幂等**的：同邮箱第二次登录走到这里，列已有值且相同 ⇒ 不再 UPDATE。
 */
export async function loginViaGithub(identity: GithubIdentity): Promise<AuthUser> {
  const email = normalizeEmail(identity.email);
  if (!email) throw new Error('GITHUB_EMAIL_UNAVAILABLE' satisfies AuthError);
  const existing = findRowByEmail(email);
  if (existing) {
    if (existing.github_id !== null && existing.github_id !== String(identity.id)) {
      // 归并撞号：邮箱已绑定**另一个** GitHub 账号。放行等于允许第二个 GitHub 身份
      // 冒用该邮箱登入，必须是显式失败而不是静默顶替。
      throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
    }
    if (existing.github_id === null) {
      getDb().prepare('UPDATE users SET github_id = ? WHERE id = ?').run(String(identity.id), existing.id);
    }
    const fresh = findRowById(existing.id);
    if (!fresh) throw new Error('USER_ROW_MISSING');
    return toAuthUser(fresh);
  }

  const id = `u-${randomUUID()}`;
  const nickname = nicknameFromIdentity(identity, email);
  const passwordHash = await hashPassword(`${randomUUID()}${randomUUID()}`);
  try {
    getDb()
      .prepare('INSERT INTO users (id, email, password_hash, nickname, github_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, passwordHash, nickname, String(identity.id));
  } catch (e) {
    // 并发回调同邮箱：UNIQUE(email) 兜底——回读既有行按归并口径走（含 github_id 回填检查）
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      const raced = findRowByEmail(email);
      if (!raced || (raced.github_id !== null && raced.github_id !== String(identity.id))) {
        throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
      }
      const fresh = findRowById(raced.id);
      if (!fresh) throw new Error('USER_ROW_MISSING');
      return toAuthUser(fresh);
    }
    throw e;
  }
  // 与 createUser 同一手法：回读库行再映射（created_at 格式以库为准，内存对象不做事实源）
  const created = findRowById(id);
  if (!created) throw new Error('USER_ROW_MISSING');
  return toAuthUser(created);
}

/**
 * OAuth state 校验（CSRF 防线，契约 §2.8 第 3 条）。
 * ★ `timingSafeEqual` 逐字节比：state 虽是随机 UUID、逐字符比也不构成可利用的旁路，
 *   但防线代码不赌「攻击面不存在」，标准写法十行以内。
 */
export function verifyState(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
