/**
 * 应用入口。顶层 hash 路由（零依赖，不引 react-router——@sb/web 保持零运行时依赖）：
 * `#/pk` 进 AI 出题 PK 独立页（移动优先，契约 docs/PK-SPEC.md §5），其余进学习助手主壳。
 *
 * ★ 加**落地页分层**（产品不该直接怼进应用，要先有介绍再「开始使用」）：
 *   启动先问 `/api/auth/me`（与 AccountBox 同一事实源——登录态不自持，httpOnly cookie 前端读不到，
 *   只能问服务端）⇒ 已登录直接进 `App`，未登录进 `app/Landing.tsx`，登录成功回调换根。
 *   `user === undefined` 是「查询中」：此刻只渲染 `BootScreen`（默认透明、400ms 后才现身的启动画面——
 *   ~一次请求的空窗，不闪落地页再跳应用；快路径与原先的 null 无异）。
 * ★ 三个根场景之间的换根走 `SceneTransition`（像素幕布转场），首次挂载不铺布。
 * ★ 语言（中英切换）的 Provider 挂在最外（`<StrictMode>` 内、`<Root/>` 外）：三个根场景共用**同一份**
 *   语言状态——落地页页眉选了 EN、登录进应用壳仍是 EN（口径见 `app/landing-lang.tsx` 头注的范围决策）。
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { entryFor } from './app/entry';
import { Landing } from './app/Landing';
import { LandingLangProvider } from './app/landing-lang';
import { BootScreen } from './components/BootScreen';
import { SceneTransition } from './components/SceneTransition';
import { PkApp } from './features/pk/PkApp';
import { api } from './lib/api';
import { sanitizeReturnTo } from './features/pk/pk-view';
import type { AuthUser, DeployForm } from '@sb/shared';
import './styles/tokens.css';
import './styles/pixel-ui.css';
import './styles/pixel-shell.css';
import './styles/pixel-scene.css';
import './styles/pixel-motion.css';
import './styles/grimoire.css';
import './styles/grimoire-chat.css';

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
        //（契约 AUTH-SPEC §2.9）；线上形态走落地页。
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
  // 登录态查询中的空窗：不渲染落地页（避免「闪一下又进应用」），只放一块默认透明、400ms 后才现身的启动画面
  if (!pk && user === undefined) return <BootScreen />;
  /**
   * 三个根场景（对战页 / 应用壳 / 落地页）之间的切换走像素幕布转场（`SceneTransition`，full＝盖整个视口）：
   * 侧栏点「对战」、对战页点「← 学习助手」、落地页登录成功进应用，都是整屏换根，值得一块布。
   * ★ 首次挂载不铺布（组件自身的规则），所以冷启动进应用不多一拍。
   */
  const scene = pk ? 'pk' : entryFor(user ?? null, form); // entryFor：已登录恒 'app'，未登录按形态分叉
  return (
    <SceneTransition scene={scene} full>
      {scene === 'pk' && <PkApp />}
      {scene === 'app' && <App />}
      {scene === 'landing' && <Landing onAuthed={(u) => setUser(u)} />}
    </SceneTransition>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LandingLangProvider>
      <Root />
    </LandingLangProvider>
  </StrictMode>,
);
