/**
 * AccountBox — 侧栏账号框（契约 docs/AUTH-SPEC.md §2）。
 *
 * ★ 本组件是侧栏**唯一**的身份入口（旧 PK 昵称框 `UserAuthBox` 已于 2026-09-18 下线）：
 *   登录之后会话列表按 `sessions.user_id` 过滤（docs/TENANCY-SPEC.md），别人看不见你的会话。
 *   两套身份仍然存在但**入口分离**：PK 对战昵称走 `pk_users` 表、只在 PK 房间内登录
 *   （`features/pk/usePkIdentity`），不产生数据归属；M4 才合并到同一个 user（AUTH-SPEC §0）。
 *   摘掉侧栏那个昵称框的理由：它看着像「已登录」却不产生任何归属，正是「以为什么都做了、
 *   其实没隔离」的错觉来源——而错觉在权限类问题上比没有功能更危险。
 *
 * ★ 登录态**不自持、不落 localStorage**：会话是 httpOnly cookie，JS 读不到。启动与每次操作后
 *   都问 `/api/auth/me`。在前端存「我已登录」就会出现「界面显示已登录、服务端会话早过期」的假象，
 *   而这类假象正是权限类 bug 最难排查的一种。
 *
 * ★ 校验复用 `@sb/shared` 的纯函数（`normalizeEmail` / `passwordProblem`），与服务端**同一份代码**：
 *   表单放行的，服务端必然也放行；反过来服务端拒的，这里也先拦下来（ADR-5：失败可读可重试）。
 */
import { useCallback, useEffect, useState } from 'react';
import { normalizeEmail, passwordProblem, type AuthUser } from '@sb/shared';
import { UserIcon } from './icons';
import { api } from '../lib/api';

/**
 * @param onAuthChange 登录 / 退出后的回调。App 用它重载会话列表——**过滤条件随身份变化**，
 *   不重载的话侧栏会继续显示已经不属于当前用户的会话，看着能用、点进去才 404。
 */
export function AccountBox({ onAuthChange }: { onAuthChange?: () => void }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth
      .me()
      .then(setUser)
      .catch(() => setUser(null)); // 401 = 未登录，是正常状态不是异常
  }, []);

  const toggle = useCallback(() => {
    setError('');
    setOpen((v) => !v);
  }, []);

  const submit = useCallback(
    async (which: 'login' | 'register') => {
      const em = normalizeEmail(email);
      if (!em) {
        setError('邮箱格式不正确');
        return;
      }
      if (passwordProblem(password)) {
        setError('密码长度需在 8~100 位之间');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const next =
          which === 'login'
            ? await api.auth.login(em, password)
            : await api.auth.register(em, password, nickname.trim() || undefined);
        setUser(next);
        setOpen(false);
        setPassword('');
        onAuthChange?.();
      } catch (err) {
        // ApiError 里带的是服务端 `ERROR_TEXT` 的人话（如「这个邮箱已经注册过了，直接登录试试」）
        setError(err instanceof Error ? err.message : '登录失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [email, password, nickname, onAuthChange],
  );

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await api.auth.logout();
    } catch {
      // 登出失败也按已登出处理：会话若已失效，用户在服务端本就登出了
    }
    setUser(null);
    setOpen(false);
    setPassword('');
    setBusy(false);
    onAuthChange?.();
  }, [onAuthChange]);

  return (
    <div className="sb-user-box sb-account-box" title={user ? '点击退出登录' : '点击登录 / 注册'}>
      <span
        className="sb-avatar"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && toggle()}
      >
        <UserIcon size={15} />
      </span>
      {!open && (
        <span className="sb-user-meta" onClick={toggle}>
          <span className="sb-user-name">{user ? user.nickname || user.email : '未登录'}</span>
          <span className="sb-user-hint">{user ? user.email : '点击登录 / 注册'}</span>
        </span>
      )}
      {!open && (
        <span className="sb-login-tag" title="邮箱账号：登录后会话只属于你自己">
          账号
        </span>
      )}
      {open && (
        <form
          className="sb-user-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit('login');
          }}
        >
          <input
            className="sb-user-form-input"
            placeholder="邮箱"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="sb-user-form-input"
            placeholder="密码（至少 8 位）"
            type="password"
            value={password}
            autoComplete={user ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!user && (
            <input
              className="sb-user-form-input"
              placeholder="昵称（可留空，默认取邮箱前缀）"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
            />
          )}
          {error && <span className="sb-user-form-err">{error}</span>}
          <div className="sb-user-form-actions">
            <button type="submit" className="sb-user-form-btn primary" disabled={busy || !email || !password}>
              登录
            </button>
            {!user && (
              <button
                type="button"
                className="sb-user-form-btn"
                disabled={busy || !email || !password}
                onClick={() => void submit('register')}
              >
                注册
              </button>
            )}
            {user && (
              <button type="button" className="sb-user-form-btn" disabled={busy} onClick={() => void logout()}>
                退出
              </button>
            )}
            <button
              type="button"
              className="sb-user-form-btn"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError('');
              }}
            >
              收起
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
