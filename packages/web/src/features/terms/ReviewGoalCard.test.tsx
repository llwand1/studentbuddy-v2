// @vitest-environment jsdom
/**
 * ReviewGoalCard.test — 自定义复习目标卡的渲染层锁（EBBINGHAUS-SPEC §10，2026-09-21 新建）。
 *
 * 钉五件事：
 *   ① 渲染服务端读回的目标与进度（`count = 0` 时说"未设目标"，**不能**说"0 条已完成"）；
 *   ② 点预设 / 点领域**立即落库**——改了不存＝用户以为设了其实没设；
 *   ③ ★ **以服务端回写值刷新本地**：用户输 9999，界面必须显示 200（服务端钳过位）。
 *      若拿自己发上去的值当结果，界面会显示一个库里并不存在的数；
 *   ④ 池子不够时**如实说出来**（设了 30 条而库里只有 8 条可补，不说清用户会以为功能坏了）；
 *   ⑤ 保存失败必须说出来且控件恢复可用（能重试）。
 *
 * ★ `lib/api` 整体替身：本文件测的是**卡片的编排**（读到什么、点了发什么、怎么显示），
 *   不是服务端归一（那由 `shared/src/review-goal.test.ts` 与
 *   `server/src/routes/term-review.test.ts` 覆盖）。三层分工不重叠。
 * ★ 依 §7 纪律**显式 `afterEach(cleanup)`**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  goal: vi.fn(),
  setGoal: vi.fn(),
  domains: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../lib/api', () => ({
  api: { terms: { goal: h.goal, setGoal: h.setGoal, domains: h.domains } },
  ApiError: h.ApiError,
}));

import { ReviewGoalCard } from './ReviewGoalCard';

const DOMAINS = {
  total: 15,
  today: 0,
  preferred: [],
  domains: [
    { domain: 'cs', count: 10, note: '', mentionCount: 0, reviewEnabled: true, reviewCount: 10 },
    { domain: 'math', count: 5, note: '', mentionCount: 0, reviewEnabled: true, reviewCount: 5 },
  ],
};

/** 挂载并等到卡片读完目标（首帧是空态，直接断言会扑空） */
async function mount(props: { doneCards: number; poolSize: number } = { doneCards: 0, poolSize: 50 }) {
  render(<ReviewGoalCard doneCards={props.doneCards} poolSize={props.poolSize} />);
  await screen.findByRole('button', { name: '保存' });
}

beforeEach(() => {
  h.goal.mockReset();
  h.setGoal.mockReset();
  h.domains.mockReset();
  h.goal.mockResolvedValue({ count: 30, domains: [] });
  h.domains.mockResolvedValue(DOMAINS);
  h.setGoal.mockImplementation((g: { count: number; domains: string[] }) => Promise.resolve(g));
});

afterEach(cleanup);

describe('ReviewGoalCard — 渲染与进度', () => {
  it('渲染读回的目标与今日进度', async () => {
    await mount({ doneCards: 12, poolSize: 50 });
    expect(await screen.findByText(/还差 18 条/)).toBeTruthy();
    expect((screen.getByLabelText('每日复习目标条数') as HTMLInputElement).value).toBe('30');
  });

  it('★ 未设目标（count = 0）时说"未设目标"，不说"0 条已完成"', async () => {
    h.goal.mockResolvedValue({ count: 0, domains: [] });
    await mount();
    // 说成"已完成 0/0"会让用户以为目标就是 0；两者的下一步动作完全不同
    expect(await screen.findByText(/未设目标/)).toBeTruthy();
  });

  it('达标态显示"已达成"', async () => {
    await mount({ doneCards: 30, poolSize: 50 });
    expect(await screen.findByText(/已达成 30 \/ 30/)).toBeTruthy();
  });

  it('★ 池子不够时如实说明（设 50 条而可复习的只有 8 条）', async () => {
    h.goal.mockResolvedValue({ count: 50, domains: [] });
    await mount({ doneCards: 0, poolSize: 8 });
    expect(await screen.findByText(/可复习的词条只有 8 条/)).toBeTruthy();
  });
});

describe('ReviewGoalCard — 写入', () => {
  it('点预设条数立即落库', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: '50' }));
    await waitFor(() => expect(h.setGoal).toHaveBeenCalledWith({ count: 50, domains: [] }));
  });

  it('点领域 chip 立即落库（带上更新后的领域列表）', async () => {
    await mount();
    fireEvent.click(await screen.findByTitle('把「cs」设为优先'));
    await waitFor(() => expect(h.setGoal).toHaveBeenCalledWith({ count: 30, domains: ['cs'] }));
  });

  it('再点一次同一个领域 = 取消优先', async () => {
    h.goal.mockResolvedValue({ count: 30, domains: ['cs'] });
    await mount();
    fireEvent.click(await screen.findByTitle('取消优先「cs」'));
    await waitFor(() => expect(h.setGoal).toHaveBeenCalledWith({ count: 30, domains: [] }));
  });

  it('★★ 以服务端回写值刷新界面：输 9999 而服务端存 200 ⇒ 界面显示 200', async () => {
    h.setGoal.mockResolvedValue({ count: 200, domains: [] });
    await mount();
    const input = screen.getByLabelText('每日复习目标条数') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 若拿自己发上去的值当结果，这里会停在 9999——一个库里并不存在的数
    await waitFor(() => expect(input.value).toBe('200'));
    expect(await screen.findByText(/已设为每天 200 条/)).toBeTruthy();
  });

  it('设成 0 = 关闭自定义目标（文案要说"关闭"，不能让用户以为设成了 0 条）', async () => {
    h.setGoal.mockResolvedValue({ count: 0, domains: [] });
    await mount();
    const input = screen.getByLabelText('每日复习目标条数') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/已关闭自定义目标/)).toBeTruthy();
  });

  it('★ 保存失败必须说出来，且控件恢复可用（能重试）', async () => {
    h.setGoal.mockRejectedValue(new h.ApiError('落库失败'));
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: '50' }));
    expect(await screen.findByText('落库失败')).toBeTruthy();
    // 按钮不能卡在禁用态，否则用户只能刷新页面
    await waitFor(() => expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
