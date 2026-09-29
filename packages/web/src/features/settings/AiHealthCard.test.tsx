// @vitest-environment jsdom
/**
 * AiHealthCard — 设置页「AI 运行状况」：汇总与失败原因的中文呈现、失败任务的重试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  stats: vi.fn(),
  jobs: vi.fn(),
  retryJob: vi.fn(),
}));
vi.mock('../../lib/api-ai-ops', () => ({ aiOpsApi: api }));

const { AiHealthCard, reasonLabel } = await import('./AiHealthCard');

const STATS = {
  days: 7, calls: 4, ok: 3,
  purposes: [{ purpose: 'quiz.generate', label: '出题', version: 2, calls: 4, ok: 3, failures: { timeout: 1 }, p50Ms: 800, p95Ms: 4200, tokens: 100 }],
  recentFailures: [{ purpose: 'quiz.generate', label: '出题', status: 'timeout', error: '180 秒没回', at: '' }],
};
const JOBS = {
  jobs: [{ id: 'j1', kind: 'chat.post_turn', label: '对话后抽词与记忆压缩', status: 'failed', attempts: 3, maxAttempts: 3, lastError: '上游 502', createdAt: '', updatedAt: '' }],
  counts: { queued: 0, running: 0, done: 5, failed: 1 },
};

beforeEach(() => {
  api.stats.mockResolvedValue(STATS);
  api.jobs.mockResolvedValue(JOBS);
  api.retryJob.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiHealthCard', () => {
  it('按用途列成功率、分位耗时，失败原因用中文', async () => {
    render(<AiHealthCard flash={() => undefined} />);
    expect(await screen.findByText('出题')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('800ms / 4.2s')).toBeTruthy();
    expect(screen.getByText('超时 1')).toBeTruthy();
    expect(screen.getByText(/共 4 次调用，成功 75%/)).toBeTruthy();
  });

  it('★ 失败任务可重试：点了就调接口、提示、重新拉取', async () => {
    const flash = vi.fn();
    render(<AiHealthCard flash={flash} />);
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(api.retryJob).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(flash).toHaveBeenCalledWith(true, '已重新排队'));
    expect(api.stats).toHaveBeenCalledTimes(2);
  });

  it('★ 父组件每次渲染换一个 flash 也不会反复拉取', async () => {
    const { rerender } = render(<AiHealthCard flash={() => undefined} />);
    await screen.findByText('出题');
    rerender(<AiHealthCard flash={() => undefined} />);
    rerender(<AiHealthCard flash={() => undefined} />);
    expect(api.stats).toHaveBeenCalledTimes(1);
  });

  it('没有调用记录时给空态；未知原因原样显示', async () => {
    api.stats.mockResolvedValue({ days: 7, calls: 0, ok: 0, purposes: [], recentFailures: [] });
    api.jobs.mockResolvedValue({ jobs: [], counts: { queued: 0, running: 0, done: 0, failed: 0 } });
    render(<AiHealthCard flash={() => undefined} />);
    expect(await screen.findByText('近 7 天没有 AI 调用记录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(reasonLabel('weird')).toBe('weird');
  });
});
