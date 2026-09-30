// @vitest-environment jsdom
/**
 * ChatView.test — 对话主视图的合规渲染回归锁（方案 A 第②项：jsdom 扩到 ChatView）。
 *
 * ChatView 是全仓最高频、最缺 jsdom 覆盖的视图；它把 useChatStream 的状态条件翻译成 DOM，
 * 这一层写错（if 边界、文案给错、按钮态）**不会有任何运行时错误**，正是偏科分析里
 * 「UI 假死无感区」。这里 mock 掉五个私密 hook（useChatStream/useGrillChoice/useQuizActions/
 * useDocMode/useAskStyle）返回固定状态，锁**用户能感知的结构**：空会话合规渲染 Welcome，即是
 * 新用户第一屏的完整体验（点建议卡 / 输入框直接发 ⇒ 开会话并自动发出的接线，2026-09-30 起在
 * `ChatView.quickstart.test.tsx`，CHAT-UX §2.9）。hook 内部逻辑与其真实返回由各自文件另有补位，此处不重复。
 * 桩与手势在 `ChatView.testkit.tsx`（与 quickstart 那份共用，`vi.mock` 按文件提升所以留在这里）。
 *
 * 2026-09-25 追加：对战邀请卡（PK-SPEC §16）的**挂线锁**。它是这层最容易无声断掉的东西——
 * ChatView 少写一行 `{pkInvite.invite && <PkInviteCard …/>}`，服务端、SSE、hook 全都是绿的，
 * 只有用户看不见卡。所以这里不测卡本身（`PkInviteCard.test.tsx` 管），只测"它出现在哪、什么时候出现"。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import type { PkInviteRecord } from '@sb/shared';
import type { PkInviteQueue } from './usePkInviteQueue';
import { apiStub, askStyleStub, docStub, emptyStream, grillStub, quizStub, renderChatView, stream } from './ChatView.testkit';

vi.mock('../../lib/api', () => ({ api: apiStub }));
vi.mock('./useChatStream', () => ({ useChatStream: () => stream.current }));
vi.mock('./useGrillChoice', () => ({ useGrillChoice: grillStub }));
vi.mock('./useQuizActions', () => ({ useQuizActions: quizStub }));
vi.mock('./useDocMode', () => ({ useDocMode: docStub }));
vi.mock('./AskStyleCard', () => ({ useAskStyle: askStyleStub }));

const { ChatView } = await import('./ChatView');

afterEach(cleanup);

const setup = (onNewSession = vi.fn(), over: Record<string, unknown> = {}) => renderChatView(ChatView, { onNewSession, over });

describe('ChatView 空会话合规渲染', () => {
  it('没会话且无消息 → 渲染 Welcome（新用户第一屏该看到什么）', () => {
    const { container } = setup();
    expect(container.querySelector('.welcome')).toBeTruthy();
    expect(container.textContent).toContain('今天想学点什么？');
    expect(container.textContent).toContain('学 → 练 → 析 → 忆 → 反馈');
  });

  it('轮次元信息 / 工具 / 等待态在空态一概不渲染（不出现「0 tokens」废话）', () => {
    const { container } = setup();
    expect(container.querySelector('.chat-round-meta')).toBeNull();
    expect(container.querySelector('.tool-steps')).toBeNull();
    expect(container.querySelector('.thinking')).toBeNull();
  });
});

// ── 对战邀请卡的挂线（PK-SPEC §16，2026-09-25）────────────────────────

describe('对战邀请卡在 ChatView 的挂线', () => {
  const invite = (over: Partial<PkInviteRecord> = {}): PkInviteRecord => ({
    id: 'i1',
    sessionId: 's1',
    ownerId: null,
    topic: '牛顿第二定律',
    reason: '这块你已经推了两轮，值得打一局验一下',
    status: 'pending',
    roomId: null,
    createdAt: 1_000,
    ...over,
  });

  it('无卡 ⇒ 一张都不渲染（空会话第一屏不许凭空挂着邀请）', () => {
    const { container } = setup();
    expect(container.querySelector('.pk-invite')).toBeNull();
  });

  it('有卡 ⇒ 渲染出来，认的是这一局的主题', () => {
    const pkInvite: PkInviteQueue = { ...emptyStream.pkInvite, invite: invite() };
    const { container } = setup(vi.fn(), { pkInvite });
    const card = container.querySelector('.pk-invite');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('牛顿第二定律');
  });

  it('★ 位置：在消息流**外面**、composer **上面**（它是浮层，不跟着这一轮滚走）', () => {
    const pkInvite: PkInviteQueue = { ...emptyStream.pkInvite, invite: invite() };
    const { container } = setup(vi.fn(), { pkInvite });
    const card = container.querySelector('.pk-invite')!;
    expect(card.closest('.chat-scroll')).toBeNull();
    // 两层同壳（左右留白/最大宽度对齐），邀请卡那层排在 composer 那层之前
    const wraps = container.querySelectorAll('.chat-composer-wrap');
    expect(wraps).toHaveLength(2);
    expect(wraps[0]?.contains(card)).toBe(true);
    expect(wraps[1]?.contains(container.querySelector('.chat-composer'))).toBe(true);
  });
});

// ── 篝火对谈换装的挂线（2026-09-28）──────────────────────────────────
// 皮全在 CSS，这里只锁「结构真的挂上了」：铭牌头 / 说话者铭牌 / 勇者 symbol 只定义一份——
// 少写一行 <ChatSpeakerDefs/>，铭牌、样式、测试全绿，只有勇者头像是空框。

describe('篝火对谈：铭牌头与说话者铭牌在 ChatView 的挂线', () => {
  const msgs = [
    { role: 'user' as const, content: '闭包是什么' },
    { role: 'assistant' as const, content: '闭包＝函数 + 词法环境。' },
  ];

  it('空会话：不挂铭牌头（欢迎页自带角标），但勇者 symbol 已经定义好一份', () => {
    const { container } = setup();
    expect(container.querySelector('.chat-head')).toBeNull();
    expect(container.querySelectorAll('symbol#ch-hero-sprite')).toHaveLength(1);
  });

  it('有消息：铭牌头带会话标题与轮数；每条消息一枚铭牌，用户侧只 <use> 那一份勇者', () => {
    stream.current = { ...emptyStream, messages: msgs };
    const { container } = render(
      <ChatView sessionId="s1" sessionTitle="闭包是什么" onNewSession={vi.fn()} onRoundDone={() => {}} onBusyChange={() => {}} />,
    );
    const head = container.querySelector('.chat-head');
    expect(head?.querySelector('.chat-head-title')?.textContent).toBe('闭包是什么');
    expect(head?.querySelector('.chat-head-rounds')?.textContent).toBe('1 轮');
    expect(container.querySelectorAll('.chat-speaker.user')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-speaker.assistant')).toHaveLength(1);
    expect(container.querySelectorAll('symbol#ch-hero-sprite')).toHaveLength(1);
    expect(container.querySelector('.chat-speaker.user use')?.getAttribute('href')).toBe('#ch-hero-sprite');
    // 勇者的 104 个 rect 只存在于 symbol 里，铭牌里不再复制一份
    expect(container.querySelectorAll('.chat-speaker.user rect')).toHaveLength(0);
  });

  it('没有标题的会话回落「新对话」；只有题卡没有提问时不挂「0 轮」', () => {
    stream.current = {
      ...emptyStream,
      messages: [{ role: 'assistant' as const, content: '', quizBlock: { blockId: 'b1', quiz: { title: '练习', questions: [] } } }],
    };
    const { container } = render(
      <ChatView sessionId="s1" onNewSession={vi.fn()} onRoundDone={() => {}} onBusyChange={() => {}} />,
    );
    expect(container.querySelector('.chat-head-title')?.textContent).toBe('新对话');
    expect(container.querySelector('.chat-head-rounds')).toBeNull();
  });
});

describe('对话体验：错误重试 / 发送后焦点 / 引用追问挂线', () => {
  const user = { role: 'user' as const, content: '闭包是什么' };
  const mount = (over: Record<string, unknown>) => {
    stream.current = { ...emptyStream, ...over };
    return render(<ChatView sessionId="s1" onNewSession={vi.fn()} onRoundDone={() => {}} onBusyChange={() => {}} />);
  };

  it('流式中断（chat-error 帧）：错误条带「↻ 重试」，点了走 regenerate（对最后一问重新生成）', () => {
    const regenerate = vi.fn(async () => ({ ok: true, error: null }));
    const { container } = mount({ messages: [user], error: '生成失败：上游超时', regenerate });
    const bar = container.querySelector('.chat-error');
    expect(bar?.textContent).toContain('生成失败：上游超时');
    const retry = bar?.querySelector('.chat-error-retry') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('生成中不给重试（已经在跑）；没有可重跑的提问（会话里没有 user）也不给', () => {
    const busyView = mount({ messages: [user], error: '已停止', busy: true });
    expect(busyView.container.querySelector('.chat-error-retry')).toBeNull();
    cleanup();
    const noUser = mount({ messages: [], error: '生成失败' });
    expect(noUser.container.querySelector('.chat-error')).toBeTruthy();
    expect(noUser.container.querySelector('.chat-error-retry')).toBeNull();
  });

  it('点发送按钮后焦点留在输入框（下一句直接打，不用再点回来）', () => {
    const { container } = mount({ messages: [user] });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '再举个例子' } });
    fireEvent.click(container.querySelector('.chat-send') as HTMLButtonElement);
    expect(document.activeElement).toBe(ta);
  });

  it('引用追问：选中助手正文 → 浮出小牌 → 点击后引用块进输入框并聚焦', () => {
    vi.useFakeTimers();
    Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect; // jsdom 未实现
    const { container } = mount({ messages: [user, { role: 'assistant' as const, content: '闭包＝函数 + 词法环境。' }] });
    const bubble = container.querySelector('.chat-row:not(.user) .chat-bubble.md') as HTMLElement;
    const textNode = bubble.querySelector('p')?.firstChild ?? bubble.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 2);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(200);
    });
    const btn = container.querySelector('.chat-quote-btn') as HTMLButtonElement;
    expect(btn?.textContent).toContain('引用追问');
    fireEvent.click(btn);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('> 闭包\n\n');
    expect(document.activeElement).toBe(ta);
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
    vi.useRealTimers();
  });
});
