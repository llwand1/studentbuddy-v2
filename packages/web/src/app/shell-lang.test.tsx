// @vitest-environment jsdom
/**
 * shell-lang.test — 全局中英切换在**应用壳**这一侧的锁（2026-09-28「给全局加一个英文按键」）。
 *
 * ★ 为什么单独一个文件：`LandingLang.test.tsx` 守的是落地页门面；壳层框架文案此前一直写死中文，
 *   本次第一次跟着语言走。这几条锁按「坏了最没人发现」排序：
 *   ① **壳层框架真的换血**：切到 EN 后侧栏（抽屉 / 会话列表 / 账号区 / 试用提醒）的读数是英文——
 *      漏接一句 `[lang]` 只会静默留中文，没有任何东西会报（这正是本次要修的病）；
 *   ② **落地页与应用壳共用同一份状态**：Provider 提到 `main.tsx` 根就是为了这个，
 *      双层 Provider 的老症状是「落地页选了 EN、登录进壳又变回中文」；
 *   ③ **词表没有半成品**：`SHELL` 递归遍历，每条 zh/en 都非空且 en 侧不留中文；
 *   ④ **zh 反向锁**：切换器不能是单向的——英文侧换得到，中文侧也得换得回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from '@sb/shared';
import { LANDING_LANG_KEY, LandingLangProvider, useLandingLang, type Bi } from './landing-lang';
import { NAV } from './nav';
import { RESEND_TEXT, SHELL } from './shell-copy';
import { SessionList } from './SessionList';
import { Landing } from './Landing';
import { AccountBox } from '../components/AccountBox';
import { AccountTrigger } from '../components/AccountTrigger';
import { PixelSidebar } from '../components/PixelSidebar';
import { TrialNotice } from '../components/TrialNotice';

/** `Landing` 与 `AccountBox` 都碰 `lib/api`（`auth.surface` / `auth.me`）⇒ 整门 mock（同 `LandingLang.test.tsx`） */
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) {
      super(message);
    }
  },
  api: {
    auth: {
      me: () => Promise.reject(new Error('401')),
      surface: () => Promise.resolve({ providers: { github: false, demo: false }, form: 'cloud' }),
      sendCode: () => Promise.resolve({ ok: true, expiresInMs: 60_000 }),
      register: () => Promise.reject(new Error('unused')),
      login: () => Promise.reject(new Error('unused')),
      loginByCode: () => Promise.reject(new Error('unused')),
      logout: () => Promise.resolve({ ok: true }),
    },
  },
}));

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** 语言靠记忆键落到某一侧（`initialLandingLang`：记忆 > 浏览器语言），比改 navigator 稳 */
const useLang = (lang: 'zh' | 'en') => window.localStorage.setItem(LANDING_LANG_KEY, lang);

const SESSIONS: Session[] = [
  { id: 's1', title: '', createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', pinned: true },
];

/** 壳层散件合体（抽屉 + 会话列表 + 账号区收起态 + 试用提醒）。**不带 Provider**，由用例罩上 */
function ShellProbe() {
  return (
    <PixelSidebar>
      <SessionList
        sessions={SESSIONS}
        activeId={null}
        collapsed={false}
        busy={new Set<string>()}
        emptyHint={null}
        onOpen={() => undefined}
        onTogglePin={() => undefined}
        onRemove={() => undefined}
      />
      <AccountTrigger user={null} collapsed onToggle={() => undefined} />
      <TrialNotice />
    </PixelSidebar>
  );
}

/** 语言读数探针：用来证明「同一层 Provider 下，落地页切了语言，壳这边看得到」 */
function LangProbe() {
  const { lang } = useLandingLang();
  return <span className="lang-probe">{lang}</span>;
}

describe('全局中英切换 — 壳层框架真的换血', () => {
  it('EN 侧：抽屉、会话列表、账号区、试用提醒整片读数是英文', () => {
    useLang('en');
    const { container } = render(
      <LandingLangProvider>
        <ShellProbe />
      </LandingLangProvider>,
    );
    expect(screen.getByRole('button', { name: SHELL.drawerOpen.en })).toBeTruthy();
    // 会话列表里三处散件：占位标题、置顶提示、删除提示（后两者在 title 属性上，屏幕上看不见）
    expect(container.querySelector('.sb-session-title')?.textContent).toBe(SHELL.untitled.en);
    expect(container.querySelector('.sb-session-pin')?.getAttribute('title')).toBe(SHELL.unpin.en);
    expect(container.querySelector('.sb-session-del')?.getAttribute('title')).toBe(SHELL.remove.en);
    expect(container.textContent).toContain(SHELL.account.notLoggedIn.en);
    expect(container.textContent).toContain(SHELL.account.clickToLogin.en);
    expect(container.querySelector('.sb-login-tag')?.getAttribute('title')).toBe(SHELL.account.tagTitle.en);
    expect(container.textContent).toContain(SHELL.trialLink.en);
  });

  it('★ zh 反向锁：同一套壳切回中文，读数逐条回中文（切换器不是单向的）', () => {
    useLang('zh');
    const { container } = render(
      <LandingLangProvider>
        <ShellProbe />
      </LandingLangProvider>,
    );
    expect(screen.getByRole('button', { name: SHELL.drawerOpen.zh })).toBeTruthy();
    expect(container.querySelector('.sb-session-title')?.textContent).toBe(SHELL.untitled.zh);
    expect(container.querySelector('.sb-session-pin')?.getAttribute('title')).toBe(SHELL.unpin.zh);
    expect(container.textContent).toContain(SHELL.account.notLoggedIn.zh);
    // 反向锁的价值在这两条：中文侧绝不能漏出英文残留
    expect(container.textContent).not.toContain(SHELL.trialLink.en);
    expect(container.textContent).not.toContain(SHELL.account.notLoggedIn.en);
  });

  it('导航标签两语齐备、英文不重复，且卡牌并入词条后不再占独立入口', () => {
    for (const { label } of NAV) {
      expect(label.zh.trim()).not.toBe('');
      expect(label.en.trim()).not.toBe('');
    }
    expect(new Set(NAV.map((n) => n.label.en)).size).toBe(NAV.length);
    expect(NAV.map((n) => n.key)).not.toContain('cards');
    expect(NAV.map((n) => n.key)).toContain('terms');
  });

  it('★ 落地页与应用壳共用同一份语言状态：在落地页点 EN，壳这边读到的也是 en', () => {
    useLang('zh');
    const { container } = render(
      <LandingLangProvider>
        <LangProbe />
        <Landing onAuthed={() => undefined} />
      </LandingLangProvider>,
    );
    const probe = () => container.querySelector('.lang-probe')?.textContent;
    expect(probe()).toBe('zh');
    fireEvent.click(screen.getAllByRole('button', { name: 'EN' })[0]!);
    expect(probe()).toBe('en');
    expect(window.localStorage.getItem(LANDING_LANG_KEY)).toBe('en');
  });
});

describe('全局中英切换 — 词表没有半成品', () => {
  it('SHELL 递归遍历：每条 zh/en 都非空，en 侧不留中文（含 account 子表）', () => {
    // `'zh' in value` 收不窄 `Record<string, Bi>`（索引签名让所有键都"可能存在"），故用类型守卫
    const isBi = (v: Bi | Record<string, Bi>): v is Bi => typeof (v as Bi).zh === 'string';
    const leaves: Array<[string, Bi]> = [];
    for (const [key, value] of Object.entries(SHELL as Record<string, Bi | Record<string, Bi>>)) {
      if (isBi(value)) leaves.push([key, value]);
      else for (const [sub, bi] of Object.entries(value)) leaves.push([`${key}.${sub}`, bi]);
    }
    expect(leaves.length, 'SHELL 一条都没遍历到 ⇒ 表的形状变了').toBeGreaterThan(20);
    for (const [key, bi] of leaves) {
      expect(bi.zh.trim(), `${key} 缺中文`).not.toBe('');
      expect(bi.en.trim(), `${key} 缺英文`).not.toBe('');
      // en 侧留中文＝漏译最典型的形态（`trialPrefix.en` 的尾空格由 trim 处理掉）
      expect(bi.en, `${key} 的 en 侧还是中文`).not.toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('带数字的文案两语都得带得上那个数（中英语序相反，给不出一句共用模板）', () => {
    for (const lang of ['zh', 'en'] as const) {
      expect(RESEND_TEXT[lang](42)).toContain('42');
    }
  });

  it('账号表单在 EN 下换成英文：标签页、占位符、提交按钮', () => {
    useLang('en');
    render(
      <LandingLangProvider>
        <AccountBox standalone />
      </LandingLangProvider>,
    );
    expect(screen.getByRole('button', { name: SHELL.account.register.en })).toBeTruthy();
    // 「登录」在 EN 下有两处（标签页 + 提交按钮），两处都得换
    expect(screen.getAllByRole('button', { name: SHELL.account.login.en })).toHaveLength(2);
    expect(screen.getByPlaceholderText(SHELL.account.email.en)).toBeTruthy();
    expect(screen.getByPlaceholderText(SHELL.account.password.en)).toBeTruthy();
  });
});