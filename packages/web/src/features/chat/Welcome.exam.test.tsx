// @vitest-environment jsdom
/**
 * Welcome 的应试模式分支（契约 EXAM-MODE-SPEC §11）。
 * 单独一个文件：`useExamScope` 是模块级缓存，与通用文案那组用例放在同一文件里会互相污染
 * （第一例拉到的范围状态会留在缓存里，后面的"关着"断言就测不到关着）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../lib/api', () => ({
  api: {
    settings: {
      examMode: async () => ({
        on: true,
        scope: { packs: ['kaoyan'], custom: [] },
        summary: '考研',
        hosts: ['aipta.com', 'zhenti.zalize.com'],
        directSites: ['爱真题', '真题营'],
      }),
    },
  },
}));

const { Welcome } = await import('./Welcome');

afterEach(cleanup);

describe('welcome × 应试模式', () => {
  it('副标题说出当前范围，而不是通用的那句引导', async () => {
    render(<Welcome onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/范围＝考研/)).toBeTruthy());
    expect(screen.queryByText(/学 → 练 → 析 → 忆 → 反馈/)).toBeNull();
  });

  it('点「出一套题」发出去的那句带着范围，且不再让 AI 反问"你在学什么"', async () => {
    const pick = vi.fn();
    render(<Welcome onPick={pick} />);
    await waitFor(() => expect(screen.getByText(/范围＝考研/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /出一套题/ }));
    expect(pick).toHaveBeenCalledWith(expect.stringContaining('围绕考研出 3 道单选题'));
    expect(pick.mock.calls[0]?.[0]).not.toContain('不知道我在学什么');
  });

  it('四张卡都在（换的是提示语，不是砍掉入口）', async () => {
    render(<Welcome onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/范围＝考研/)).toBeTruthy());
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });
});
