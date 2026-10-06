// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, render, fireEvent, screen, cleanup } from '@testing-library/react';
import type { AskChoiceRecord } from '@sb/shared';
import { useGrillChoice } from './useGrillChoice';
import { GrillPill } from './GrillPill';
vi.mock('../exam/useExamScope', () => ({ useExamScope: () => ({ on: true, hosts: 3, loaded: true, summary: '考研' }) }));
afterEach(cleanup);
function deps(sessionId: string | null = 'a') {
  return { sessionId, pendingChoice: null as AskChoiceRecord | null, replyChoice: vi.fn(), skipChoice: vi.fn(),
    send: vi.fn(async () => ({ ok: true })), regenerate: vi.fn(async () => ({ ok: true })), resend: vi.fn(async () => ({ ok: true })) };
}
describe('GrillMe 范围选择与每轮接线', () => {
  it('普通对话不附带学习范围，打开后发送/重新生成/编辑重发均携带当前选择', async () => {
    const d = deps(), h = renderHook(() => useGrillChoice(d));
    await h.result.current.sendWithGrill('普通'); expect(d.send).toHaveBeenLastCalledWith('普通', undefined, false);
    act(() => { h.result.current.composerProps.setGrillMe(true); h.result.current.composerProps.setGrillScope({ kind: 'custom', topic: '  概率论 ' }); });
    await h.result.current.sendWithGrill('讲讲'); await h.result.current.regenerate(); await h.result.current.resend('再讲讲');
    const scope = { kind: 'custom', topic: '概率论' };
    expect(d.send).toHaveBeenLastCalledWith('讲讲', undefined, true, scope);
    expect(d.regenerate).toHaveBeenCalledWith(true, scope); expect(d.resend).toHaveBeenCalledWith('再讲讲', true, scope);
  });
  it('自定义主题为空，在任何发送或重跑副作用前给出错误', async () => {
    const d = deps(), h = renderHook(() => useGrillChoice(d));
    act(() => { h.result.current.composerProps.setGrillMe(true); h.result.current.composerProps.setGrillScope({ kind: 'custom', topic: ' ' }); });
    expect((await h.result.current.sendWithGrill('学')).ok).toBe(false);
    expect((await h.result.current.regenerate()).ok).toBe(false); expect((await h.result.current.resend('学')).ok).toBe(false);
    expect(d.send).not.toHaveBeenCalled(); expect(d.regenerate).not.toHaveBeenCalled(); expect(d.resend).not.toHaveBeenCalled();
  });
  it('空入口首次建会话保留范围，切到另一会话重置', () => {
    const d = deps(null), h = renderHook(({ sid }: { sid: string | null }) => useGrillChoice({ ...d, sessionId: sid }), { initialProps: { sid: null as string | null } });
    act(() => { h.result.current.composerProps.setGrillMe(true); h.result.current.composerProps.setGrillScope({ kind: 'exam' }); });
    h.rerender({ sid: 'new' }); expect(h.result.current.composerProps.grillScope.kind).toBe('exam'); expect(h.result.current.composerProps.grillMe).toBe(true);
    h.rerender({ sid: 'other' }); expect(h.result.current.composerProps.grillScope.kind).toBe('conversation'); expect(h.result.current.composerProps.grillMe).toBe(false);
  });
  it('收尾卡点选开新一轮，范围也随之发送', async () => {
    const d = deps(); d.pendingChoice = { id: 'c', sessionId: 'a', question: '继续？', options: [{ id: 'o1', label: '做两题' }], allowCustom: false, multi: false, grillPhase: 'post', ts: Date.now(), status: 'pending', reply: null, answeredAt: null };
    const h = renderHook(() => useGrillChoice(d));
    act(() => { h.result.current.composerProps.setGrillMe(true); h.result.current.composerProps.setGrillScope({ kind: 'exam' }); });
    render(h.result.current.grillNode); fireEvent.click(screen.getByText('做两题'));
    await act(async () => {});
    expect(d.replyChoice).toHaveBeenCalledWith('c', { optionId: 'o1' }); expect(d.send).toHaveBeenCalledWith('做两题', undefined, true, { kind: 'exam' });
  });
  it('像素提示条提供三项选择与主题输入；忙碌时无法切换', () => {
    const change = vi.fn(), close = vi.fn(), r = render(<GrillPill scope={{ kind: 'exam' }} onScopeChange={change} onClose={close} />);
    expect(screen.getAllByRole('option')).toHaveLength(3); expect(screen.getByText('考研')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('GrillMe 学习范围'), { target: { value: 'custom' } }); expect(change).toHaveBeenCalledWith({ kind: 'custom', topic: '' });
    r.rerender(<GrillPill scope={{ kind: 'custom', topic: '线代' }} onScopeChange={change} disabled onClose={close} />);
    expect((screen.getByLabelText('自定义学习主题') as HTMLInputElement).maxLength).toBe(160);
    expect((screen.getByLabelText('GrillMe 学习范围') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('关闭')); expect(close).not.toHaveBeenCalled();
  });
});
