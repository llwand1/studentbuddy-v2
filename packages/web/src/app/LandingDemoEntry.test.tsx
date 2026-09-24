// @vitest-environment jsdom
/**
 * Landing 的公用体验入口（§2.10）—— 2026-09-24 归因批从 `Landing.test.tsx` 拆出来单开一门。
 *
 * ★ 拆的理由很实在：`Landing.test.tsx` 贴到了 gates 的 300 行红线，而本批要给它加桩点
 *   （providers 请求改走 `api.auth.surface()`，见下）。这一组锁讲的是**同一个决策**
 *   ——「开关在上游，按钮不点了报错」，与门面动线无关，分家两边各锁各的。
 * ★ 桩点在 `api` 那一层而不是 `fetch`：`Landing` 里那条 providers 请求是服务端 `app_open`
 *   的采集点，而归因头 `X-SB-Ref` 只由 `lib/api-request.ts` 注入 ⇒ 它必须走 api 层（那条锁在
 *   `lib/attribution.test.ts` 的源码锁里）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { Landing } from './Landing';
import { LANDING_LANG_KEY } from './landing-lang';

/** 同 `Landing.test.tsx`：jsdom 的 `navigator.language` 是 en-US，不钉中文这些中文文案锁全扑空。 */
window.localStorage.setItem(LANDING_LANG_KEY, 'zh');

const demoRef = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>) }));
const providersRef = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>) }));

vi.mock('../lib/api', () => ({
  // `DemoLoginButton` 顶层 `import { api, ApiError }`——工厂两个都得给
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) {
      super(message);
    }
  },
  api: {
    auth: {
      me: () => Promise.reject(new Error('401')),
      surface: () => (providersRef.impl ? providersRef.impl() : Promise.reject(new Error('providers 未桩化'))),
      sendCode: () => Promise.resolve({ ok: true, expiresInMs: 60_000 }),
      register: () => Promise.reject(new Error('unused-in-this-test')),
      demoLogin: () => (demoRef.impl ? demoRef.impl() : Promise.reject(new Error('demoLogin 未被本用例桩化'))),
    },
  },
}));

/** 桩 providers 一个响应：demo 字段按入参给。 */
function stubProviders(demo: boolean) {
  providersRef.impl = () => Promise.resolve({ providers: { github: false, demo }, form: 'cloud' });
}

afterEach(() => {
  cleanup();
  demoRef.impl = null;
  providersRef.impl = null;
});

describe('Landing — 公用体验入口（§2.10）', () => {
  it('providers.demo=true → 画「免注册，直接体验」并附共享池警示文案', async () => {
    stubProviders(true);
    const { findByText, getByText } = render(<Landing onAuthed={() => undefined} />);
    expect(await findByText('免注册，直接体验')).toBeTruthy();
    // 警示语是本批决策的落点（共享池 + 页面明示），删它等于默许隐私事故
    expect(getByText(/内容全站共享、访客彼此可见/)).toBeTruthy();
  });

  it('providers.demo=false → 入口不存在（开关在上游，按钮不点了报错）', async () => {
    stubProviders(false);
    const { findByText, container } = render(<Landing onAuthed={() => undefined} />);
    await findByText('开始使用');
    expect(container.textContent).not.toContain('免注册');
  });

  it('点击成功 → onAuthed 收到体验用户（进应用壳的动作由上层完成）', async () => {
    stubProviders(true);
    const user = { id: 'u-demo-shared', email: 'shared-demo@studentbuddy.invalid', nickname: '公用体验账号', createdAt: 'x' };
    demoRef.impl = () => Promise.resolve(user);
    const onAuthed = vi.fn();
    const { findByText } = render(<Landing onAuthed={onAuthed} />);
    fireEvent.click(await findByText('免注册，直接体验'));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(user));
  });

  it('点击失败 → 错误文案就地可见，按钮回到可点（ADR-5 可读可重试）', async () => {
    stubProviders(true);
    demoRef.impl = () => Promise.reject(new Error('体验模式未开放'));
    const { findByText, queryByText } = render(<Landing onAuthed={() => undefined} />);
    fireEvent.click(await findByText('免注册，直接体验'));
    await waitFor(() => expect(queryByText('进入体验失败，请稍后重试')).toBeTruthy());
    expect(queryByText('免注册，直接体验')).toBeTruthy();
  });
});
