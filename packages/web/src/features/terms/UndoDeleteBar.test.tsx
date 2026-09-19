// @vitest-environment jsdom
/**
 * UndoDeleteBar.test — 撤销条的渲染与动作锁（契约 TOOL-ECOSYSTEM-SPEC §4.5，P3 拍板⑯）。
 *
 * 锁三条用户能感知的口径：
 * ① 无批次**整条不渲染**（有批次才出现，不是常驻噪音）；
 * ② 「谁动的手」必须点名：AI 工具给工具名、UI 手滑说「你手动删除」（拍板⑯把 UI 纳入撤销范围）；
 * ③ 部分冲突如实报——「还原 X 条，Y 条撞名未动」，服务端跳过的条不许在前端被说成全撤回来了。
 * 时间人话（batchAgeText）给显式 now 测，不吃系统时钟。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { UndoableBatch } from '../../lib/api-tools';

const apiMock = {
  undoableBatches: vi.fn(),
  undoDelete: vi.fn(),
};
vi.mock('../../lib/api', () => ({ api: { terms: apiMock } }));

const { UndoDeleteBar, batchAgeText, batchActorText } = await import('./UndoDeleteBar');

function batch(over: Partial<UndoableBatch> = {}): UndoableBatch {
  return {
    batch: 'b1',
    count: 2,
    actor: 'ai_tool',
    tool: 'delete_terms',
    createdAt: '2026-09-19 05:00:00',
    ...over,
  };
}

function setup(flash = vi.fn()) {
  render(<UndoDeleteBar onChanged={async () => {}} flash={flash} />);
  return flash;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('batchAgeText / batchActorText（纯函数）', () => {
  const now = new Date('2026-09-19T05:30:00Z');
  it('分钟/小时/跨天三档 + 坏值空串', () => {
    expect(batchAgeText('2026-09-19 05:29:30', now)).toBe('刚刚');
    expect(batchAgeText('2026-09-19 05:25:00', now)).toBe('5 分钟前');
    expect(batchAgeText('2026-09-19 03:30:00', now)).toBe('2 小时前');
    expect(batchAgeText('not-a-date', now)).toBe('');
  });
  it('AI 点名到工具，UI 手滑说人话（拍板⑯）', () => {
    expect(batchActorText(batch())).toBe('AI 经 delete_terms 删除');
    expect(batchActorText(batch({ actor: 'ui', tool: null }))).toBe('你手动删除');
  });
});

describe('撤销条渲染与动作', () => {
  it('无批次 → 整条不渲染', async () => {
    apiMock.undoableBatches.mockResolvedValue([]);
    const { container } = render(<UndoDeleteBar onChanged={async () => {}} flash={vi.fn()} />);
    await waitFor(() => expect(apiMock.undoableBatches).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('一批次一行：谁删的 + 几条 + 「撤销这 N 条」按钮', async () => {
    apiMock.undoableBatches.mockResolvedValue([batch()]);
    setup();
    await waitFor(() => expect(document.body.textContent).toContain('撤销这 2 条'));
    expect(document.body.textContent).toContain('AI 经 delete_terms 删除');
  });

  it('撤销回执带冲突数时如实念，并回拉批次清单', async () => {
    apiMock.undoableBatches.mockResolvedValue([batch()]);
    apiMock.undoDelete.mockResolvedValue({ restored: 1, conflicts: ['闭包'] });
    const flash = setup();
    await waitFor(() => expect(document.body.textContent).toContain('撤销这 2 条'));
    fireEvent.click(document.querySelector('.term-undo-row button')!);
    await waitFor(() => expect(flash).toHaveBeenCalledWith('已撤销：还原 1 条，1 条撞名未动'));
    expect(apiMock.undoDelete).toHaveBeenCalledWith('b1');
  });

  it('超过 3 批只浮最近 3 条并如实报剩余数（截展示不截数据）', async () => {
    apiMock.undoableBatches.mockResolvedValue([
      batch({ batch: 'b1' }),
      batch({ batch: 'b2' }),
      batch({ batch: 'b3' }),
      batch({ batch: 'b4' }),
    ]);
    setup();
    await waitFor(() => expect(document.body.textContent).toContain('更早还有 1 个批次未列出'));
    expect(document.querySelectorAll('.term-undo-row')).toHaveLength(3);
  });
});
