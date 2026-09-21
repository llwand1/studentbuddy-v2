// @vitest-environment jsdom
/**
 * PlatformChannelCard.test — 「一键默认设置」的**二次确认**渲染层锁（2026-09-21 老板拍板加）。
 *
 * ── 为什么单独立这个文件 ──────────────────────────────────────────────────────
 * 这个按钮是全仓**唯一一个会覆盖用户已有数据的实心主色按钮**，而它偏偏又是
 * **新用户第一眼就会点**的那一个（落在「免费通道」卡片里，文案写着"一键"）。
 * 加确认之前：一个已经逐行精细调过 8 个角色的老用户误点一下，配置就没了
 * ——服务端 `ON CONFLICT DO UPDATE` 会把自填的模型名一并清空。
 *
 * ── 钉六件事（每条对应一个真会伤到用户的失败模式）────────────────────────────
 *   ① ★★ **首屏点一下不许发请求** —— 整批的核心。注意锁的是"点了**不该**有反应"，
 *      而不是"点了没反应"；这两句在断言上长得像、在用户那里是完全相反的体验。
 *   ② 首屏那枚按钮的**文案**必须还是「一键默认设置」（没被确认态提前污染），
 *      且确认态下确认键带 `danger` 样式钩子（它得**看得出来**跟平时那个主色键不一样）。
 *   ③ ★ **代价说明要点名后果** —— 只说"确定吗"而不说会覆盖什么的确认框，
 *      用户只会无脑点确定。故断言里逐字要求出现「覆盖」「模型名」「8 个角色」。
 *   ④ **取消**要能干净回退（首屏文案回来、代价说明消失），且**始终没有请求**。
 *   ⑤ 只有**确认键**才调 `oneClickDefault`，成功后 flash 成功文案 + 触发 `onConfigured`
 *      ——漏了 `onConfigured` 就是上一批修过的那个"点了没反应"（提示说配好了、表还是旧的）。
 *   ⑥ ★ **失败也要退回首屏**，不许停在"再点一下就生效"的确认态：那一刻用户早忘了
 *      这按钮会覆盖什么，停在确认态等于把一次失败变成一次静默的误覆盖。
 *
 * ── 替身边界 ─────────────────────────────────────────────────────────────────
 * `lib/api` 整体替身（同 `SpeechCard.test.tsx` 的写法）：本文件测的是**卡片的编排**
 * （点几下、发没发、发了什么），不是额度读取本身。
 * ★ 一处刻意的措辞：首屏那发 `GET /quota` 是**允许**发的（它只读、不改任何东西），
 *   故断言写的是"`oneClickDefault` 没被调用"，而不是"一个请求都没有"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  quota: vi.fn(),
  oneClickDefault: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: { providers: { quota: h.quota, oneClickDefault: h.oneClickDefault } },
}));

import { PlatformChannelCard } from './PlatformChannelCard';

/** 额度读回一态（`limited:false` ＝ 本地模式，状态文案最短，不干扰按钮断言）。 */
const QUOTA = { used: 0, limit: 250, resetAt: Date.now() + 60_000, limited: false };

const idleBtn = () => screen.getByRole('button', { name: '一键默认设置' }) as HTMLButtonElement;
const confirmBtn = () => screen.getByRole('button', { name: '确认覆盖' }) as HTMLButtonElement;

function mount() {
  const flash = vi.fn();
  const onConfigured = vi.fn();
  render(<PlatformChannelCard flash={flash} onConfigured={onConfigured} />);
  return { flash, onConfigured };
}

/**
 * 等首屏额度读完。★ 不这么做的话首屏那枚按钮是 `disabled` 的（`loading` 起始为 true），
 * `fireEvent.click` 打上去会被浏览器丢弃 ⇒ 测试会**误判成"确认态没生效"**，
 * 而真相是"按钮还没启用"。这类假红最容易把人引到错误的方向去。
 */
async function ready() {
  await waitFor(() => expect(idleBtn().disabled).toBe(false));
}

/** 首屏 → 确认态（点一下，等「确认覆盖」出现）。 */
async function enterConfirm() {
  fireEvent.click(idleBtn());
  await waitFor(() => expect(confirmBtn()).toBeTruthy());
}

beforeEach(() => {
  h.quota.mockResolvedValue(QUOTA);
  h.oneClickDefault.mockResolvedValue({ roles: 8, model: 'agnes-2.5-flash' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlatformChannelCard — 一键默认设置的二次确认', () => {
  it('① 首屏点一下只进确认态：oneClickDefault 不许被调用', async () => {
    mount();
    await ready();

    await enterConfirm();

    // ★ 这条就是整批的核心：确认态必须真的拦在请求**前面**
    expect(h.oneClickDefault).not.toHaveBeenCalled();
  });

  it('② 确认态：文案换了、带 danger 钩子、旁边有取消', async () => {
    mount();
    await ready();

    await enterConfirm();

    expect(confirmBtn().className).toContain('danger');
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    // 首屏那枚的文案此刻不该还挂在 DOM 上（否则用户看到两个都像主键）
    expect(screen.queryByRole('button', { name: '一键默认设置' })).toBeNull();
  });

  it('③ 代价说明点名后果：覆盖 / 模型名 / 8 个角色', async () => {
    mount();
    await ready();

    await enterConfirm();

    // `role="alert"` 是刻意的：确认态没有别的视觉位移（按钮原地换文案），
    // 不把代价念出来，读屏用户等于确认了个寂寞。
    const warn = screen.getByRole('alert').textContent ?? '';
    expect(warn).toContain('覆盖');
    expect(warn).toContain('模型名');
    expect(warn).toContain('8 个角色');
  });

  it('④ 取消能干净回退，且始终没有请求', async () => {
    mount();
    await ready();
    await enterConfirm();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(idleBtn()).toBeTruthy());
    expect(screen.queryByRole('button', { name: '确认覆盖' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.oneClickDefault).not.toHaveBeenCalled();
  });

  it('⑤ 确认键才真动手：调一次 + flash 成功 + 触发 onConfigured + 回首屏', async () => {
    const { flash, onConfigured } = mount();
    await ready();
    await enterConfirm();

    fireEvent.click(confirmBtn());

    await waitFor(() => expect(h.oneClickDefault).toHaveBeenCalledTimes(1));
    // `onConfigured` 漏掉＝提示说配好了、上面那张绑定表还是旧的（上一批真机逮到的症状）
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
    expect(flash).toHaveBeenCalledWith(true, expect.stringContaining('8 个角色'));
    await waitFor(() => expect(idleBtn()).toBeTruthy());
  });

  it('⑥ 失败退回首屏，不停在「再点一下就生效」的确认态', async () => {
    h.oneClickDefault.mockRejectedValue(new Error('平台免费通道还没开通（服务商密钥未配置）'));
    const { flash, onConfigured } = mount();
    await ready();
    await enterConfirm();

    fireEvent.click(confirmBtn());

    await waitFor(() =>
      expect(flash).toHaveBeenCalledWith(false, expect.stringContaining('密钥未配置')),
    );
    expect(onConfigured).not.toHaveBeenCalled();
    // ★ 停在确认态＝把一次失败变成一次静默的误覆盖（用户早忘了这按钮会覆盖什么）
    await waitFor(() => expect(idleBtn()).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
