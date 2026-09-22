/**
 * routes/auth — 账号薄路由（契约 docs/AUTH-SPEC.md §2）。
 *
 * 六端点：register / login / logout / me + send-code / login-by-code（M1.5）
 * + demo-login（公用体验账号，§2.10，`SB_DEMO_LOGIN=1` 才存在）。
 * 路由只做三件事：参数校验、调域层、把域层错误码映射成 HTTP——业务规则一律不在这一层
 * （与 `routes/pk.ts` 同构）。
 *
 * ★ 2026-09-18（M1.6）：`register` 的入参**新增必填 `code`**（「注册即验证」，§2.7）。
 *   ⚠️ 这是**破坏性变更**：旧的无码注册路径已消失。留着它 = 一条**绕过邮箱验证的后门**，
 *   不是兼容性。前端漏改的症状是 `400 CODE_INVALID`（清晰可查），不是静默降级。
 *
 * ⚠️ 写端点（register/login/logout/send-code/login-by-code）受 `security.ts` 的 `originCheck`
 * 管辖：**必须带合法 Origin**，否则 403（这不是参数错误）。真机 curl 冒烟要加 `-H 'origin: ...'`。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { normalizeEmail, type AuthError } from '@sb/shared';
import { authenticate } from '../auth/users.js';
import { createSession, deleteSession } from '../auth/session.js';
import { clearSessionCookie, readSessionToken, resolveUser, setSessionCookie } from '../auth/middleware.js';
import { clearFailures, isLocked, recordFailure } from '../auth/rate-limit.js';
import { CodeRateLimitedError, loginByCode, registerByCode, sendCode } from '../auth/code-flow.js';
import { demoLogin, demoLoginEnabled } from '../auth/demo.js';

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
  PURPOSE_INVALID: 400,
  CODE_RATE_LIMITED: 429,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  MAIL_SEND_FAILED: 502,
  // GitHub OAuth（§2.8）：四个码只经 routes/auth-github.ts 的错误页出口，这里登记
  // 是为 AuthError 联合类型的穷尽性——Record<AuthError, …> 两张表编译期强制全覆盖
  GITHUB_NOT_CONFIGURED: 503,
  GITHUB_AUTH_FAILED: 502,
  GITHUB_STATE_INVALID: 400,
  GITHUB_EMAIL_UNAVAILABLE: 502,
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
  PURPOSE_INVALID: '验证码用途不正确',
  // ★ 文案刻意**不说"已发过"**：说了就等于确认该邮箱正在被刷（契约 §4.5）
  CODE_RATE_LIMITED: '发送太频繁了，请稍后再试',
  // ★ 与 CODE_EXPIRED 分开：用户的**动作不同**（重输 vs 重新发送），文案必须能指路
  CODE_INVALID: '验证码不正确，请检查后重试',
  CODE_EXPIRED: '验证码已过期，请重新获取',
  // ★ 不写"请稍后重试"以外的话：发信通道故障是服务端的事，用户能做的只有重试或改用密码
  MAIL_SEND_FAILED: '验证码邮件没能发出去，请稍后重试，或改用密码登录',
  // GitHub OAuth（§2.8）：JSON 通道不会走到这四个文案（错误页在 auth-github.ts），登记同上
  GITHUB_NOT_CONFIGURED: 'GitHub 登录尚未配置',
  GITHUB_AUTH_FAILED: 'GitHub 登录没能完成，请重试',
  GITHUB_STATE_INVALID: '登录会话已失效，请重新发起 GitHub 登录',
  GITHUB_EMAIL_UNAVAILABLE: 'GitHub 账号没有已验证的邮箱，无法建立登录',
};

/**
 * 客户端 IP（`send-code` 的第三道限流用）。
 *
 * ★ **用 `req.ip`（socket 对端），不读 `X-Forwarded-For`**：后者是请求头、可任意伪造，
 *   按伪造头限流等于没限流（同 `auth/rate-limit.ts` 按邮箱而非 IP 计数的取向）。
 * ⚠️ **反代后的连带后果（部署前必读）**：未配 `app.set('trust proxy', …)` 时 `req.ip`
 *   恒为**反代自身地址** ⇒ 全站共用一个 IP 桶 ⇒ `AUTH_CODE_MAX_PER_IP_HOUR`(20)
 *   **静默退化成"全站每小时 20 封"**，100 个用户抢 20 个名额，其余全部 429。
 *   ⇒ 代码侧已由 M2 收口把 `SB_TRUST_PROXY` 接进 `index.ts`（`app.set('trust proxy', …)`）；
 *   M3 部署清单还差配套的一半：Caddy 必须真的下发 `X-Forwarded-For`，且**生产必须配 `SB_TRUST_PROXY=1`**
 *   （不配则本注释描述的退化依旧发生——代码给开关，部署给配置，两者缺一不可）。
 */
function clientIp(req: Request): string {
  return req.ip ?? '';
}


function fail(res: Response, code: AuthError): void {
  res.status(ERROR_STATUS[code]).json({ error: ERROR_TEXT[code], code });
}

/**
 * 429 `CODE_RATE_LIMITED` 专用出口：多带 `retryAfterMs`（契约 §2.5 / §4.5）。
 *
 * ★ 单列一个函数、不给 `fail` 加可选参数：**全仓只有这一个错误码带 payload**，
 *   可选参数会让"顺手给 `EMAIL_TAKEN` 也传一个"变成编译期合法的事。
 * ★ 状态码与文案仍从上面两张表取（不写字面量）——映射只此一处的规矩不能因为
 *   多了一个字段就破掉。
 */
function failRateLimited(res: Response, retryAfterMs: number): void {
  res.status(ERROR_STATUS.CODE_RATE_LIMITED).json({
    error: ERROR_TEXT.CODE_RATE_LIMITED,
    code: 'CODE_RATE_LIMITED',
    retryAfterMs,
  });
}

/** 域层错误 → HTTP；非域错误一律 500（不把内部异常当业务错误外泄）。 */
function failFrom(res: Response, e: unknown): void {
  // ★ 先认类型再认 `message`：`retryAfterMs` 是结构化字段，只能从类上取（见 `CodeRateLimitedError`）
  if (e instanceof CodeRateLimitedError) {
    failRateLimited(res, e.retryAfterMs);
    return;
  }
  const code = e instanceof Error ? (e.message as AuthError) : undefined;
  if (code === undefined || !(code in ERROR_STATUS)) {
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
  fail(res, code);
}

/**
 * 注册（**注册即验证**，契约 §2.7，M1.6）：核销 `register` 验证码 → 建号 → 直接登录。
 *
 * ★ `code` 是**必填**：没有它这条路就是「任何人用任意邮箱凭空建号」。
 *   校验失败回 `CODE_INVALID` / `CODE_EXPIRED`（不是 400 参数缺失——域层统一给这两个码）。
 * ★ 建号后复用与密码登录**完全相同**的会话下发（`createSession` + `setSessionCookie`）——
 *   注册与登录产出同一种会话，故后续归属逻辑（TENANCY-SPEC）无需分支。
 */
authRouter.post('/register', (req: Request, res: Response) => {
  const { email, code, password, nickname } = req.body as {
    email?: unknown;
    code?: unknown;
    password?: unknown;
    nickname?: unknown;
  };
  void registerByCode(email, code, password, nickname)
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

/**
 * 发验证码（契约 §2.5，M1.5）。
 * ★ 响应**不带任何"邮箱是否存在"的信息**——两种情况的响应体逐字相同，详见 `auth/code-flow.ts` 头注。
 * ★ 返回 `expiresInMs` 而不是绝对时刻：绝对时刻依赖客户端时钟，而用户机器的时间不一定准。
 * ★ 被限流时 429 带 `retryAfterMs`（契约 §2.5，毫秒）——被拒的那一刻用户唯一有用的信息
 *   是"还要等多久"；没有它前端只能显示"请稍后再试"，而 429 **不记账**、服务端也没痕迹可查。
 */
authRouter.post('/send-code', (req: Request, res: Response) => {
  const { email, purpose } = req.body as { email?: unknown; purpose?: unknown };
  void sendCode(email, purpose, clientIp(req))
    .then((r) => res.json({ ok: true, expiresInMs: r.expiresInMs }))
    .catch((e: unknown) => failFrom(res, e));
});

/**
 * 验证码登录（契约 §2.5，M1.5）。
 * ★ **产出与密码登录完全相同的会话**（同一个 `createSession` + 同一个 cookie）——
 *   只是换了「证明你是这个邮箱的主人」的方式，故后续所有归属逻辑（TENANCY-SPEC）无需分支。
 */
authRouter.post('/login-by-code', (req: Request, res: Response) => {
  const { email, code } = req.body as { email?: unknown; code?: unknown };
  try {
    const user = loginByCode(email, code);
    const { token, expiresAt } = createSession(user.id);
    setSessionCookie(res, token, expiresAt);
    res.json({ user });
  } catch (e: unknown) {
    failFrom(res, e);
  }
});

/**
 * 公用体验账号登录（契约 §2.10）：**零凭证**，开关未开一律 404（不是 403——
 * 未配置的端点对外应等同于不存在，不给探测者「差一步就能进」的信号）。
 * ★ 会话下发与密码登录逐字同构（同一 `createSession` + 同一 cookie），体验账号在
 *   数据模型上不是特殊态；滥用防线是 `clientIp` 桶限流（429 复用 TOO_MANY_ATTEMPTS 文案）。
 * ⚠️ 与其它写端点一样受 originCheck 管辖：跨源无 Origin 的调用先吃 403。
 */
authRouter.post('/demo-login', (req: Request, res: Response) => {
  if (!demoLoginEnabled()) {
    res.status(404).json({ error: '体验模式未开放', code: 'DEMO_DISABLED' });
    return;
  }
  void demoLogin(clientIp(req))
    .then((user) => {
      const { token, expiresAt } = createSession(user.id);
      setSessionCookie(res, token, expiresAt);
      res.json({ user });
    })
    .catch((e: unknown) => failFrom(res, e));
});

