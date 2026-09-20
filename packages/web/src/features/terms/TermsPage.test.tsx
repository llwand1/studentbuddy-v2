// @vitest-environment jsdom
/**
 * TermsPage.test — 词条库页的核心交互回归锁（方案 A 第②项：jsdom 扩到 TermsPage）。
 *
 * 本页是 B-008 布局炸过的页，且偏科分析显示此前只有 `UndoDeleteBar` 单点覆盖。
 * 这里锁的是**用户能感知的手势路径**（老数据在 `./terms.ts` 已测，前端锁定「屏幕上的东西真的出来」）：
 * 空态文案、列表与统计渲染、搜索过滤真打到 list、添加/编辑/删除、复习范围开关真打到 scopeTerm、
 * 偏好领域 chip 可一键切换领域。api.terms 全 mock；`ReviewPanel`/`UndoDeleteBar` 归各自文件
 * 自己测，这里空白化避免把两边的 api 联动摊进本文件。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react';
import type { TermItem } from '../../lib/api';

const apiMock = {
  domains: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  scopeTerm: vi.fn(),
};
vi.mock('../../lib/api', () => ({ api: { terms: apiMock } }));
// ReviewPanel / UndoDeleteBar 各自文件已有补位，这里空白化避免双份 api 联动。
vi.mock('./ReviewPanel', () => ({ ReviewPanel: () => null }));
vi.mock('./UndoDeleteBar', () => ({ UndoDeleteBar: () => null }));

const { TermsPage } = await import('./TermsPage');

function stats(over: Record<string, unknown> = {}) {
  return {
    total: 1,
    domains: [{ domain: 'all', num: 0 }],
    today: 1,
    preferred: [],
    ...over,
  };
}

function makeTerm(over: Partial<TermItem> = {}): TermItem {
  return {
    id: 't1',
    term: '闭包',
    domain: 'js',
    definition: '函数与其词法环境的组合',
    aliases: ['closure'],
    usage_count: 3,
    importance: 0.8,
    last_used_at: null,
    review_in_scope: 0,
    review_enabled: null,
    last_reviewed_at: null,
    created_at: '2026-09-20 10:00:00',
    review_stage: 0,
    source_session_id: null,
    source_title: null,
    updated_at: '2026-09-20 10:00:00',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TermsPage 浏览与统计', () => {
  it('空态：词条库还是空的，不渲染列表项', async () => {
    apiMock.domains.mockResolvedValue(stats({ total: 0, domains: [], today: 0 }));
    apiMock.list.mockResolvedValue([]);
    render(<TermsPage />);
    await waitFor(() => expect(apiMock.list).toHaveBeenCalled());
    expect(screen.getByText('词条库还是空的')).toBeTruthy();
    expect(document.querySelectorAll('.term-item').length).toBe(0);
  });

  it('列表与统计同屏：总数/领域数/今日新增 + 词条行含主词名与别名', async () => {
    apiMock.domains.mockResolvedValue(stats({ domains: [{ domain: 'all', num: 1 }, { domain: 'js', num: 1 }] }));
    apiMock.list.mockResolvedValue([makeTerm()]);
    render(<TermsPage />);
    await waitFor(() => expect(screen.getByText('闭包')).toBeTruthy());
    expect(screen.getByText('闭包').parentElement!.textContent).toContain('别名 closure');
    expect(screen.getByText(/已在对话中使用 3 次/)).toBeTruthy();
  });

  it('搜索过滤：输入搜词真打到 list（带 keyword），结果随之换', async () => {
    apiMock.domains.mockResolvedValue(stats());
    apiMock.list.mockResolvedValue([makeTerm()]);
    render(<TermsPage />);
    await waitFor(() => expect(apiMock.list).toHaveBeenCalledWith('all', undefined));
    const input = screen.getByPlaceholderText('搜词条…');
    fireEvent.change(input, { target: { value: 'clos' } });
    await waitFor(() => expect(apiMock.list).toHaveBeenCalledWith('all', 'clos'));
  });

  it('偏好领域 chip 一键切换领域：点了当前领域变该 chip、list 带 domain 重新拉', async () => {
    apiMock.domains.mockResolvedValue(stats({ preferred: [{ domain: '计算机网络', mentionCount: 12 }] }));
    apiMock.list.mockResolvedValue([makeTerm()]);
    render(<TermsPage />);
    await waitFor(() => expect(screen.getByText('计算机网络')).toBeTruthy());
    fireEvent.click(screen.getByText('计算机网络'));
    await waitFor(() => expect(apiMock.list).toHaveBeenCalledWith('计算机网络', undefined));
    expect(screen.getByText('计算机网络').className).toContain('on');
  });
});

describe('TermsPage 词条动作', () => {
  it('添加：术语/释义齐了才放行，点「添加」打 API 并清空输入', async () => {
    apiMock.domains.mockResolvedValue(stats());
    apiMock.list.mockResolvedValue([]);
    apiMock.add.mockResolvedValue(undefined);
    render(<TermsPage />);
    await waitFor(() => expect(apiMock.list).toHaveBeenCalledTimes(1));
    const term = screen.getByPlaceholderText('词条（如 closure / 二重积分）');
    const def = screen.getByPlaceholderText('释义');
    const btn = screen.getByText('添加').closest('button')!;
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(term, { target: { value: '迭代器' } });
    fireEvent.change(def, { target: { value: '一个惰性求值的集合访问对象' } });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock.add).toHaveBeenCalledWith('迭代器', '一个惰性求值的集合访问对象', undefined));
  });

  it('编辑：点编辑进态 → 改释义保存 → 打 update(id, {definition, domain})', async () => {
    apiMock.domains.mockResolvedValue(stats());
    apiMock.list.mockResolvedValue([makeTerm()]);
    apiMock.update.mockResolvedValue(undefined);
    render(<TermsPage />);
    await waitFor(() => expect(screen.getByText('闭包')).toBeTruthy());
    fireEvent.click(screen.getByText('编辑'));
    const defBox = document.querySelector('.term-edit textarea') as HTMLTextAreaElement;
    expect(defBox).toBeTruthy();
    fireEvent.change(defBox, { target: { value: '新释义' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(apiMock.update).toHaveBeenCalledWith('t1', { definition: '新释义', domain: 'js' }));
  });

  it('复习范围开关：未纳入显示「纳入复习」，点了真打 scopeTerm(id,true) 并换文案', async () => {
    apiMock.domains.mockResolvedValue(stats());
    apiMock.list.mockResolvedValue([makeTerm()]);
    render(<TermsPage />);
    await waitFor(() => expect(screen.getByText('纳入复习')).toBeTruthy());
    fireEvent.click(screen.getByText('纳入复习'));
    await waitFor(() => expect(apiMock.scopeTerm).toHaveBeenCalledWith('t1', true));
    await waitFor(() => expect(screen.getByText(/已纳入复习范围/)).toBeTruthy());
  });

  it('删除：点删除打 remove(id)，列表回拉腾出空态', async () => {
    apiMock.domains.mockResolvedValue(stats());
    apiMock.list.mockResolvedValueOnce([makeTerm()]).mockResolvedValueOnce([]);
    apiMock.remove.mockResolvedValue(undefined);
    render(<TermsPage />);
    await waitFor(() => expect(screen.getByText('闭包')).toBeTruthy());
    fireEvent.click(screen.getByText('删除'));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.getByText('词条库还是空的')).toBeTruthy());
  });
});
