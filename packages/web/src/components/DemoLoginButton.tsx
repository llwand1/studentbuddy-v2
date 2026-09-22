/**
 * DemoLoginButton — 公用体验账号入口（契约 docs/AUTH-SPEC.md §2.10）。
 *
 * ★ 只在服务端开了 `SB_DEMO_LOGIN` 时由调用方渲染（`/api/auth/providers` 的
 *   `providers.demo`）——与 `GithubLoginButton` 同一条「画不画的开关在上游」纪律。
 * ★ 「点了真的能进」是它的功能本体（零凭证 fetch 登录），所以它是 `<button>` 不是 `<a>`
 *   （与 GitHub 那条 OAuth 整页跳转的按钮形状不同，见 GithubLoginButton 头注）。
 * ★★ 公用池警示文案不可删（2026-09-22 老板决策：共享池原样 + **页面明示**）：
 *   所有访客的数据互相可见，用户往聊天里输什么都有可能被下一个人看到——
 *   不写明就是默许隐私事故。
 */
import { useState } from 'react';
import type { AuthUser } from '@sb/shared';
import { api, ApiError } from '../lib/api';

export function DemoLoginButton({ onAuthed }: { onAuthed: (u: AuthUser) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.auth
      .demoLogin()
      .then((user) => onAuthed(user))
      .catch((e: unknown) => {
        // ADR-5：失败可读、可重试——服务端文案原样呈现（429 限流/404 未开都各有话说）
        setError(e instanceof ApiError ? e.message : '进入体验失败，请稍后重试');
        setBusy(false);
      });
  };

  return (
    <>
      <button type="button" className="landing-ghost" onClick={enter} disabled={busy}>
        {busy ? '进入中…' : '免注册，直接体验'}
      </button>
      {error ? (
        <span className="landing-cta-note landing-demo-error" role="alert">
          {error}
        </span>
      ) : (
        <span className="landing-cta-note landing-demo-note">公用体验账号：内容全站共享、访客彼此可见，请勿输入个人信息</span>
      )}
    </>
  );
}
