// @vitest-environment jsdom
/**
 * ChatView.quickstart.test — 空会话直接开聊在 ChatView 的**接线锁**（契约 CHAT-UX-SPEC §2.9）。
 *
 * 改版前第一屏：输入框能打字发不出去、建议卡只把提示语填进输入框——得先去侧栏「新建对话」。
 * 这里锁用户能感知的那条链：点卡 / 回车 ⇒ 请 App 开会话 ⇒ 输入框不被占用、开会话中禁发 ⇒
 * 新会话 SSE 就绪后那一问**自动发出且只发一次**。暂存 / 重试 / 超时的分支在 `useQuickStart.test.ts`；
 * 桩与手势见 `ChatView.testkit.tsx`（与 `ChatView.test.tsx` 共用）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, cleanup } from '@testing-library/react';
import { apiStub, askStyleStub, docStub, grillSend, grillStub, quizStub, renderChatView, stream } from './ChatView.testkit';

vi.mock('../../lib/api', () => ({ api: apiStub }));
vi.mock('./useChatStream', () => ({ useChatStream: () => stream.current }));
vi.mock('./useGrillChoice', () => ({ useGrillChoice: grillStub }));
vi.mock('./useQuizActions', () => ({ useQuizActions: quizStub }));
vi.mock('./useDocMode', () => ({ useDocMode: docStub }));
vi.mock('./AskStyleCard', () => ({ useAskStyle: askStyleStub }));

const { ChatView } = await import('./ChatView');

afterEach(() => {
  cleanup();
  grillSend.mockClear();
});

const textarea = (c: HTMLElement) => c.querySelector('textarea') as HTMLTextAreaElement;
const sendBtn = (c: HTMLElement) => c.querySelector('.chat-send') as HTMLButtonElement;

describe('空会话直接开聊：ChatView 接线', () => {
  it('没会话点建议卡：开新会话、输入框不被占用，新会话就绪后提示语作为第一问自动发出（只发一次）', async () => {
    const { container, onNewSession, arrive } = renderChatView(ChatView);
    fireEvent.click(container.querySelector('.welcome-card')!);
    expect(onNewSession).toHaveBeenCalledTimes(1); // 无会话时点卡 ⇒ 请 App 开一间
    expect(textarea(container).value).toBe(''); // 不再填进输入框
    expect(grillSend).not.toHaveBeenCalled(); // 会话还没到，不能发
    expect(textarea(container).getAttribute('placeholder')).toBe('正在开新对话…');
    await arrive('s-new', { ready: 'connecting' });
    expect(grillSend).not.toHaveBeenCalled(); // 会话到了但 SSE 未就绪：还不发（send 的前置门不跳）
    await arrive('s-new', { ready: 'open' });
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toContain('向量数据库'); // 第一张卡「问个概念」的提示语就是第一问
    await arrive('s-new', { ready: 'open', busy: true }); // 发出后 busy 翻真 ⇒ 不重复发
    expect(grillSend).toHaveBeenCalledTimes(1);
  });

  it('没会话在输入框里直接发：Enter ⇒ 开新会话 + 就绪后发出；开会话期间禁发（连按不开两间）', async () => {
    const { container, onNewSession, arrive } = renderChatView(ChatView);
    const ta = textarea(container);
    expect(sendBtn(container).hasAttribute('disabled')).toBe(true); // 空白输入禁发
    fireEvent.change(ta, { target: { value: '什么是闭包' } });
    expect(sendBtn(container).hasAttribute('disabled')).toBe(false); // 没会话也放行：发送即开新对话
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe(''); // 这一问已暂存，输入框清空
    fireEvent.change(ta, { target: { value: '再来一句' } });
    expect(sendBtn(container).hasAttribute('disabled')).toBe(true); // 开会话中禁发
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onNewSession).toHaveBeenCalledTimes(1); // 连按不开第二间
    await arrive('s-new', { ready: 'open' });
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toBe('什么是闭包');
  });

  it('已有（空）会话点建议卡：直接发出提示语，不开新会话、不填输入框', () => {
    const { container, onNewSession } = renderChatView(ChatView, { sessionId: 's1' });
    fireEvent.click(container.querySelector('.welcome-card')!);
    expect(onNewSession).not.toHaveBeenCalled();
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toContain('向量数据库');
    expect(textarea(container).value).toBe('');
  });
});
