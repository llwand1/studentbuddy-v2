/**
 * ChatView.testkit — 对话主视图测试的**公共桩与手势**（不是测试文件：文件名不带 `.test.`）。
 *
 * ★ 为什么拆（同 `continent/ContinentPage.testkit.tsx` 的先例）：`ChatView.test.tsx` 要把五个私密 hook
 *   （useChatStream / useGrillChoice / useQuizActions / useDocMode / useAskStyle）与 api 都桩成固定态，
 *   这套家伙近 60 行；2026-09-30 空会话直接开聊（CHAT-UX §2.9）再加三条接线用例就撞 320 行红线，
 *   复制一份桩到新文件又是两处口径。这里只放**桩与手势**，不放断言。
 * ★ `vi.mock(...)` 本身仍写在各测试文件里（它按文件提升）：工厂只需引用这里的对象；
 *   被测组件用 `await import('./ChatView')` 引入，保证桩先于组件求值。
 */
import { vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { PkInviteQueue } from './usePkInviteQueue';

/** 出题配比摘要两份一起拉（真题配比并入同一行，QUIZ-BLEND-SPEC §3.5）：都给空 */
export const apiStub = {
  request: vi.fn().mockRejectedValue(new Error('test model unavailable')),
  settings: {
    quizMix: vi.fn().mockResolvedValue({ mix: {} }),
    quizSourceMix: vi.fn().mockResolvedValue({ mix: {} }),
  },
};

export const emptyStream = {
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
  /** 对战邀请（PK-SPEC §16）：默认无卡。挂线锁见 ChatView.test.tsx */
  pkInvite: {
    invite: null,
    inviteBusy: false,
    applyEvent: () => false,
    acceptInvite: async () => true,
    rejectInvite: () => {},
    dismissInvite: () => {},
  } satisfies PkInviteQueue,
};

/** 换状态不改 mock 工厂本身：工厂只认这一个可变引用（用例里按需覆盖某几个字段） */
export const stream = { current: null as unknown };

/** submit / 建议卡最终都走 sendWithGrill：可观测才能锁「发了没、发了几次、发的什么」 */
export const grillSend = vi.fn(async (_text: string, _images?: unknown) => ({ ok: true, error: null }));
export const grillStub = () => ({
  composerProps: { grillMe: false, setGrillMe: () => {} },
  grillNode: null,
  sendWithGrill: grillSend,
});
export const quizStub = () => ({
  quizzing: false,
  scenarioing: false,
  quizNote: '',
  quizRefs: [],
  runQuiz: vi.fn(),
  runScenario: vi.fn(),
  resetRound: vi.fn(),
});
export const docStub = () => ({
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
});
export const askStyleStub = () => ({ summary: '', hint: '', card: null, tap: vi.fn() });

type ChatViewComponent = typeof import('./ChatView')['ChatView'];

/**
 * 挂一个 ChatView（默认无会话）。返回 `arrive(sid, streamOver)`：模拟 App 开好新会话后把新 id 传进来，
 * 顺手改 stream 的 ready/busy——空会话直接开聊的接线用例全靠它推进时序。
 */
export function renderChatView(
  ChatView: ChatViewComponent,
  opts: { sessionId?: string | null; onNewSession?: () => void; over?: Record<string, unknown> } = {},
) {
  const onNewSession = opts.onNewSession ?? vi.fn();
  const over = opts.over ?? {};
  stream.current = { ...emptyStream, ...over };
  const view = (sid: string | null) => (
    <ChatView sessionId={sid} onNewSession={onNewSession} onRoundDone={() => {}} onBusyChange={() => {}} />
  );
  const r = render(view(opts.sessionId ?? null));
  const arrive = async (sid: string, streamOver: Record<string, unknown> = {}) => {
    stream.current = { ...emptyStream, ...over, ...streamOver };
    await act(async () => {
      r.rerender(view(sid));
    });
  };
  return { ...r, onNewSession, arrive };
}
