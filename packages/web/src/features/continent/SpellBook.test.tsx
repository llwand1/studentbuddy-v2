// @vitest-environment jsdom
/**
 * SpellBook.test — 咒语书的死路锁（契约 `docs/SPELL-CHANT-SPEC.md` §3.2）。
 *
 * ★ 三条静默死路：① 列表空 / 取数失败没字；② 选了一本空咒语（没有文字提问也没有可判分题卡）没反应；
 *   ③ 选中后没把**按对话页口径还原**的题卡带进去。这里 `api.sessions` 全桩、`planSpell` 走真的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sessionsMock = { list: vi.fn(), messages: vi.fn() };
vi.mock('../../lib/api', () => ({ api: { sessions: sessionsMock } }));

const { SpellBook } = await import('./SpellBook');

afterEach(() => {
  cleanup();
  sessionsMock.list.mockReset();
  sessionsMock.messages.mockReset();
});

const sessions = [
  { id: 'a', title: '聊闭包', pinned: false, createdAt: '2026-09-20 01:00:00', updatedAt: '2026-09-20 01:00:00' },
  { id: 'b', title: '空的那次', pinned: false, createdAt: '2026-09-21 01:00:00', updatedAt: '2026-09-21 01:00:00' },
];

describe('咒语书', () => {
  it('列出会话；选中后按对话页口径切节并回传；空咒语就地说明且不回传', async () => {
    sessionsMock.list.mockResolvedValue(sessions);
    sessionsMock.messages.mockImplementation(async (id: string) =>
      id === 'a'
        ? [
            { id: '1', role: 'user', content: '什么是闭包？', created_at: '2026-09-20 01:00:00' },
            { id: '2', role: 'assistant', content: '闭包是函数与词法环境的组合。', created_at: '2026-09-20 01:00:01' },
          ]
        : [{ id: '3', role: 'assistant', content: '只有 AI 的独白', created_at: '2026-09-21 01:00:00' }],
    );
    const onPick = vi.fn();
    render(<SpellBook term="闭包" onPick={onPick} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('聊闭包')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /空的那次/ }));
    await waitFor(() => expect(screen.getByText(/这本咒语是空的/)).toBeTruthy());
    expect(onPick).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /空的那次/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /聊闭包/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const [plan, session] = onPick.mock.calls[0] as [{ verses: unknown[]; resonant: boolean }, { id: string }];
    expect(session.id).toBe('a');
    expect(plan.verses).toHaveLength(1);
    expect(plan.resonant).toBe(true);
  });

  it('没有会话 ⇒ 引导去对话页；取数失败 ⇒ 原样念出并可重试', async () => {
    sessionsMock.list.mockResolvedValueOnce([]);
    render(<SpellBook term="闭包" onPick={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/咒语书还是空白的/)).toBeTruthy());
    cleanup();

    sessionsMock.list.mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(sessions);
    render(<SpellBook term="闭包" onPick={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/咒语书翻不开：连接中断/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('聊闭包')).toBeTruthy());
  });

  it('翻开某一本失败 ⇒ 说明原因，其余本仍可选', async () => {
    sessionsMock.list.mockResolvedValue(sessions);
    sessionsMock.messages.mockRejectedValueOnce(new Error('读不到消息'));
    render(<SpellBook term="闭包" onPick={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('聊闭包')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /聊闭包/ }));
    await waitFor(() => expect(screen.getByText(/翻开这本咒语失败：读不到消息/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /聊闭包/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
