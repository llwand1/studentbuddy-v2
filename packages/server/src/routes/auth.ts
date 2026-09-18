/**
 * routes/auth — 账号薄路由（契约 docs/AUTH-SPEC.md §2）。
 *
 * 四端点：register / login / logout / me。路由只做三件事：参数校验、调域层、
 * 把域层错误码映射成 HTTP——业务规则一律不在这一层（与 `routes/pk.ts` 同构）。
 *
 * ⚠️ 写端点（register/login/logout）受 `security.ts` 的 `originCheck` 管辖：
 *   **必须带合法 Origin**，否则 403（这不是参数错误）。真机 curl 冒烟要加 `-H 'origin: ...'`。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { normalizeEmail, type AuthError } from '@sb/shared';
import { authenticate, createUser } from '../auth/users.js';
import { createSession, deleteSession } from '../auth/session.js';
import { clearSessionCookie, readSessionToken, resolveUser, setSessionCookie } from '../auth/middleware.js';
import { clearFailures, isLocked, recordFailure } from '../auth/rate-limit.js';

export const authRouter = Router();

/** 域错误码 → HTTP 状态（映射只此一处；域层不碰 HTTP）。 */
const ERROR_STATUS: Record<AuthError, number> = {
  EMAIL_INVALID: 400,
  EMAIL_TAKEN: 409,
  PASSWORD_WEAK: 400,
  NICKNAME_INVALID: 400,
  CREDENTIALS_INVALID: 401,
  TOO_MANY_ATTEMPTS: 429,
  UNAUTHENTICATED: 401,
};

/** 域错误码 → 人话文案（ADR-5：失败必须可读、可重试，不裸抛码）。 */
const ERROR_TEXT: Record<AuthError, string> = {
  EMAIL_INVALID: '邮箱格式不正确',
  EMAIL_TAKEN: '这个邮箱已经注册过了，直接登录试试',
  PASSWORD_WEAK: '密码长度需在 8~100 位之间',
  NICKNAME_INVALID: '昵称不能为空，且不超过 20 字',
  CREDENTIALS_INVALID: '邮箱或密码不正确',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请 15 分钟后再试',
  UNAUTHENTICATED: '未登录或登录已过期，请重新登录',
};

function fail(res: Response, code: AuthError): void {
  res.status(ERROR_STATUS[code]).json({ error: ERROR_TEXT[code], code });
}

/** 域层错误 → HTTP；非域错误一律 500（不把内部异常当业务错误外泄）。 */
function failFrom(res: Response, e: unknown): void {
  const code = e instanceof Error ? (e.message as AuthError) : undefined;
  if (code === undefined || !(code in ERROR_STATUS)) {
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
  fail(res, code);
}

/** 注册：建号 + 直接登录（下发会话 cookie）。 */
authRouter.post('/register', (req: Request, res: Response) => {
  const { email, password, nickname } = req.body as { email?: unknown; password?: unknown; nickname?: unknown };
  void createUser(email, password, nickname)
    .then((user) => {
      const { token, expiresAt } = createSession(user.id);
      setSessionCookie(res, token, expiresAt);
      res.json({ user });
    })
    .catch((e: unknown) => failFrom(res, e));
});

/** 登录：失败限流（按归一化邮箱计数），成功即清零。 */
authRouter.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };
  const key = normalizeEmail(email) ?? '';
  if (key && isLocked(key)) {
    fail(res, 'TOO_MANY_ATTEMPTS');
    return;
  }
  void authenticate(email, password)
    .then((user) => {
      if (key) clearFailures(key);
      const { token, expiresAt } = createSession(user.id);
      setSessionCookie(res, token, expiresAt);
      res.json({ user });
    })
    .catch((e: unknown) => {
      if (key) recordFailure(key); // 仅失败时计数；成功已在上面清零
      failFrom(res, e);
    });
});

/** 登出：撤除会话 + 清 cookie。**幂等**——未登录调用也回 200。 */
authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(readSessionToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** 当前用户：读 cookie。未登录 → 401。 */
authRouter.get('/me', (req: Request, res: Response) => {
  const user = resolveUser(req);
  if (!user) {
    fail(res, 'UNAUTHENTICATED');
    return;
  }
  res.json({ user });
});
