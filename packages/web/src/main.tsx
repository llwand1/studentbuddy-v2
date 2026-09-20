/**
 * 应用入口。顶层 hash 路由（零依赖，不引 react-router——@sb/web 保持零运行时依赖）：
 * `#/pk` 进 AI 出题 PK 独立页（移动优先，契约 docs/PK-SPEC.md §5），其余进学习助手主壳。
 *
 * ★ 2026-09-19 上线批加**落地页分层**（老板反馈：产品不该直接怼进应用，要先有介绍再「开始使用」）：
 *   启动先问 `/api/auth/me`（与 AccountBox 同一事实源——登录态不自持，httpOnly cookie 前端读不到，
 *   只能问服务端）⇒ 已登录直接进 `App`，未登录进 `app/Landing.tsx`，登录成功回调换根。
 *   `user === undefined` 是「查询中」：此刻渲染 null（~一次请求的空窗，不闪落地页再跳应用）。
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { entryFor } from './app/entry';
import { Landing } from './app/Landing';
import { PkApp } from './features/pk/PkApp';
import { api } from './lib/api';
import { sanitizeReturnTo } from './features/pk/pk-view';
import type { AuthUser, DeployForm } from '@sb/shared';
import './styles/tokens.css';

/** §14.3 returnTo 的 sessionStorage 键（与 PkApp 的 goLogin 约定同一处） */
const RETURN_TO_KEY = 'sb_return_to';

/** GoatCounter 统计脚本（index.html 注入）的最低类型面；SPA 路由切换时手动补计数 */
declare global {
  interface Window {
    goatcounter?: { count?: (opt?: { path?: string }) => void };
  }
}

/**
 * §14.2：`#/pk`、`#/pk/…`、**`#/pk?code=…`（邀请链接）** 都进 PK 页。
 * ★ `?code=` 属于 hash 片段，`h.startsWith('#/pk/')` 罩不住它——漏掉这条，
 *   邀请链接会落进主壳路由（等于链接作废），契约 §14.2 明钉的坑。
 */
function isPkHash(): boolean {
  const h = window.location.hash;
  return h === '#/pk' || h.startsWith('#/pk/') || h.startsWith('#/pk?');
}

function Root() {
  const [pk, setPk] = useState(() => isPkHash());
  /** undefined = /api/auth/me 查询中；null = 未登录；非空 = 已登录 */
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  /** 部署形态（契约 AUTH-SPEC §2.9）：local 免登录直进应用壳，cloud 走落地页。缺省按线上口径兜底 */
  const [form, setForm] = useState<DeployForm>('cloud');
  useEffect(() => {
    const on = () => setPk(isPkHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    api.auth
      .me()
      .then((u) => setUser(u))
      .catch(() => {
        // 401 = 未登录（正常状态）：再问部署形态——本地单人形态**免登录直接进应用壳**
        //（2026-09-20 拍板，契约 AUTH-SPEC §2.9）；线上形态走落地页。
        api.auth
          .surface()
          .then((s) => {
            setForm(s.form);
            setUser(null);
          })
          .catch(() => {
            setForm('cloud'); // 形态也问不到（服务没起/网络断）：按线上口径兜底，不悄悄放开
            setUser(null);
          });
      });
  }, []);
  // SPA 路由计数：hash 变化不会触发整页加载，GoatCounter 的自动计数覆盖不到，手动补一针
  useEffect(() => {
    const count = () => window.goatcounter?.count?.({ path: location.pathname + location.hash });
    window.addEventListener('hashchange', count);
    return () => window.removeEventListener('hashchange', count);
  }, []);
  /**
   * §14.3 登录后跳回：PK 大厅「去登录」前会把原 hash（含邀请码）存进 sessionStorage；
   * 登录成功（user 从 null 变非空，覆盖落地页与 AccountBox 两条登录路径）即按 returnTo
   * 跳回原链接——邀请链路不在「未登录点链接」这一步断掉。
   * ★ 只接受 `#/` 开头的站内 hash（`sanitizeReturnTo`，防开放重定向），其余丢弃。
   */
  useEffect(() => {
    if (!user) return;
    const raw = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    const ret = sanitizeReturnTo(raw);
    if (ret && window.location.hash !== ret) window.location.hash = ret;
  }, [user]);
  if (pk) return <PkApp />;
  if (user === undefined) return null; // 登录态查询中的空窗，避免「落地页闪一下又进应用」
  if (user) return <App />;
  return entryFor(user, form) === 'app' ? <App /> : <Landing onAuthed={(u) => setUser(u)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
