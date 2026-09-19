/**
 * AccountBox — 侧栏账号框（契约 docs/AUTH-SPEC.md §2 / §2.5 / §2.7）。
 *
 * ★ 本组件是侧栏**唯一**的身份入口（旧 PK 昵称框 `UserAuthBox` 已于 2026-09-18 下线）：
 *   登录之后会话列表按 `sessions.user_id` 过滤（docs/TENANCY-SPEC.md），别人看不见你的会话。
 *
 * ★ 登录态**不自持、不落 localStorage**：会话是 httpOnly cookie，JS 读不到，启动与每次操作后都问
 *   `/api/auth/me`——在前端存「我已登录」会造出「界面已登录、服务端会话早过期」的假象（最难排查）。
 * ★ 校验复用 `@sb/shared` 纯函数（`normalizeEmail` / `passwordProblem`），与服务端同一份代码（ADR-5）。
 *
 * ★ 2026-09-18（M1.6）一个表单承载三条通道：**注册**（邮箱 → 发码 → 验证码+密码+昵称；契约 §2.7
 *   「注册即验证」= 没有验证码提交不了，前端必填与服务端 `code` 必填是同一件事的两侧）、
 *   **密码登录**（不依赖邮件，邮件通道挂了仍能进，§4.6）、**验证码登录**（与密码登录产出同一种
 *   会话，不是第二套账号体系）。⚠️ 三通道共用 `email` 输入框：换通道不该重打一遍邮箱。
 *
 * ⚠️ **发码的冷却秒数取自 `AUTH_CODE_RESEND_INTERVAL_MS`（不是写死 60）**：服务端的邮箱桶
 *   间隔就是它，前端写死一个数就会出现「按钮能点了但服务端还回 429」——而用户看不懂
 *   为什么刚亮起的按钮又报错。**同一个数字只能有一个真相源。**
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AUTH_CODE_LEN,
  AUTH_CODE_RESEND_INTERVAL_MS,
  normalizeEmail,
  passwordProblem,
  type AuthUser,
} from '@sb/shared';
import { AccountTrigger } from './AccountTrigger';
import { api } from '../lib/api';

type Mode = 'login' | 'register';

/** 冷却秒数：与服务端邮箱桶的最小间隔**同源**（见文件头注）。 */
const RESEND_SECONDS = Math.ceil(AUTH_CODE_RESEND_INTERVAL_MS / 1000);

/**
 * @param onAuthChange 登录 / 退出 / 启动查询的回调（**带最新身份**）：App 重载会话列表、落地页感知已登录换根。
 * @param standalone **落地页形态**（app/Landing.tsx 用）：隐藏触发器、表单常开——表单逻辑只有这一份。
 * @param initialMode 初始模式（两条 CTA 分别要「注册」「登录」）：模式是内部状态，调用方用 `key` 重挂切换。
 */
export function AccountBox({
  onAuthChange,
  standalone = false,
  initialMode = 'login',
}: {
  /** 登录 / 退出 / 启动查询都会回调（带最新身份；落地页靠它感知「已登录」换根进应用） */
  onAuthChange?: (user: AuthUser | null) => void;
  standalone?: boolean;
  initialMode?: Mode;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(standalone);
  const [mode, setMode] = useState<Mode>(initialMode);
  /** 仅登录模式有意义：密码 / 验证码二选一（注册模式恒为「验证码 + 密码」）。 */
  const [byCode, setByCode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 仅挂载查一次（onAuthChange 不进依赖：App 传内联箭头，进依赖会每渲染重跑 me）
    api.auth
      .me()
      .then((u) => {
        setUser(u);
        onAuthChange?.(u);
      })
      .catch(() => setUser(null)); // 401 = 未登录，是正常状态不是异常
  }, []);

  // 冷却倒计时。★ 用 `setTimeout` 链而非 `setInterval`：`cooldown` 每次变化都重建定时器，
  //   切到别的模式时会被清理掉，不会留下一个还在跑的 interval。
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const toggle = useCallback(() => {
    setError('');
    setOpen((v) => !v);
  }, []);

  /** 切换登录 / 注册。★ 清掉验证码与冷却：两个用途的码**在库里是分开的**（`purpose`），
   *  带着注册码去点登录只会得到 `CODE_INVALID`，而用户不知道为什么。 */
  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setError('');
    setCode('');
    setCooldown(0);
  }, []);

  const sendCode = useCallback(async () => {
    const em = normalizeEmail(email);
    if (!em) {
      setError('邮箱格式不正确');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // ★ 用途必须与提交时的通道一致：注册发 `register`（已注册会 409），其余发 `login`。
      await api.auth.sendCode(em, mode === 'register' ? 'register' : 'login');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [email, mode]);

  const submit = useCallback(async () => {
    const em = normalizeEmail(email);
    if (!em) {
      setError('邮箱格式不正确');
      return;
    }
    const needCode = mode === 'register' || byCode;
    if (needCode && !code.trim()) {
      setError('请填写邮箱收到的验证码');
      return;
    }
    if (!needCode && passwordProblem(password)) {
      setError('密码长度需在 8~100 位之间');
      return;
    }
    // 注册必须设密码（双通道并存，§0.1 第 2 条）：密码是邮件通道挂掉时唯一的退路。
    if (mode === 'register' && passwordProblem(password)) {
      setError('密码长度需在 8~100 位之间');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next =
        mode === 'register'
          ? await api.auth.register(em, code.trim(), password, nickname.trim() || undefined)
          : byCode
            ? await api.auth.loginByCode(em, code.trim())
            : await api.auth.login(em, password);
      setUser(next);
      setOpen(false);
      setPassword('');
      setCode('');
      setCooldown(0);
      onAuthChange?.(next);
    } catch (err) {
      // ApiError 里带的是服务端 `ERROR_TEXT` 的人话（如「这个邮箱已经注册过了，直接登录试试」）
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [email, password, nickname, code, mode, byCode, onAuthChange]);

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
    setCode('');
    setBusy(false);
    onAuthChange?.(null);
  }, [onAuthChange]);

  const showPassword = mode === 'register' || !byCode;
  const showCode = mode === 'register' || byCode;
  const submitLabel = mode === 'register' ? '注册并登录' : byCode ? '验证码登录' : '登录';

  return (
    <div className="sb-user-box sb-account-box" title={user ? '点击退出登录' : '点击登录 / 注册'}>
      {/* 收起态块（头像+名称）在 AccountTrigger.tsx；standalone（落地页）无侧栏身份语义，不渲染 */}
      {!standalone && <AccountTrigger user={user} collapsed={!open} onToggle={toggle} />}
      {(standalone || open) && (
        <form
          className="sb-user-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!user && (
            <div className="sb-user-form-tabs">
              <button
                type="button"
                className={mode === 'login' ? 'on' : ''}
                onClick={() => switchMode('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'on' : ''}
                onClick={() => switchMode('register')}
              >
                注册
              </button>
            </div>
          )}
          <input
            className="sb-user-form-input"
            placeholder="邮箱"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          {showPassword && (
            <input
              className="sb-user-form-input"
              placeholder="密码（至少 8 位）"
              type="password"
              value={password}
              autoComplete={user ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {showCode && (
            <div className="sb-user-form-row">
              <input
                className="sb-user-form-input"
                placeholder={`${AUTH_CODE_LEN} 位验证码`}
                value={code}
                maxLength={AUTH_CODE_LEN}
                inputMode="numeric"
                autoComplete="one-time-code"
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                type="button"
                className="sb-user-form-btn"
                disabled={busy || cooldown > 0 || !email}
                onClick={() => void sendCode()}
              >
                {cooldown > 0 ? `${cooldown}s 后重发` : '发送验证码'}
              </button>
            </div>
          )}
          {cooldown > 0 && (
            <span className="sb-user-form-note">
              没收到？先翻一下垃圾箱——首次发信被误判的概率最高。
            </span>
          )}
          {mode === 'register' && (
            <input
              className="sb-user-form-input"
              placeholder="昵称（可留空，默认取邮箱前缀）"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
            />
          )}
          {mode === 'login' && !user && (
            <button
              type="button"
              className="sb-user-form-link"
              onClick={() => {
                setByCode((v) => !v);
                setError('');
                setCode('');
              }}
            >
              {byCode ? '改用密码登录' : '忘记密码 / 改用验证码登录'}
            </button>
          )}
          {error && <span className="sb-user-form-err">{error}</span>}
          <div className="sb-user-form-actions">
            <button type="submit" className="sb-user-form-btn primary" disabled={busy || !email}>
              {submitLabel}
            </button>
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
