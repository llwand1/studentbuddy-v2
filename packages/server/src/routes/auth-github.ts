/**
 * routes/auth-github — GitHub OAuth 薄路由（契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 三端点，全是 GET（浏览器整页跳转，不是 fetch——OAuth 重定向流没有 XHR 版本）：
 *  · `GET /api/auth/providers`     —— 前端据此决定画不画 GitHub 按钮；
 *  · `GET /api/auth/github`        —— 发 state cookie + 302 到 GitHub 授权页；
 *  · `GET /api/auth/github/callback` —— 验 state → 换 token → 拉身份 → 归并/建号 → 发会话 → 302 回 `/`。
 *
 * ★ 失败呈现走**内联 HTML 错误页**而不是 JSON：此刻用户在浏览器导航里，fetch 错误
 *   形状没人能看见（ADR-5：失败必须可读、可重试——错误页必带「返回首页」链接）。
 * ★ 两个 GET 不经 originCheck 的写闸门（只校验写操作）；callback 的 CSRF 防线是
 *   state cookie 逐字节比对（`verifyState`），不依赖 Origin 头——GitHub 302 回来的
 *   请求本来就不带我们站内的 Origin。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AUTH_GITHUB_STATE_COOKIE, AUTH_GITHUB_STATE_TTL_MS, type AuthError } from '@sb/shared';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchGithubIdentity,
  githubConfigured,
  loginViaGithub,
  verifyState,
} from '../auth/github.js';
import { createSession } from '../auth/session.js';
import { readCookie, sessionCookieOptions, setSessionCookie } from '../auth/middleware.js';

export const githubAuthRouter = Router();

/** 域错误码 → HTTP 状态（与 routes/auth.ts 的 ERROR_STATUS 同一套口径，GitHub 专属四个）。 */
const ERROR_STATUS: Partial<Record<AuthError, number>> = {
  GITHUB_NOT_CONFIGURED: 503,
  GITHUB_AUTH_FAILED: 502,
  GITHUB_STATE_INVALID: 400,
  GITHUB_EMAIL_UNAVAILABLE: 502,
};

/** 域错误码 → 错误页文案（ADR-5：说清发生了什么 + 用户下一步能做什么）。 */
const ERROR_TEXT: Partial<Record<AuthError, string>> = {
  GITHUB_NOT_CONFIGURED: 'GitHub 登录尚未配置，请改用邮箱注册或登录',
  GITHUB_AUTH_FAILED: 'GitHub 登录没能完成，请重试；多次失败请改用邮箱登录',
  GITHUB_STATE_INVALID: '登录会话已失效，请回到首页重新点击 GitHub 登录',
  GITHUB_EMAIL_UNAVAILABLE: 'GitHub 账号没有已验证的邮箱，无法建立登录——请先在 GitHub 上验证邮箱后重试，或改用邮箱登录',
};

/** OAuth 握手失败页（最小 HTML：无脚本无样式，内容只有结论 + 出路）。 */
function sendOauthError(res: Response, code: AuthError): void {
  const status = ERROR_STATUS[code] ?? 502;
  const text = ERROR_TEXT[code] ?? 'GitHub 登录失败';
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
        `<title>GitHub 登录失败</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>GitHub 登录失败</h1><p>${text}</p><p><a href="/">返回首页</a></p></body></html>`,
    );
}

/**
 * 站点根 URL：`SB_PUBLIC_ORIGIN` 优先（反代后 `req.protocol`/`host` 可能失真，
 * 显式配置是唯一可靠的口径）；未配则从请求推导（本地开发 localhost 即正确）。
 * ★ 授权与回调两步**必须**用同一来源派生 redirect_uri，否则 GitHub 直接拒（mismatch）。
 */
function baseUrl(req: Request): string {
  const configured = (process.env.SB_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? ''}`;
}

function queryStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** 登录方式可用性。按钮画不画由前端决定，服务端只报事实。 */
githubAuthRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: { github: githubConfigured() } });
});

/** 发 state + 跳 GitHub 授权页。 */
githubAuthRouter.get('/github', (req: Request, res: Response) => {
  if (!githubConfigured()) {
    sendOauthError(res, 'GITHUB_NOT_CONFIGURED');
    return;
  }
  const state = randomUUID();
  // state cookie 属性与会话 cookie 同一套（httpOnly/lax/secure 开关），只是寿命 10 分钟；
  // callback 里先验后清，属性一致浏览器才会真的执行清除。
  res.cookie(AUTH_GITHUB_STATE_COOKIE, state, {
    ...sessionCookieOptions(),
    maxAge: AUTH_GITHUB_STATE_TTL_MS,
  });
  res.redirect(302, buildAuthorizeUrl(state, `${baseUrl(req)}/api/auth/github/callback`));
});

/** 授权回调：验 state → 换 token → 拉身份 → 归并/建号 → 发会话 → 回首页。 */
githubAuthRouter.get('/github/callback', (req: Request, res: Response) => {
  // 先清 state cookie：无论成败它都已完成使命，留着只会让「重试」撞上过期脏值
  res.clearCookie(AUTH_GITHUB_STATE_COOKIE, sessionCookieOptions());
  const expected = readCookie(req.headers.cookie, AUTH_GITHUB_STATE_COOKIE);
  const state = queryStr(req.query.state);
  if (!expected || !verifyState(state, expected)) {
    sendOauthError(res, 'GITHUB_STATE_INVALID');
    return;
  }
  const code = queryStr(req.query.code);
  const redirectUri = `${baseUrl(req)}/api/auth/github/callback`;
  void (async () => {
    if (!code) throw new Error('GITHUB_AUTH_FAILED' satisfies AuthError);
    const accessToken = await exchangeCode(code, redirectUri);
    const identity = await fetchGithubIdentity(accessToken);
    const user = await loginViaGithub(identity);
    const { token, expiresAt } = createSession(user.id);
    setSessionCookie(res, token, expiresAt);
    res.redirect(302, '/');
  })().catch((e: unknown) => {
    const code2 = e instanceof Error ? (e.message as AuthError) : undefined;
    if (code2 !== undefined && code2 in ERROR_STATUS) {
      sendOauthError(res, code2);
      return;
    }
    sendOauthError(res, 'GITHUB_AUTH_FAILED');
  });
});
