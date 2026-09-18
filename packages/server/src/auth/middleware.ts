/**
 * auth/middleware — 会话解析、鉴权中间件与 cookie 读写（契约 docs/AUTH-SPEC.md §3 / §4.2）。
 *
 * ★ 不引 `cookie-parser`：全站只读一个键，`readCookie` 十行就够（ADR-2 简洁优先）。
 * ★ cookie 属性在这里集中定义，路由只调 `setSessionCookie` / `clearSessionCookie`——
 *   散落各处的 `res.cookie(...)` 迟早会漏掉 `httpOnly` 或 `sameSite`。
 */
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { AUTH_COOKIE_NAME, type AuthUser } from '@sb/shared';
import { verifySession } from './session.js';
import { findUserById } from './users.js';

/** 已挂载登录用户的请求。**不用全局类型声明**（那会污染整个 Express 命名空间），按需断言即可。 */
export interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

/** 极简 Cookie 头解析：返回指定键的**已解码**值，找不到回 null。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null; // 畸形百分号编码不该让整条请求 500
      }
    }
  }
  return null;
}

/**
 * 取会话 token：**cookie 优先**，其次 `Authorization: Bearer`。
 * 后者是给真机冒烟/脚本用的（curl 不便带 cookie），生产前端只用 cookie。
 */
export function readSessionToken(req: Request): string | null {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    const token = bearer.slice(7).trim();
    if (token) return token;
  }
  return readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
}

/** 解析当前登录用户；无有效会话 → `null`（不抛错，调用方决定是否要求登录）。 */
export function resolveUser(req: Request): AuthUser | null {
  const token = readSessionToken(req);
  if (!token) return null;
  const userId = verifySession(token);
  if (!userId) return null;
  return findUserById(userId);
}

/** cookie 属性。`Secure` 由 `SB_COOKIE_SECURE='1'` 打开（生产 HTTPS 必须开；本地 http 开了 cookie 不落）。 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true, // JS 读不到 ⇒ 防 XSS 窃取会话
    sameSite: 'lax', // 跨站 POST 不带 cookie；配合 originCheck 形成 CSRF 双保险
    path: '/',
    secure: process.env.SB_COOKIE_SECURE === '1',
  };
}

/** 下发会话 cookie（`maxAge` 与 `expiresAt` 对齐，过期由服务端 `expires_at` 兜底）。 */
export function setSessionCookie(res: Response, token: string, expiresAt: number): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...sessionCookieOptions(),
    maxAge: Math.max(0, expiresAt - Date.now()),
  });
}

/** 清除会话 cookie（登出）。属性必须与下发时一致，否则浏览器不认这条清 cookie 指令。 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, sessionCookieOptions());
}

/**
 * **软解析**中间件：有有效会话就挂 `req.authUser`，**永不 401**（强制由 `requireAuth` 负责）。
 *
 * ★ 为什么必须无条件挂载（M2 的关键一层）：数据隔离靠 `ownerIdOf(req)` 读 `req.authUser`，
 *   而 `ownerIdOf` 在**鉴权强制开关关闭时也要工作**——否则「登录了但开关没开」的请求
 *   owner 恒为 null ⇒ 过滤条件被整体跳过 ⇒ **隔离形同虚设**。
 *   即：**「解析身份」与「强制登录」必须是两件独立的事**，前者永远开，后者按部署形态开。
 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const user = resolveUser(req);
  if (user) (req as AuthedRequest).authUser = user;
  next();
}

/**
 * 强制鉴权中间件：无有效会话 → `401 UNAUTHENTICATED`，否则把用户挂到 `req.authUser`。
 * ★ 由 `index.ts` 按 `SB_REQUIRE_AUTH` 决定是否全量启用（默认关，等 M2 数据隔离一起开，见 SPEC §0）。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = resolveUser(req);
  if (!user) {
    res.status(401).json({ error: '未登录或登录已过期，请重新登录', code: 'UNAUTHENTICATED' });
    return;
  }
  (req as AuthedRequest).authUser = user;
  next();
}
