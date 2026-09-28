/**
 * shell-copy — 应用壳**框架文案**的双语收编点（2026-09-28 全局中英切换：「给全局加一个英文按键」）。
 *
 * ★ 为什么单独一个文件：`landing-copy.ts` 那头的教训是「组件里留中文字面量 ⇒ 漏译没有任何东西会报」。
 *   壳层框架（导航以外的散件、会话列表、账号区、抽屉、试用提醒）此前散在 6 个组件体里，
 *   本次全部搬来与 `Bi`（{zh,en}）配对：**组件里不再留中文**，漏一句在 review 里一眼可见。
 *   导航标签不在这里——`NAV` 是导航数据本身，标签跟着它走（见 `app/nav.ts`）。
 *
 * ★ 范围：只收**壳层框架**。功能页（对话/设置/词条/卡牌/知识大陆/教练/搜索面板/PK）仍是中文，
 *   分批推进；口径与理由见 `app/landing-lang.tsx` 头注的范围决策 ①。
 *
 * ★ 品牌副标复用落地页那一条（`landing-copy.BRAND_TAGLINE`）：它的 zh 本就指回 `lib/brand`
 *   单一事实源，EN 也只有一处，不另写一条（两处各写一句迟早漂开）。
 */
import { AUTH_CODE_LEN } from '@sb/shared';
import type { Bi, LandingLang } from './landing-lang';
import { BRAND_TAGLINE as BRAND_TAGLINE_BI } from './landing-copy';

/** 壳层文案表：一层 `Bi`；`account` 是子表（同构，便于一条锁遍历全表查「半成品」） */
export type ShellCopy = Record<string, Bi | Record<string, Bi>>;

export const SHELL = {
  /** 侧栏 logo 下那句副标（产品牌子，见文件头注） */
  brandTagline: BRAND_TAGLINE_BI,

  /** 侧栏：新对话 / 历史对话 / 会话搜索 */
  newChat: { zh: '新对话', en: 'New chat' },
  history: { zh: '历史对话', en: 'History' },
  searchChats: { zh: '搜索会话', en: 'Search chats' },
  /** 搜索无命中时的提示（一条会话都没有是另一种态，那时不给文案） */
  noMatch: { zh: '没有匹配的会话', en: 'No matching chats' },

  /** 会话列表（`app/SessionList.tsx`） */
  untitled: { zh: '新对话', en: 'New chat' },
  replying: { zh: '回复中', en: 'Replying' },
  pin: { zh: '置顶', en: 'Pin' },
  unpin: { zh: '取消置顶', en: 'Unpin' },
  remove: { zh: '删除', en: 'Delete' },

  /** 移动端抽屉（`components/PixelSidebar.tsx`） */
  drawerOpen: { zh: '探索菜单', en: 'Open menu' },
  drawerClose: { zh: '收起菜单', en: 'Close menu' },
  navClose: { zh: '关闭导航', en: 'Close navigation' },

  /** 试用提醒（`components/TrialNotice.tsx`）。
   *  ★ EN 串尾那一个空格是**故意的**：中文在链接前不留白、英文必须留，故空格只放 en 侧，
   *    不在渲染处补（补了就变成中文也多一个空格）。 */
  trialPrefix: {
    zh: '线上版用于功能演示与试用；长期使用建议装',
    en: 'The online version is for demos and trials; for long-term use, install the ',
  },
  trialLink: { zh: '本地安装包版', en: 'local build' },

  /** 账号区（`components/AccountTrigger.tsx` 收起态 + `components/AccountBox.tsx` 表单）。
   *  `clickToLogin` 两处共用；服务端回的错误话（`ERROR_TEXT`）不在本表，仍是中文。 */
  account: {
    notLoggedIn: { zh: '未登录', en: 'Not signed in' },
    clickToLogin: { zh: '点击登录 / 注册', en: 'Click to sign in / register' },
    clickToLogout: { zh: '点击退出登录', en: 'Click to sign out' },
    tag: { zh: '账号', en: 'Account' },
    tagTitle: { zh: '邮箱账号：登录后会话只属于你自己', en: 'Email account: your chats are visible only to you' },
    login: { zh: '登录', en: 'Sign in' },
    register: { zh: '注册', en: 'Sign up' },
    email: { zh: '邮箱', en: 'Email' },
    password: { zh: '密码（至少 8 位）', en: 'Password (at least 8 characters)' },
    code: { zh: `${AUTH_CODE_LEN} 位验证码`, en: `${AUTH_CODE_LEN}-digit code` },
    sendCode: { zh: '发送验证码', en: 'Send code' },
    nickname: { zh: '昵称（可留空，默认取邮箱前缀）', en: 'Nickname (optional, defaults to your email prefix)' },
    forgot: { zh: '忘记密码 / 改用验证码登录', en: 'Forgot password / use an email code' },
    usePassword: { zh: '改用密码登录', en: 'Use password instead' },
    spamNote: {
      zh: '没收到？先翻一下垃圾箱——首次发信被误判的概率最高。',
      en: 'No email yet? Check your spam folder first — first-time mail lands there most often.',
    },
    submitRegister: { zh: '注册并登录', en: 'Create account and sign in' },
    submitByCode: { zh: '验证码登录', en: 'Sign in with code' },
    logout: { zh: '退出', en: 'Sign out' },
    collapse: { zh: '收起', en: 'Collapse' },
    errEmail: { zh: '邮箱格式不正确', en: 'That email address looks invalid' },
    errCode: { zh: '请填写邮箱收到的验证码', en: 'Enter the code we emailed you' },
    errPassword: { zh: '密码长度需在 8~100 位之间', en: 'Password must be 8-100 characters' },
    errSend: { zh: '验证码发送失败，请重试', en: 'Could not send the code, please try again' },
    errGeneric: { zh: '操作失败，请重试', en: 'Something went wrong, please try again' },
  },
} satisfies ShellCopy;

/**
 * 带数字的动态文案。沿用 `demo/pk-flow.ts` 的既有先例（`Record<LandingLang, (n)=>string>`）：
 * 中英语序相反，`${n}s 后重发` 与 `Resend in ${n}s` 给不出一句共用模板。
 */
export const RESEND_TEXT: Record<LandingLang, (sec: number) => string> = {
  zh: (sec) => `${sec}s 后重发`,
  en: (sec) => `Resend in ${sec}s`,
};