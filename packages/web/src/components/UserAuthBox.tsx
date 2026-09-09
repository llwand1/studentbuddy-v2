/**
 * UserAuthBox — 侧栏底部用户框（PK 登录 P0-1，契约 docs/PK-SPEC.md §2.1）。
 *
 * 未登录：点击展开昵称表单登录（服务端 pk_users 建号）；已登录：点击展开改名表单（含退出）。
 * 登录态 = 服务端账号 + localStorage 记住 userId（lib/auth）；启动时经 /auth/me 校验，
 * 账号不存在（换库/清数据）静默清除。P1 换真微信授权只改 api.pk 内部实现，此组件不动。
 * 自持登录态；P0-2 房间逻辑需要 userId 时再提升到 App（届时此处改受控即可）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PkIdentity } from '@sb/shared';
import { UserIcon } from './icons';
import { api } from '../lib/api';
import { loadLocalAuth, saveLocalAuth, clearLocalAuth } from '../lib/auth';

export function UserAuthBox() {
  const [auth, setAuth] = useState<PkIdentity | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 启动校验本地登录态：账号仍存在则直接恢复
  useEffect(() => {
    const local = loadLocalAuth();
    if (!local) return;
    api.pk
      .me(local.userId)
      .then((identity) => setAuth(identity))
      .catch(() => clearLocalAuth());
  }, []);

  const toggle = useCallback(() => {
    setNickname((n) => (formOpen ? n : auth?.nickname ?? ''));
    setError('');
    setFormOpen((v) => !v);
  }, [auth, formOpen]);

  const submit = useCallback(
    async (userId?: string) => {
      const name = nickname.trim();
      if (!name || name.length > 20) {
        setError('昵称 1~20 字');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const identity = await api.pk.login(name, userId);
        saveLocalAuth(identity);
        setAuth(identity);
        setFormOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '登录失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [nickname],
  );

  const logout = useCallback(() => {
    clearLocalAuth();
    setAuth(null);
    setFormOpen(false);
    setNickname('');
    setError('');
  }, []);

  return (
    <div className="sb-user-box" title={auth ? '点击改名 / 退出' : '点击登录'}>
      <span className="sb-avatar" onClick={toggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && toggle()}>
        <UserIcon size={15} />
      </span>
      {!formOpen && (
        <span className="sb-user-meta" onClick={toggle}>
          <span className="sb-user-name">{auth ? auth.nickname : '未登录'}</span>
          <span className="sb-user-hint">{auth ? auth.userId.slice(0, 8) : '点击登录'}</span>
        </span>
      )}
      {!formOpen && <span className="sb-login-tag">微信登录</span>}
      {formOpen && (
        <form
          className="sb-user-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(auth?.userId);
          }}
        >
          <input
            className="sb-user-form-input"
            placeholder="输入昵称（1~20 字）"
            value={nickname}
            maxLength={20}
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
          {error && <span className="sb-user-form-err">{error}</span>}
          <div className="sb-user-form-actions">
            <button type="submit" className="sb-user-form-btn primary" disabled={busy || !nickname.trim()}>
              {auth ? '保存' : '登录'}
            </button>
            {auth && (
              <button type="button" className="sb-user-form-btn" onClick={logout} disabled={busy}>
                退出
              </button>
            )}
            <button
              type="button"
              className="sb-user-form-btn"
              onClick={() => {
                setFormOpen(false);
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
