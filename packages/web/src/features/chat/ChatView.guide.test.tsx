// @vitest-environment jsdom
/**
 * ChatView.guide.test — 引路灯在 ChatView 这一侧的**接线锁**（契约 `docs/GUIDE-SPEC.md` §3 / §8）。
 *
 * 用真 ChatView + 真 `useGuideBridge` / `useRemember` / `useQuickStart`，只桩流与出题（同 quickstart 用例的桩手法）。
 * 锁六条：
 *  ① 上报现场：哪个会话、几轮、空不空、忙不忙；卸载（切去别的页）即撤销；
 *  ② ★ 登记的能力与「+」菜单同口径：聊过且空闲 ⇒ 追问 / 出题 / 情景题 / 存入记忆 / 找视频都在；
 *     忙 / 连接没就绪 / 没聊过 ⇒ 一个都不在（推荐不会落在点了没反应的动作上）；出题中出题项撤销；
 *  ③ 执行：出题走 `ask.tap`（首次会先问回答方式）、情景题走 `runScenario`、追问走 `fire`（⇒ quick ⇒ send）、
 *     找视频用最近一条真回答做种子；
 *  ④ 「存入记忆」搬进 `useRemember` 后行为逐字不变：拿最近对话交给抽取接口、落一行提示；
 *  ⑤ ★ 信箱：没选会话 ⇒ 取信、开新会话、就绪后自动发出且只发一次；停在空白会话 ⇒ 就地发、不开新会话；
 *     会话里已有内容 ⇒ 不动它（提灯不会把话硬塞进别人的对话）；正忙 ⇒ 等，不丢；
 *  ⑥ 题卡 / 情景题登记行不算「一轮」也不算「最近一答」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { apiStub, docStub, grillSend, grillStub, renderChatView, stream } from './ChatView.testkit';
import { getGuideLive, putGuideMail, resetGuideStore, runGuideCap } from '../guide/guide-store';

const extract = vi.hoisted(() => vi.fn());
const openVideo = vi.hoisted(() => vi.fn());
const askTap = vi.hoisted(() => vi.fn());
const quizSpy = vi.hoisted(() => ({
  quizzing: false,
  scenarioing: false,
  quizNote: '',
  quizRefs: [] as never[],
  runQuiz: vi.fn(),
  runScenario: vi.fn(),
  resetRound: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ api: { ...apiStub, terms: { extract } } }));
vi.mock('../../lib/video-route-store', () => ({ openVideoRoute: openVideo }));
vi.mock('./useChatStream', () => ({ useChatStream: () => stream.current }));
vi.mock('./useGrillChoice', () => ({ useGrillChoice: grillStub }));
vi.mock('./use-quiz-actions', () => ({ useQuizActions: () => quizSpy }));
vi.mock('./useDocMode', () => ({ useDocMode: docStub }));
vi.mock('./AskStyleCard', () => ({ useAskStyle: () => ({ summary: '', hint: '', card: null, tap: askTap }) }));

const { ChatView } = await import('./ChatView');

const talked = [
  { role: 'user' as const, content: '什么是向量数据库' },
  { role: 'assistant' as const, content: '# 向量数据库\n它用来存储与检索高维向量。' },
];

beforeEach(() => {
  resetGuideStore();
  [extract, openVideo, askTap, grillSend, quizSpy.runScenario].forEach((f) => f.mockReset());
  grillSend.mockResolvedValue({ ok: true, error: null });
  extract.mockResolvedValue({ added: 2 });
});
afterEach(() => {
  cleanup();
  resetGuideStore();
});

describe('① 上报现场', () => {
  it('会话 / 轮数 / 空不空 / 忙不忙；卸载撤销', () => {
    const { unmount } = renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    expect(getGuideLive().chat).toEqual({ sessionId: 's1', rounds: 1, empty: false, busy: false });
    unmount();
    expect(getGuideLive().chat).toBeNull();
    renderChatView(ChatView, { sessionId: null });
    expect(getGuideLive().chat).toEqual({ sessionId: null, rounds: 0, empty: true, busy: false });
  });

  it('生成中 ⇒ busy（提灯据此说「答完再给你指路」）', () => {
    renderChatView(ChatView, { sessionId: 's1', over: { messages: talked, busy: true } });
    expect(getGuideLive().chat?.busy).toBe(true);
  });
});

describe('② 登记的能力与「+」菜单同口径', () => {
  it('聊过一轮且空闲 ⇒ 追问 / 出题 / 情景题 / 存入记忆 / 找视频都在', () => {
    renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    expect(getGuideLive().kinds).toEqual(['chat.ask', 'chat.remember', 'chat.videos', 'quiz.start', 'quiz.scenario']);
  });

  it.each([
    ['生成中', { messages: talked, busy: true }],
    ['连接没就绪', { messages: talked, ready: 'connecting' }],
    ['还没聊过', { messages: [] }],
  ])('%s ⇒ 一个都不在', (_name, over) => {
    renderChatView(ChatView, { sessionId: 's1', over });
    expect(getGuideLive().kinds).toEqual([]);
  });

  it('没选会话 ⇒ 一个都不在；出题进行中 ⇒ 出题项撤销（与菜单「出题中…」禁用同口径）', () => {
    renderChatView(ChatView, { sessionId: null });
    expect(getGuideLive().kinds).toEqual([]);
    cleanup();
    quizSpy.quizzing = true;
    renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    expect(getGuideLive().kinds).not.toContain('quiz.start');
    expect(getGuideLive().kinds).toContain('quiz.scenario');
    quizSpy.quizzing = false;
  });

  it('⑥ 题卡 / 情景题登记行不算「一轮」，也不作「最近一答」的种子', () => {
    const cards = [
      { role: 'user' as const, content: '考我一下' },
      { role: 'assistant' as const, content: '', quizBlock: { quiz: { title: '练习', questions: [] } } },
    ];
    renderChatView(ChatView, { sessionId: 's1', over: { messages: cards } });
    expect(getGuideLive().chat?.rounds).toBe(1);
    expect(getGuideLive().kinds).not.toContain('chat.videos'); // 没有一条真回答 ⇒ 没有可搜的种子
  });
});

describe('③ 执行', () => {
  it('出题 ⇒ ask.tap；情景题 ⇒ runScenario；追问 ⇒ fire ⇒ 发出这句话', () => {
    renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    act(() => void runGuideCap('quiz.start'));
    expect(askTap).toHaveBeenCalledTimes(1);
    act(() => void runGuideCap('quiz.scenario'));
    expect(quizSpy.runScenario).toHaveBeenCalledTimes(1);
    act(() => void runGuideCap('chat.ask', '它的索引怎么建？'));
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toBe('它的索引怎么建？');
  });

  it('找视频 ⇒ 用最近一条真回答做种子，带着会话 id 打开视频线路', () => {
    renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    act(() => void runGuideCap('chat.videos'));
    expect(openVideo).toHaveBeenCalledTimes(1);
    expect(openVideo.mock.calls[0]?.[0]).toBe('s1');
    expect(String(openVideo.mock.calls[0]?.[1])).toContain('向量数据库');
  });
});

describe('④ 存入记忆（搬进 useRemember 后行为不变）', () => {
  it('最近对话交给抽取接口，成功后在消息流里落一行提示', async () => {
    const { container } = renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    act(() => void runGuideCap('chat.remember'));
    expect(extract).toHaveBeenCalledTimes(1);
    const [material, sid] = extract.mock.calls[0] as [string, string];
    expect(sid).toBe('s1');
    expect(material).toContain('什么是向量数据库');
    expect(material).toContain('它用来存储与检索高维向量');
    await waitFor(() => expect(container.querySelector('.chat-remember-msg')?.textContent).toBe('已存入 2 个词条，后续回答会优先使用'));
  });

  it('抽取失败 ⇒ 如实提示；进行中这一项撤销（不会连点两次）', async () => {
    extract.mockRejectedValue(new Error('boom'));
    const { container } = renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    act(() => void runGuideCap('chat.remember'));
    expect(getGuideLive().kinds).not.toContain('chat.remember');
    await waitFor(() => expect(container.querySelector('.chat-remember-msg')?.textContent).toBe('存入失败，请稍后重试'));
  });
});

describe('⑤ 话题信箱', () => {
  it('★ 没选会话：取信 ⇒ 请 App 开新会话 ⇒ 新会话就绪后自动发出，只发一次', async () => {
    const { onNewSession, arrive } = renderChatView(ChatView, { sessionId: null });
    act(() => putGuideMail('为什么猫总爱钻进纸箱？'));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(getGuideLive().mail).toBeNull(); // 信已取走
    await arrive('s-new', { ready: 'connecting' });
    expect(grillSend).not.toHaveBeenCalled();
    await arrive('s-new', { ready: 'open' });
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toBe('为什么猫总爱钻进纸箱？');
    await arrive('s-new', { ready: 'open', busy: true });
    expect(grillSend).toHaveBeenCalledTimes(1);
  });

  it('停在空白会话里：就地发出，不开新会话', () => {
    const { onNewSession } = renderChatView(ChatView, { sessionId: 's-blank' });
    act(() => putGuideMail('随便聊聊今天的事'));
    expect(onNewSession).not.toHaveBeenCalled();
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toBe('随便聊聊今天的事');
  });

  it('★ 会话里已有内容：不动它（提灯不会把话硬塞进别人的对话），信留在信箱里等过期', () => {
    const { onNewSession } = renderChatView(ChatView, { sessionId: 's1', over: { messages: talked } });
    act(() => putGuideMail('不该被发进这场对话'));
    expect(grillSend).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(getGuideLive().mail).toBe('不该被发进这场对话');
  });

  it('正忙：先等（不丢），忙完再发', async () => {
    const { arrive } = renderChatView(ChatView, { sessionId: 's-blank', over: { busy: true } });
    act(() => putGuideMail('等会儿再发'));
    expect(grillSend).not.toHaveBeenCalled();
    expect(getGuideLive().mail).toBe('等会儿再发');
    await arrive('s-blank', { busy: false });
    expect(grillSend).toHaveBeenCalledTimes(1);
    expect(grillSend.mock.calls[0]?.[0]).toBe('等会儿再发');
  });

  it('信箱里的话在输入框里不会冒出来（发送走 fire，不经草稿）', () => {
    const { container } = renderChatView(ChatView, { sessionId: 's-blank' });
    act(() => putGuideMail('随便聊聊'));
    fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, { target: { value: '' } });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });
});
