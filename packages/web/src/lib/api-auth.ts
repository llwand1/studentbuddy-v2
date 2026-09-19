/**
 * api-auth — 账号分组（契约 docs/AUTH-SPEC.md §2 / §2.5 / §2.7）。
 *
 * ★ 为什么单列一个文件（同 `api-terms-domain.ts` / `api-study-flow.ts` 的处置）：
 *   `api.ts` 有 400 行红线，而账号这一组是**唯一被 M1.6 同时改了签名与新增了两个方法**的组
 *   （`register` 加必填 `code`、新增 `sendCode` / `loginByCode`）⇒ 抽出来既让红线复位，
 *   也让「注册即验证」这条破坏性变更的落点集中在一处可读的文件里。
 *
 * ★ 会话是 **httpOnly cookie**，JS 读不到 ⇒ 前端**不存 token**，也没有"记住登录态"这回事——
 *   登录态的唯一真相源是 `me()`。刷新页面后是否还登录，问服务端，不靠本地缓存猜。
 */
import type { AuthSurface, AuthUser } from '@sb/shared';
import { request } from './api-request.js';

export const authApi = {
  me: () => request<AuthUser>('/api/auth/me'),
  /**
   * 登录面信息（契约 §2.8/§2.9）：GitHub 可用性 + 部署形态（local/cloud）。
   * ★ `me()` 401 之后问它——本地单人形态据此**免登录直进应用壳**；这是启动分叉的唯一询问点。
   */
  surface: () => request<AuthSurface>('/api/auth/providers'),
  /**
   * 注册（契约 §2.7「注册即验证」）：**`code` 必填**。
   * ★ 旧的无码注册签名已删——后端不再接受它，留着这个重载只会把破坏性变更藏起来。
   */
  register: (email: string, code: string, password: string, nickname?: string) =>
    request<AuthUser>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, code, password, ...(nickname ? { nickname } : {}) }),
    }),
  login: (email: string, password: string) =>
    request<AuthUser>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  /**
   * 发验证码（契约 §2.5 / §2.5.1）。`purpose` 决定**响应策略**：
   * `login` 对注册与否一律回同一个 200（不泄露账号是否存在）；`register` 对已注册回 409。
   * ★ 返回 `expiresInMs` 而不是绝对时刻——绝对时刻依赖客户端时钟，用户机器时间不一定准。
   */
  sendCode: (email: string, purpose: 'login' | 'register' | 'reset') =>
    request<{ ok: true; expiresInMs: number }>('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email, purpose }),
    }),
  /** 验证码登录（契约 §2.5）：与密码登录产出同一种会话，不是第二套账号体系。 */
  loginByCode: (email: string, code: string) =>
    request<AuthUser>('/api/auth/login-by-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
};
