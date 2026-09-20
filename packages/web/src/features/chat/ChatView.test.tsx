// @vitest-environment jsdom
/**
 * ChatView.test — 对话主视图的合规渲染回归锁（方案 A 第②项：jsdom 扩到 ChatView）。
 *
 * ChatView 是全仓最高频、最缺 jsdom 覆盖的视图；它把 useChatStream 的状态条件翻译成 DOM，
 * 这一层写错（if 边界、文案给错、按钮态）**不会有任何运行时错误**，正是偏科分析里
 * 「UI 假死无感区」。这里 mock 掉五个私密 hook（useChatStream/useGrillChoice/useQuizActions/
 * useDocMode/useAskStyle）返回固定状态，锁**用户能感知的结构**：空会话合规渲染 Welcome，
 * 点一张建议卡把提示语填进输入框（不直接发送，避免误触烧 token）并顺手开新会话，即是
 * 新用户第一屏的完整体验。hook 内部逻辑与其真实返回由各自文件另有补位，此处不重复。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ChatView } from './ChatView';

vi.mock('../../lib/api', () => ({
  api: { settings: { quizMix: vi.fn().mockResolvedValue({ mix: {} }) } },
}));

const emptyStream = {
  messages: [],
  streamingText: '',
  reasoning: '',
  steps: [],
  tasks: [],
  busy: false,
  ready: 'open',
  error: '',
  usage: null,
  elapsedMs: 0,
  startedAtMs: 0,
  send: vi.fn(async () => ({ ok: true, error: null })),
  stop: vi.fn(),
  regenerate: vi.fn(async () => ({ ok: true, error: null })),
  resend: vi.fn(async () => ({ ok: true, error: null })),
  pendingChoice: null,
  replyChoice: vi.fn(),
  dismissChoice: vi.fn(),
  skipChoice: vi.fn(),
  pendingConfirm: null,
  confirmNowMs: 0,
  replyConfirm: vi.fn(),
  dismissConfirm: vi.fn(),
};

vi.mock('./useChatStream', () => ({ useChatStream: () => emptyStream }));
vi.mock('./useGrillChoice', () => ({
  useGrillChoice: () => ({
    composerProps: { grillMe: false, setGrillMe: () => {} },
    grillNode: null,
    sendWithGrill: async () => ({ ok: true, error: null }),
  }),
}));
vi.mock('./useQuizActions', () => ({
  useQuizActions: () => ({
    quizzing: false,
    scenarioing: false,
    quizNote: '',
    quizRefs: [],
    runQuiz: vi.fn(),
    runScenario: vi.fn(),
    resetRound: vi.fn(),
  }),
}));
vi.mock('./useDocMode', () => ({
  useDocMode: () => ({
    meta: null,
    dn: null,
    name: '',
    setName: () => {},
    text: '',
    setText: () => {},
    busy: false,
    hint: '',
    overCap: false,
    submit: async () => {},
    onPickFile: async () => {},
    clear: async () => {},
  }),
}));
vi.mock('./AskStyleCard', () => ({ useAskStyle: () => ({ summary: '', hint: '', card: null, tap: vi.fn() }) }));

afterEach(cleanup);

function setup(onNewSession = vi.fn()) {
  const r = render(
    <ChatView sessionId={null} onNewSession={onNewSession} onRoundDone={() => {}} onBusyChange={() => {}} />,
  );
  return { ...r, onNewSession };
}

describe('ChatView 空会话合规渲染', () => {
  it('没会话且无消息 → 渲染 Welcome（新用户第一屏该看到什么）', () => {
    const { container } = setup();
    expect(container.querySelector('.welcome')).toBeTruthy();
    expect(container.textContent).toContain('今天想学点什么？');
    expect(container.textContent).toContain('学 → 练 → 析 → 忆 → 反馈');
  });

  it('点一张建议卡：提示语填进输入框（不发送）且顺手开新会话', () => {
    const { container, onNewSession } = setup();
    fireEvent.click(container.querySelector('.welcome-card')!);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toContain('向量数据库'); // 第一张卡「问个概念」的提示语进了输入框
    expect(onNewSession).toHaveBeenCalledTimes(1); // 无会话时点卡该顺手开一个
  });

  it('点建议卡填了输入框 → 发送键随之放行（「卡片 → 可发送」闭环，不误锁成永远禁发）', () => {
    const { container } = setup();
    const send1 = container.querySelector('.chat-send') as HTMLButtonElement;
    expect(send1.hasAttribute('disabled')).toBe(true); // 空白输入禁发
    fireEvent.click(container.querySelector('.welcome-card')!);
    const send2 = container.querySelector('.chat-send') as HTMLButtonElement;
    expect(send2.hasAttribute('disabled')).toBe(false); // 卡片填字后放行，可把卡延伸成提问
  });

  it('轮次元信息 / 工具 / 等待态在空态一概不渲染（不出现「0 tokens」废话）', () => {
    const { container } = setup();
    expect(container.querySelector('.chat-round-meta')).toBeNull();
    expect(container.querySelector('.tool-steps')).toBeNull();
    expect(container.querySelector('.thinking')).toBeNull();
  });
});
