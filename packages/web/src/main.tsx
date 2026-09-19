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
import { Landing } from './app/Landing';
import { PkApp } from './features/pk/PkApp';
import { api } from './lib/api';
import type { AuthUser } from '@sb/shared';
import './styles/tokens.css';

/** GoatCounter 统计脚本（index.html 注入）的最低类型面；SPA 路由切换时手动补计数 */
declare global {
  interface Window {
    goatcounter?: { count?: (opt?: { path?: string }) => void };
  }
}

function isPkHash(): boolean {
  const h = window.location.hash;
  return h === '#/pk' || h.startsWith('#/pk/');
}

function Root() {
  const [pk, setPk] = useState(() => isPkHash());
  /** undefined = /api/auth/me 查询中；null = 未登录；非空 = 已登录 */
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  useEffect(() => {
    const on = () => setPk(isPkHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    api.auth
      .me()
      .then((u) => setUser(u))
      .catch(() => setUser(null)); // 401 = 未登录，是正常状态不是异常
  }, []);
  // SPA 路由计数：hash 变化不会触发整页加载，GoatCounter 的自动计数覆盖不到，手动补一针
  useEffect(() => {
    const count = () => window.goatcounter?.count?.({ path: location.pathname + location.hash });
    window.addEventListener('hashchange', count);
    return () => window.removeEventListener('hashchange', count);
  }, []);
  if (pk) return <PkApp />;
  if (user === undefined) return null; // 登录态查询中的空窗，避免「落地页闪一下又进应用」
  return user ? <App /> : <Landing onAuthed={(u) => setUser(u)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
