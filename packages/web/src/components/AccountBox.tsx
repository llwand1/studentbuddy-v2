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
 * ★ 2026-09-18 一个表单承载三条通道：**注册**、**密码登录**（不依赖邮件，邮件通道挂了
 *   仍能进，§4.6）、**验证码登录**（与密码登录产出同一种会话，不是第二套账号体系）。
 *   ★★ 2026-09-22（契约 §2.7 作废）：**注册不再要邮箱验证码**，注册态＝邮箱 + 密码（+ 可选昵称），
 *   提交即进。⇒ 本组件里「注册要发码」的三处分支同时消失（`needCode`、`showCode`、发码用途），
 *   少改任何一处都会留下一个「点了发送、码却永远核销不掉」的死入口（白烧一封真邮件）。
 *   ⚠️ 三通道仍共用 `email` 输入框：换通道不该重打一遍邮箱。
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
import { useLandingLang } from '../app/landing-lang';
import { RESEND_TEXT, SHELL } from '../app/shell-copy';

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
  /** 表单文案跟着全局语言走（词表见 app/shell-copy.ts 的 account 子表 + RESEND_TEXT）。
   *  ★ `lang` 必须进下面两个 useCallback 的依赖数组——漏了就会出现「切了语言、报错文案还是旧语言」。 */
  const { lang } = useLandingLang();
  const C = SHELL.account;
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
      setError(C.errEmail[lang]);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // ★ 用途恒为 `login`：注册态自 2026-09-22 起不显示码行（`showCode` 已收窄），
      //   而服务端 `register` 用途一并摘线 ⇒ 这里再发一次 `register` 就是一封永远核销不掉的邮件。
      await api.auth.sendCode(em, 'login');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : C.errSend[lang]);
    } finally {
      setBusy(false);
    }
  }, [email, lang]);

  const submit = useCallback(async () => {
    const em = normalizeEmail(email);
    if (!em) {
      setError(C.errEmail[lang]);
      return;
    }
    // ★ 只有「验证码登录」一条通道要码（注册自 2026-09-22 起免码，契约 §2.7 作废）。
    const needCode = byCode;
    if (needCode && !code.trim()) {
      setError(C.errCode[lang]);
      return;
    }
    // 注册与密码登录都必须设密码（双通道并存）：密码是邮件通道挂掉时唯一的退路。
    if (!needCode && passwordProblem(password)) {
      setError(C.errPassword[lang]);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next =
        mode === 'register'
          ? await api.auth.register(em, password, nickname.trim() || undefined)
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
      setError(err instanceof Error ? err.message : C.errGeneric[lang]);
    } finally {
      setBusy(false);
    }
  }, [email, password, nickname, code, mode, byCode, onAuthChange, lang]);

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
  const showCode = byCode;
  const submitLabel =
    mode === 'register'
      ? C.submitRegister[lang]
      : byCode
        ? C.submitByCode[lang]
        : C.login[lang];

  return (
    <div className="sb-user-box sb-account-box" title={user ? C.clickToLogout[lang] : C.clickToLogin[lang]}>
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
                {C.login[lang]}
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'on' : ''}
                onClick={() => switchMode('register')}
              >
                {C.register[lang]}
              </button>
            </div>
          )}
          <input
            className="sb-user-form-input"
            placeholder={C.email[lang]}
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          {showPassword && (
            <input
              className="sb-user-form-input"
              placeholder={C.password[lang]}
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
                placeholder={C.code[lang]}
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
                {cooldown > 0 ? RESEND_TEXT[lang](cooldown) : C.sendCode[lang]}
              </button>
            </div>
          )}
          {cooldown > 0 && (
            <span className="sb-user-form-note">{C.spamNote[lang]}</span>
          )}
          {mode === 'register' && (
            <input
              className="sb-user-form-input"
              placeholder={C.nickname[lang]}
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
              {byCode ? C.usePassword[lang] : C.forgot[lang]}
            </button>
          )}
          {error && <span className="sb-user-form-err">{error}</span>}
          <div className="sb-user-form-actions">
            <button type="submit" className="sb-user-form-btn primary" disabled={busy || !email}>
              {submitLabel}
            </button>
            {user && (
              <button type="button" className="sb-user-form-btn" disabled={busy} onClick={() => void logout()}>
                {C.logout[lang]}
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
              {C.collapse[lang]}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
