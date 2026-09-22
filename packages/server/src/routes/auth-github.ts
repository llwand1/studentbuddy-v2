/**
 * routes/auth-github — GitHub OAuth 薄路由（契约 docs/AUTH-SPEC.md §2.8）。
 *
 * 三端点，全是 GET（浏览器整页跳转，不是 fetch——OAuth 重定向流没有 XHR 版本）：
 *  · `GET /api/auth/providers`     —— 前端据此决定画不画 GitHub 按钮；
 *  · `GET /api/auth/github`        —— 发 state cookie + 302 到 GitHub 授权页；
 *  · `GET /api/auth/github/callback` —— 验 state → 换 token → 拉身份 → **按 `github_id` 查号 / 建号** → 发会话 → 302 回 `/`。
 *    ★ 2026-09-21 起口径为「**按 `github_id` 认人、绝不按邮箱归并**」（严格独立建号），
 *      本行原先写的「归并 / 建号」已不成立 —— 完整口径见 `auth/github.ts` 文件头与契约 §2.8。
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
import { deployForm } from '../auth/form.js';
import { demoLoginEnabled } from '../auth/demo.js';
import { readCookie, sessionCookieOptions, setSessionCookie } from '../auth/middleware.js';

export const githubAuthRouter = Router();

/** 域错误码 → HTTP 状态（与 routes/auth.ts 的 ERROR_STATUS 同一套口径，GitHub 专属四个）。 */
const ERROR_STATUS: Partial<Record<AuthError, number>> = {
  GITHUB_NOT_CONFIGURED: 503,
  GITHUB_AUTH_FAILED: 502,
  GITHUB_STATE_INVALID: 400,
  GITHUB_EMAIL_UNAVAILABLE: 502,
};

/**
 * 域错误码 → 错误页文案（ADR-5：说清发生了什么 + 用户下一步能做什么）。
 * ★ 2026-09-21（独立建号批）口径变更带来的两处调整：
 *   · `GITHUB_AUTH_FAILED` —— 原含「`github_id` 已绑定其他邮箱」的**撞号分支，该分支已删除**
 *     （按 `github_id` 认人后不存在撞号场景）⇒ 文案收敛为纯「重试 / 改邮箱登录」。
 *   · `GITHUB_EMAIL_UNAVAILABLE` —— ⚠️ **已退化为例外兜底**：邮箱不再作身份依据，拿不到邮箱
 *     **照常建号 / 登入** ⇒ 这条文案**正常路径下不会再出现**，仅防御 GitHub 返回畸形响应。
 *     ★ 因此文案里原先那句「请先在 GitHub 上验证邮箱后重试」**必须删掉** —— 那是**旧口径的处方**，
 *     照它做解决不了任何问题（用户的邮箱本来就是验证过的，问题在别处）。
 */
const ERROR_TEXT: Partial<Record<AuthError, string>> = {
  GITHUB_NOT_CONFIGURED: 'GitHub 登录尚未配置，请改用邮箱注册或登录',
  GITHUB_AUTH_FAILED: 'GitHub 登录没能完成，请重试；多次失败请改用邮箱登录',
  GITHUB_STATE_INVALID: '登录会话已失效，请回到首页重新点击 GitHub 登录',
  GITHUB_EMAIL_UNAVAILABLE: 'GitHub 未能返回账号信息，请重试；多次失败请改用邮箱登录',
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

/**
 * 登录面信息（契约 §2.8/§2.9）：GitHub 可用性 + **部署形态**——前端启动分叉的唯一依据
 * （`local` 本地单人形态免登录直进应用壳；`cloud` 线上形态走落地页）。
 * ★ 端点职责从「GitHub 探针」扩为「auth 面信息」，路径不变——前端已按它发探针，扩字段零迁移。
 */
githubAuthRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: { github: githubConfigured(), demo: demoLoginEnabled() }, form: deployForm() });
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
