/**
 * GithubLoginButton — GitHub OAuth 登录入口（契约 docs/AUTH-SPEC.md §2.8）。
 *
 * ★ 是 `<a>` 不是 `<button>`：OAuth 重定向流必须**整页跳转**到 `/api/auth/github`，
 *   fetch 拿到 302 只会静默跟随、浏览器永远到不了 GitHub 授权页。
 * ★ 只在服务端配置了 GitHub 凭据（`/api/auth/providers` 的 `github: true`）时由
 *   调用方渲染——按钮常在、点了 503 是坏体验（ADR-5），所以「画不画」的开关在上游。
 */
import { GithubIcon } from './icons';

export function GithubLoginButton({ label, className }: { label: string; className?: string }) {
  return (
    <a className={className} href="/api/auth/github">
      <GithubIcon size={16} />
      <span>{label}</span>
    </a>
  );
}
