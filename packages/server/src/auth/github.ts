/**
 * auth/github — GitHub OAuth 登录域逻辑（契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 定位：第三条登录通道（密码 / 验证码之外）。**产出与前两条完全相同的会话**
 * （路由层复用同一个 `createSession` + `sb_sid` cookie），不是第二套会话体系——
 * 「证明你是谁」的方式变了，会话与归属逻辑（TENANCY-SPEC）零分支。
 *
 * ★★ **认人口径（2026-09-21 老板拍板，推翻 2026-09-20 的「按邮箱自动归并」）**：
 *   GitHub 登录**只按 `github_id` 认人，绝不按邮箱归并**。同一邮箱在站内有邮箱账号、
 *   GitHub 也用该邮箱 ⇒ **两个彼此独立的账号**（数据不互通，这是**刻意**的）。
 *   理由：GitHub 的邮箱验证体系由**第三方**掌握，拿它当「可登入本站同邮箱账号」的凭据，
 *   等于把本站账号的进入权外包给 GitHub（且用户无法在本站侧单独撤销）。详见契约 §0.1/§2.8。
 *
 * ★ **两条最容易做错、后果最重的点**（改这个文件前先读这两条）：
 *   ① **查号键必须是 `github_id`** —— 同一 GitHub 账号**再次登录**要找回**同一个** users 行；
 *      退化成「每次登录都新建」，用户第二次登录时历史数据会全部消失（且**全程不报错**）。
 *   ② ★ **绝不按邮箱去找既有账号** —— 那是**旧口径**，改回来就等于把「独立」两个字抹掉，
 *      而症状是「用户被静默登入到另一个账号上」，除测试外没有任何报错可依赖。
 *
 * ★ **`users.email` 存占位串**：该列是 `TEXT NOT NULL UNIQUE`，而新口径要求「同邮箱能有两个
 *   账号」⇒ 真实邮箱进不了这一列。改 UNIQUE 约束在 SQLite 要整表重建（12 步），风险不成比例
 *   ⇒ GitHub 账号在此列写 `gh-<github_id>@users.noreply.invalid`（RFC 2606 保留 TLD、
 *   **永不可解析**；`github_id` 唯一 ⇒ 占位唯一性天然成立），真实邮箱另存 `github_email`。
 *   `AuthUser.email` 取 `github_email ?? email` ⇒ **用户看到的仍是真实邮箱，占位串绝不外泄**。
 *
 * ★ 建号时 `password_hash` 写**两次 randomUUID 拼接的 scrypt 哈希**：列是 NOT NULL，
 *   而 GitHub 建号的账号没有口令——随机串让密码登录对它永远 `CREDENTIALS_INVALID`
 *   （等价于"口令不可知"，不为此把约束改可空再整表重建）。
 *
 * ★ 域层不碰 HTTP（同 `users.ts` / `code-flow.ts` 手法）：失败抛 `AuthError` 码，
 *   薄路由映射状态码与错误页。网络函数一律收 `fetchImpl` 参数（缺省全局 fetch）——
 *   测试注入桩，**绝不真连 github.com**。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AUTH_NICKNAME_MAX, nicknameFromEmail, type AuthError, type AuthUser } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { hashPassword } from './password.js';
import { rowToAuthUser, type UserRow } from './user-row.js';

/** GitHub 身份（`GET /user` + `GET /user/emails` 的最小投影，只取登录要用的字段）。 */
export interface GithubIdentity {
  /** GitHub 数字用户 id（库内 `users.github_id` 存字符串形态）—— ★ **唯一的认人依据** */
  id: number;
  login: string;
  name: string | null;
  /**
   * 已验证邮箱；★ **仅用于展示与昵称兜底，绝不参与认人**。
   * 拿不到时（用户把邮箱设为私密）为 `null` —— 这在 2026-09-21 之后**不再算失败**。
   */
  email: string | null;
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
 * ★ scope **保留 `user:email`**：邮箱虽已不作身份依据，但**账号菜单要显示它**，而唯一来源
 *   就是 `/user/emails`（需此 scope）。⚠️ 曾计划「缩到最小」以降低授权页的吓人度，实施时
 *   发现该计划**不成立**（缩了就只能显示占位串）—— 详见契约 §2.8「scope 为什么不缩」。
 *   注意区分：「**保留 scope**」≠「**拿不到邮箱就拒绝登录**」，后者已取消。
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

/** 从 `/user/emails` 里挑**展示用**邮箱：已验证优先（primary → 任一 → 无 ⇒ null）。 */
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
  // ★ 仍优先取「已验证」邮箱，但**理由已经变了**：原先是为了保证**归并**的正确性（拿未验证
  //   邮箱归并等于把「知道某人的邮箱」升级成「能登入某人的账号」）；归并取消后这条只剩
  //   **展示**意义 —— 未验证的邮箱任何人都能往 GitHub 账号上填，**显示给用户看会误导**
  //   （他会以为那是自己的）。故优先已验证，退到 `profile.email`（用户设为公开时才有），再无则 null。
  // ★ 拿不到邮箱**不再是失败**（2026-09-21 起）：把邮箱设为私密是用户的合法选择，而我们已不靠
  //   邮箱认人 ⇒ 照常建号 / 登入，展示邮箱走 `displayEmailFor` 的 noreply 兜底。
  const email =
    pickVerifiedEmail(Array.isArray(emails) ? emails : []) ??
    (typeof profile.email === 'string' && profile.email ? profile.email : null);
  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === 'string' ? profile.name : null,
    email,
  };
}

// ★★ 行 → 契约用户的映射已抽到 `auth/user-row.ts`（本批由「两份」合成「一份」，理由见该文件头：
//    此前本文件与 `users.ts` 各写一份，只改一份 ⇒ `/api/auth/me` 会返回占位邮箱且不报错）。

/**
 * GitHub 账号在 `users.email` 列的**占位串**（契约 §2.8 数据模型 v40）。
 * ★ `.invalid` 是 RFC 2606 保留 TLD ⇒ 任何解析器都拒它、**永不可能真发信** —— 这正是要的：
 *   它**不是一个邮箱**，只是一个「占住 UNIQUE 位、好让真实邮箱可以另起一行」的内部标识。
 * ★ `github_id` 唯一 ⇒ 占位串唯一，**无需再加约束**。
 */
function placeholderEmail(githubId: number): string {
  return `gh-${githubId}@users.noreply.invalid`;
}

/**
 * 展示邮箱：拿不到真实邮箱时退到 GitHub **官方**的 noreply 地址格式。
 * ★ 为什么不能留空 / 留 NULL：`AuthUser.email` 是 `string`，留 NULL 会让映射回落成**占位串**、
 *   照样暴露给用户。★ 为什么选 noreply：① 它是 GitHub 真实存在的地址格式（不是我们编的）；
 *   ② `login` 全局唯一 ⇒ 值唯一；③ 用户一眼能读懂「这是我 GitHub 身份的地址」。
 * ★ 刻意**不做** `normalizeEmail`：这是展示值、不是身份键，尊重 GitHub 返回的原样即可。
 */
function displayEmailFor(identity: GithubIdentity): string {
  return identity.email ?? `${identity.login}@users.noreply.github.com`;
}

/**
 * GitHub 昵称：`name` → `login` → 展示邮箱派生，统一截到 `AUTH_NICKNAME_MAX`
 * （与邮箱注册同口径）。★ 不再需要「邮箱是否存在」的分支判断 —— `login` 必然存在
 * （`fetchGithubIdentity` 已把关），故 `nicknameFromEmail` 只是理论兜底。
 */
function nicknameFromIdentity(identity: GithubIdentity): string {
  const raw = (identity.name ?? '').trim() || identity.login.trim();
  if (raw) return raw.slice(0, AUTH_NICKNAME_MAX);
  return nicknameFromEmail(displayEmailFor(identity));
}

/** 按 `github_id` 查账号 —— ★★ **本文件唯一的查号入口**（新口径的落点）。 */
function findRowByGithubId(githubId: string): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as UserRow | undefined) ?? null;
}

function findRowById(id: string): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

/**
 * 把既有 GitHub 账号的**展示邮箱**对齐到「本次能拿到的最佳值」（幂等；返回新行或 null 表示无需变更）。
 * ★ 取值优先级：本次拿到的真实邮箱 → 库里已有的 → noreply 兜底。**本次没拿到就保留旧值** ——
 *   用户这次把邮箱设为私密，不该让他账号菜单里本来显示着的真实邮箱**凭空消失**。
 */
function syncGithubEmail(row: UserRow, identity: GithubIdentity): UserRow | null {
  const next = identity.email ?? row.github_email ?? displayEmailFor(identity);
  if (next === row.github_email) return null; // 无变化 ⇒ 一次多余的 UPDATE 都不发
  getDb().prepare('UPDATE users SET github_email = ? WHERE id = ?').run(next, row.id);
  return findRowById(row.id);
}

/**
 * GitHub 登录 / 建号（契约 §2.8 口径 1）。返回契约用户，路由层据此发会话。
 *
 * ★★ **两条不变量（改这里之前先读）**：
 *   ① **查号只按 `github_id`** —— 同一 GitHub 账号再次登录必须回到**同一个**账号；
 *   ② **绝不按邮箱查 / 绝不归并** —— 同邮箱也建**独立账号**（旧口径的反面）。
 *
 * ★ 「先查后插」的并发窗口由 `idx_users_github_id` 部分唯一索引兜底：两个并发的 callback
 *   带同一 `github_id` 时，第二个 INSERT 撞 UNIQUE ⇒ 回读既有行按「同账号」处理
 *   （**不能**当失败，否则用户看到一次正常登录被报错）。
 */
export async function loginViaGithub(identity: GithubIdentity): Promise<AuthUser> {
  const githubId = String(identity.id);
  const existing = findRowByGithubId(githubId);
  if (existing) {
    // 老账号：顺手对齐展示邮箱（幂等；本次没拿到就保留旧值）
    return rowToAuthUser(syncGithubEmail(existing, identity) ?? existing);
  }

  const id = `u-${randomUUID()}`;
  const nickname = nicknameFromIdentity(identity);
  const passwordHash = await hashPassword(`${randomUUID()}${randomUUID()}`);
  try {
    getDb()
      .prepare(
        'INSERT INTO users (id, email, password_hash, nickname, github_id, github_email) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, placeholderEmail(identity.id), passwordHash, nickname, githubId, displayEmailFor(identity));
  } catch (e) {
    // 并发同 github_id：部分唯一索引兜底 —— 回读既有行，按**同账号**处理（不是失败）
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      const raced = findRowByGithubId(githubId);
      if (raced) return rowToAuthUser(raced);
    }
    throw e;
  }
  // 与 createUser 同一手法：回读库行再映射（created_at 格式以库为准，内存对象不做事实源）
  const created = findRowById(id);
  if (!created) throw new Error('USER_ROW_MISSING');
  return rowToAuthUser(created);
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
