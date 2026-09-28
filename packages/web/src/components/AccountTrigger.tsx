/**
 * AccountTrigger — 账号框的**收起态**（头像 + 名称 + 标签），契约 docs/AUTH-SPEC.md §2。
 *
 * ★ 为什么单独一个文件：`AccountBox.tsx` 有 300 行红线，而后续往那个表单里加了
 *   「注册 / 密码登录 / 验证码登录」三条通道 ⇒ 必须把**不承担认证逻辑**的那部分让出去。
 *   选它让出去是因为它是本组件里**唯一零状态、零副作用**的一块（纯展示 + 一个回调）——
 *   把逻辑留在 `AccountBox.tsx`，这次拆分就动不到任何认证行为。
 *
 * ★ 头像**始终可点**（不随 `collapsed` 隐藏）：它是唯一的开合开关，藏起来用户就出不来了。
 *   收起时另外多显示名称与邮箱，展开时让位给表单。
 */
import type { AuthUser } from '@sb/shared';
import { UserIcon } from './icons';
import { useLandingLang } from '../app/landing-lang';
import { SHELL } from '../app/shell-copy';

export function AccountTrigger({
  user,
  collapsed,
  onToggle,
}: {
  user: AuthUser | null;
  /** 表单是否收起。收起时多显示名称/邮箱/标签，展开时只留头像。 */
  collapsed: boolean;
  onToggle: () => void;
}) {
  /** 收起态的四处文案跟着全局语言走（词表见 app/shell-copy.ts 的 account 子表） */
  const { lang } = useLandingLang();
  return (
    <>
      <span
        className="sb-avatar"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onToggle()}
      >
        <UserIcon size={15} />
      </span>
      {collapsed && (
        <span className="sb-user-meta" onClick={onToggle}>
          <span className="sb-user-name">{user ? user.nickname || user.email : SHELL.account.notLoggedIn[lang]}</span>
          <span className="sb-user-hint">{user ? user.email : SHELL.account.clickToLogin[lang]}</span>
        </span>
      )}
      {collapsed && (
        <span className="sb-login-tag" title={SHELL.account.tagTitle[lang]}>
          {SHELL.account.tag[lang]}
        </span>
      )}
    </>
  );
}
