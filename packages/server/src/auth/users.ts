/**
 * auth/users — 账号域逻辑（注册 / 查询 / 认证；契约 docs/AUTH-SPEC.md §1 `users` / §2）。
 *
 * 域层**不碰 HTTP**：校验失败抛 `AuthError` 码，由薄路由映射状态码（同 `PkRoomError` 手法）。
 * ★ 校验一律复用 `@sb/shared` 的纯函数（`normalizeEmail` / `passwordProblem` / `normalizeAuthNickname`）
 *   ——前端「提交前先拦」与服务端在此再次拦，**同一份代码**，不可能漂成「表单放行、服务端拒绝」。
 */
import { randomUUID } from 'node:crypto';
import {
  nicknameFromEmail,
  normalizeAuthNickname,
  normalizeEmail,
  passwordProblem,
  type AuthUser,
  type AuthError,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { hashPassword, verifyPassword } from './password.js';
// ★★ 行 → 契约用户的映射**只有一份**（`auth/user-row.ts`）。本批的教训：此前本文件与
//    `github.ts` **各写了一份** `toAuthUser`，只改了 github 那份 ⇒ `/api/auth/me` 直接把
//    GitHub 账号的**占位邮箱** `gh-<id>@users.noreply.invalid` 返回给用户，而且
//    **没有任何编译错误提示**（`row.email` 仍是 `string`，类型完全合法）。是测试逮到的。
import { rowToAuthUser, type UserRow } from './user-row.js';

function findByEmailRow(email: string): UserRow | null {
  return (getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined) ?? null;
}

/** 按 id 查账号（`/api/auth/me` 用）；不存在 → null。 */
export function findUserById(id: string): AuthUser | null {
  const row = getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? rowToAuthUser(row) : null;
}

/**
 * 按**归一化邮箱**查账号（M1.5 验证码登录用）；不存在 → null。
 * ★ 入参必须已经是 `normalizeEmail` 的结果——本函数**不重复归一化**，
 *   否则调用方传 `Alice@Example.com` 会静默查不到（这类"看起来能查到却查不到"最难查）。
 *   它同时是 `send-code` 判断"该不该发信"的唯一依据，故只有一处、只有一个口径。
 */
export function findUserByEmail(email: string): AuthUser | null {
  const row = findByEmailRow(email);
  return row ? rowToAuthUser(row) : null;
}

/**
 * 注册：建号并返回契约用户（**不含 hash**）。
 * 抛出 `EMAIL_INVALID` / `PASSWORD_WEAK` / `NICKNAME_INVALID` / `EMAIL_TAKEN`。
 */
export async function createUser(rawEmail: unknown, rawPassword: unknown, rawNickname: unknown): Promise<AuthUser> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('EMAIL_INVALID' satisfies AuthError);
  const pwProblem = passwordProblem(rawPassword);
  if (pwProblem) throw new Error(pwProblem);
  const nickname = normalizeAuthNickname(rawNickname);
  if (nickname === null) throw new Error('NICKNAME_INVALID' satisfies AuthError);
  // 先查一次给出友好码；下面的 catch 再兜住并发写入撞 UNIQUE 的竞态
  if (findByEmailRow(email)) throw new Error('EMAIL_TAKEN' satisfies AuthError);

  const id = `u-${randomUUID()}`;
  const passwordHash = await hashPassword(rawPassword as string);
  const finalNickname = nickname || nicknameFromEmail(email);
  try {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, nickname) VALUES (?, ?, ?, ?)`)
      .run(id, email, passwordHash, finalNickname);
  } catch (e) {
    // 并发注册同邮箱：UNIQUE(email) 是库层兜底，把约束错误翻译回同一个域码
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new Error('EMAIL_TAKEN' satisfies AuthError);
    throw e;
  }
  // ★ 建号后**回读入库行**再映射，而不是拿内存里的对象拼。否则 register 的 `createdAt` 会是
  //   `new Date().toISOString()`（`2026-09-17T13:09:21.353Z`），而 `/me` 走库读是
  //   `datetime('now')`（`2026-09-17 13:09:21`）——**同一个账号在两个端点长得不一样**
  //   （本批路由测试实测踩到，`toEqual(reg.body.user)` 当场红）。**库行是唯一事实源**，
  //   内存值只配用来做「写什么」，不配用来做「返回什么」。
  const created = findByEmailRow(email);
  if (!created) throw new Error('USER_ROW_MISSING'); // 理论不可达；非域码 ⇒ 走 500，不伪装成业务错误
  return rowToAuthUser(created);
}

/**
 * 时序均衡用的一次性哈希：**邮箱不存在时也跑一次同等代价的 scrypt**，
 * 否则「查无此人立刻返回」比「密码错」快上百毫秒，攻击者可据此**枚举出哪些邮箱已注册**
 * （与 `CREDENTIALS_INVALID` 合并错误码是同一目的的两条防线）。懒算一次并缓存。
 */
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword('sb-timing-equalizer');
  return dummyHash;
}

/**
 * 认证：邮箱 + 密码。成功返回契约用户；失败一律抛 `CREDENTIALS_INVALID`
 * （**邮箱不存在与密码错合成一个码**，不向调用方透露账号是否存在）。
 */
export async function authenticate(rawEmail: unknown, rawPassword: unknown): Promise<AuthUser> {
  const email = normalizeEmail(rawEmail);
  // 邮箱格式非法也走同一条失败路径（不单独报 EMAIL_INVALID，避免成为「格式探针」）
  if (!email || typeof rawPassword !== 'string') {
    await verifyPassword(String(rawPassword ?? ''), await getDummyHash());
    throw new Error('CREDENTIALS_INVALID' satisfies AuthError);
  }
  const row = findByEmailRow(email);
  if (!row) {
    await verifyPassword(rawPassword, await getDummyHash()); // 均衡时序后再报错
    throw new Error('CREDENTIALS_INVALID' satisfies AuthError);
  }
  const ok = await verifyPassword(rawPassword, row.password_hash);
  if (!ok) throw new Error('CREDENTIALS_INVALID' satisfies AuthError);
  return rowToAuthUser(row);
}

/** 清空时序均衡缓存（**仅测试用**：隔离库之间切换时避免持有上一个实例的口令）。 */
export function resetAuthCaches(): void {
  dummyHash = null;
}
