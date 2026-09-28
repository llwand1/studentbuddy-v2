// @vitest-environment jsdom
/**
 * useSessionDraft：草稿按会话隔离——切走存、切回取、「无会话 → 新会话」带字过去。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useSessionDraft } from './useSessionDraft';

afterEach(cleanup);

function mount(sessionId: string | null, input: string) {
  const setInput = vi.fn();
  const r = renderHook(({ sid, inp }) => useSessionDraft(sid, inp, setInput), { initialProps: { sid: sessionId, inp: input } });
  return { ...r, setInput };
}

describe('useSessionDraft', () => {
  it('首次挂载与同会话重渲染都不动输入框', () => {
    const { rerender, setInput } = mount('a', '半句话');
    rerender({ sid: 'a', inp: '半句话继续打' });
    expect(setInput).not.toHaveBeenCalled();
  });

  it('A 打了半句切去 B：B 是空的；切回 A：半句话还在', () => {
    const { rerender, setInput } = mount('a', '半句话');
    rerender({ sid: 'b', inp: '半句话' });
    expect(setInput).toHaveBeenLastCalledWith('');
    rerender({ sid: 'b', inp: '给 B 的' });
    rerender({ sid: 'a', inp: '给 B 的' });
    expect(setInput).toHaveBeenLastCalledWith('半句话');
    rerender({ sid: 'a', inp: '半句话' });
    rerender({ sid: 'b', inp: '半句话' });
    expect(setInput).toHaveBeenLastCalledWith('给 B 的');
    expect(setInput).toHaveBeenCalledTimes(3);
  });

  it('无会话 → 新会话且输入框有字（建议卡先填字再开会话）：原样带过去，不被清空', () => {
    const { rerender, setInput } = mount(null, '把「向量数据库」讲清楚');
    rerender({ sid: 'new-1', inp: '把「向量数据库」讲清楚' });
    expect(setInput).not.toHaveBeenCalled();
  });

  it('无会话 → 新会话但输入框是空的：走普通规则（新会话没有草稿 ⇒ 空）', () => {
    const { rerender, setInput } = mount(null, '');
    rerender({ sid: 'new-1', inp: '' });
    expect(setInput).toHaveBeenCalledWith('');
  });

  it('切到从未去过的会话：拿到空串而不是 undefined', () => {
    const { rerender, setInput } = mount('a', 'x');
    rerender({ sid: 'never', inp: 'x' });
    expect(setInput).toHaveBeenCalledWith('');
  });
});
