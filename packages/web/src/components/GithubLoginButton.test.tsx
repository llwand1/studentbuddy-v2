// @vitest-environment jsdom
/**
 * GithubLoginButton — 入口契约的最小钉死（契约 docs/AUTH-SPEC.md §2.8）。
 * ★ 关键一条是 href：OAuth 重定向流必须**整页导航**到 /api/auth/github，
 *   若哪天被改成 fetch/onClick 跳转（常见手滑），浏览器永远到不了 GitHub 授权页。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GithubLoginButton } from './GithubLoginButton';

describe('components/GithubLoginButton', () => {
  it('渲染为指向 /api/auth/github 的整页链接（不是 fetch）', () => {
    render(<GithubLoginButton label="使用 GitHub 登录" />);
    const link = screen.getByRole('link', { name: /GitHub 登录/ });
    expect(link.getAttribute('href')).toBe('/api/auth/github');
    cleanup();
  });

  it('className 透传（顶栏 ghost 与卡内整宽两种外观共用）', () => {
    render(<GithubLoginButton label="GitHub 登录" className="landing-ghost" />);
    const link = screen.getByRole('link', { name: /GitHub 登录/ });
    expect(link.classList.contains('landing-ghost')).toBe(true);
    cleanup();
  });
});
