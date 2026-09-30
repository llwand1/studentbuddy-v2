// @vitest-environment jsdom
/**
 * GuideBeacon 交互单测（契约 `docs/GUIDE-SPEC.md` §8）。亮灯 / 首次自动展开 / 静默 / 挂起新建议在 `GuideBeacon.proactive.test.tsx`。
 * 锁八条：① 点开立刻有规则推荐、AI 回来原位替换、请求体形状；② 失败退规则并如实说原因（中英）；
 * ③ 点选项交给最近登记的处理器（带文本）并收起，没人登记就说「现在做不了」；④ ★ 随机话题走信箱，已停在空白会话里就原地用；
 * ⑤ 壳层动作（跳页 / 新对话 / 对战 hash）；⑥ 键盘（Esc / 数字 / ↑↓ 且跳过 display:none）与点外面；
 * ⑦ 「全部功能」分组、灰着的写怎么解锁；⑧ 成本：同一现场不重复请求，换一批 / 现场变了才重要。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { GUIDE_CATALOG, GUIDE_KINDS, GUIDE_TOPICS, type GuideKind, type GuideNextResponse } from '@sb/shared';
import { GuideBeacon } from './GuideBeacon';
import { getGuideLive, registerGuideCap, resetGuideStore, setGuideChat, takeGuideMail } from './guide-store';
import { resetGuidePrefs, GUIDE_SEEN_KEY } from './guide-prefs';

const api = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('../../lib/api-guide', () => ({ guideApi: api }));

const AI: GuideNextResponse = {
  mode: 'ai',
  stage: 'chatted',
  headline: '聊得不错，来检验一下？',
  items: [
    { kind: 'quiz.start', label: 'AI：来一套题', hint: '基于刚才的对话出题' },
    { kind: 'chat.ask', label: 'AI：追问一层', hint: '往深一层', text: '它和普通做法的本质区别是什么？' },
    { kind: 'chat.topic', label: 'AI：换个话题', hint: '聊点别的', text: '讲讲黑洞的事件视界' },
  ],
};

const handlers = { onView: vi.fn(), onNewSession: vi.fn(), onFreshChat: vi.fn() };
const show = (over: Partial<Parameters<typeof GuideBeacon>[0]> = {}) =>
  render(<GuideBeacon lang="zh" view="chat" sessionId={null} {...handlers} {...over} />);
const lantern = (): HTMLElement => screen.getByRole('button', { name: '下一步做什么？' });
const open = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(lantern());
  });
};
const popover = (): HTMLElement => screen.getByRole('region', { name: '引路灯' });
const labels = (): string[] => Array.from(popover().querySelectorAll('.guide-item-label')).map((e) => e.textContent ?? '');
const settle = (): Promise<void> => act(async () => undefined);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(GUIDE_SEEN_KEY, '1'); // 默认「已看过」：本文件不测首次自动展开
  resetGuidePrefs();
  resetGuideStore();
  api.next.mockReset();
  api.next.mockResolvedValue(AI);
  Object.values(handlers).forEach((h) => h.mockReset());
});
afterEach(cleanup);

describe('① 先规则、再换 AI', () => {
  it('点开立刻有规则推荐（请求还没回）；回来后换成 AI 现挑；请求体形状对', async () => {
    let resolve: (r: GuideNextResponse) => void = () => undefined;
    api.next.mockReturnValue(new Promise<GuideNextResponse>((r) => (resolve = r)));
    show({ sessionId: 's-1' });
    expect(lantern().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(lantern().getAttribute('aria-expanded')).toBe('true');
    // 等网络期间：规则推荐 + 「AI 正在想…」
    expect(within(popover()).getByText('AI 正在想…')).toBeTruthy();
    expect(labels()[0]).toBe('随机聊个话题'); // 壳层登记了 chat.topic，没有会话 ⇒ fresh ⇒ 话题第一
    expect(api.next).toHaveBeenCalledTimes(1);
    const [body, signal] = api.next.mock.calls[0] as [Record<string, unknown>, AbortSignal];
    expect(body).toEqual({
      lang: 'zh',
      view: 'chat',
      sessionId: 's-1',
      can: ['chat.topic', 'session.new', 'nav.terms', 'nav.continent', 'nav.pk', 'nav.settings'],
      busy: false,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    await act(async () => resolve(AI));
    expect(within(popover()).getByText('AI 现挑')).toBeTruthy();
    expect(labels()).toEqual(['AI：来一套题', 'AI：追问一层', 'AI：换个话题']);
    expect(within(popover()).getByText('聊得不错，来检验一下？')).toBeTruthy();
  });

  it('非对话页不带 sessionId（别的页谈不上当前会话）', async () => {
    show({ view: 'terms', sessionId: 's-1' });
    await open();
    expect((api.next.mock.calls[0]?.[0] as { sessionId: unknown }).sessionId).toBeNull();
  });
});

describe('② 失败与原因', () => {
  it('取数失败：不抛，退规则，如实说没联系上服务', async () => {
    api.next.mockRejectedValue(new Error('network'));
    show();
    await open();
    expect(within(popover()).getByText('常用建议')).toBeTruthy();
    expect(within(popover()).getByText('没能联系上服务，先给你常用建议')).toBeTruthy();
    expect(labels().length).toBeGreaterThan(0);
  });

  it('服务端回规则 + reason：显示对应原因，标「常用建议」；英文界面显示英文', async () => {
    const items = [{ kind: 'nav.terms' as const, label: 'Open your terms', hint: 'Every term AI saved for you lives here' }];
    api.next.mockResolvedValue({ mode: 'rules', reason: 'upstream', stage: 'fresh', headline: "Let's go", items } satisfies GuideNextResponse);
    show({ lang: 'en' });
    fireEvent.click(screen.getByRole('button', { name: "What's next?" }));
    await settle();
    const pop = screen.getByRole('region', { name: 'Guiding lantern' });
    expect(within(pop).getByText('Quick picks')).toBeTruthy();
    expect(within(pop).getByText('Could not reach the model — showing quick picks')).toBeTruthy();
    expect(within(pop).getByText('Open your terms')).toBeTruthy();
  });
});

describe('③ 点选项 ⇒ 执行', () => {
  it('交给最近登记的处理器并收起；带文本的动作带着 text', async () => {
    const quiz = vi.fn();
    const ask = vi.fn();
    registerGuideCap('quiz.start', quiz);
    registerGuideCap('chat.ask', ask);
    show();
    await open();
    await settle();
    fireEvent.click(within(popover()).getByText('AI：来一套题'));
    expect(quiz).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: '引路灯' })).toBeNull();
    await open();
    fireEvent.click(within(popover()).getByText('AI：追问一层'));
    expect(ask).toHaveBeenCalledWith('它和普通做法的本质区别是什么？');
  });

  it('★ 没人登记处理器（能力刚好消失）⇒ 弹层里如实说「现在做不了」，不收起、不抛', async () => {
    show(); // 没人登记 quiz.start
    await open();
    await settle();
    fireEvent.click(within(popover()).getByText('AI：来一套题'));
    expect(within(popover()).getByRole('alert').textContent).toBe('这一步现在做不了，换一项试试');
    expect(screen.getByRole('region', { name: '引路灯' })).toBeTruthy();
  });

  it('规则推荐阶段也能点（不必等 AI）', async () => {
    api.next.mockReturnValue(new Promise(() => undefined));
    show();
    await open();
    fireEvent.click(within(popover()).getByText('翻翻词条库'));
    expect(handlers.onView).toHaveBeenCalledWith('terms');
  });
});

describe('④ 随机话题走信箱', () => {
  const topicAi: GuideNextResponse = {
    mode: 'ai',
    stage: 'fresh',
    headline: '先从一个小问题开始',
    items: [{ kind: 'chat.topic', label: '随机聊个话题', hint: '猫和纸箱', text: '为什么猫总爱钻进纸箱？' }],
  };

  it('把话放进信箱并请 App 切到未选会话态（ChatView 取信走 quick.fire）', async () => {
    api.next.mockResolvedValue(topicAi);
    show();
    await open();
    await settle();
    fireEvent.click(within(popover()).getByText('随机聊个话题'));
    expect(handlers.onFreshChat).toHaveBeenCalledTimes(1);
    expect(takeGuideMail()).toBe('为什么猫总爱钻进纸箱？');
  });

  it('★ 已经停在一场空白会话里：话就在这间里发（只放信箱），不再开一间把它丢成孤儿', async () => {
    api.next.mockResolvedValue(topicAi);
    setGuideChat({ sessionId: 's-blank', rounds: 0, empty: true, busy: false });
    show({ sessionId: 's-blank' });
    await open();
    await settle();
    fireEvent.click(within(popover()).getByText('随机聊个话题'));
    expect(handlers.onFreshChat).not.toHaveBeenCalled();
    expect(takeGuideMail()).toBe('为什么猫总爱钻进纸箱？');
  });
});

describe('⑤ 壳层动作', () => {
  it('跳页走 onView；新对话走 onNewSession；对战走 hash', async () => {
    const nav = (kind: GuideKind, label: string) => ({ kind, label, hint: 'x' });
    api.next.mockResolvedValue({
      mode: 'ai',
      stage: 'tour',
      headline: '逛逛？',
      items: [nav('nav.continent', '去大陆'), nav('session.new', '新对话'), nav('nav.pk', '去对战'), nav('nav.settings', '去设置')],
    } satisfies GuideNextResponse);
    show({ view: 'terms' });
    await open();
    await settle();
    fireEvent.click(within(popover()).getByText('去大陆'));
    expect(handlers.onView).toHaveBeenLastCalledWith('continent');
    await open();
    fireEvent.click(within(popover()).getByText('新对话'));
    expect(handlers.onNewSession).toHaveBeenCalledTimes(1);
    await open();
    fireEvent.click(within(popover()).getByText('去设置'));
    expect(handlers.onView).toHaveBeenLastCalledWith('settings');
    await open();
    fireEvent.click(within(popover()).getByText('去对战'));
    expect(window.location.hash).toBe('#/pk');
    window.location.hash = '';
  });
});

describe('⑥ 键盘与点外面', () => {
  it('Esc 收起并把焦点还给提灯', async () => {
    show();
    await open();
    fireEvent.keyDown(popover(), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: '引路灯' })).toBeNull();
    expect(document.activeElement).toBe(lantern());
  });

  it('数字键直达第 n 项；越界的数字、带修饰键的不响应', async () => {
    const quiz = vi.fn();
    registerGuideCap('quiz.start', quiz);
    show();
    await open();
    await settle();
    fireEvent.keyDown(popover(), { key: '4' });
    fireEvent.keyDown(popover(), { key: '1', ctrlKey: true });
    expect(quiz).not.toHaveBeenCalled();
    fireEvent.keyDown(popover(), { key: '1' });
    expect(quiz).toHaveBeenCalledTimes(1);
  });

  it('↑↓ 在可聚焦元素间移动：从提灯 ↓ 进弹层，第一项 ↓ 第二项、↑ 回第一项', async () => {
    show();
    await open();
    await settle();
    lantern().focus();
    fireEvent.keyDown(lantern(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(popover().querySelector('.guide-icon-btn')); // 弹层里 DOM 顺序第一个：换一批 ↻
    const items = Array.from(popover().querySelectorAll<HTMLElement>('.guide-item'));
    (items[0] as HTMLElement).focus();
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('★ ↓ 跳过 display:none 的元素（桌面上手机专用的 ✕）：否则 focus() 空操作，焦点卡死在 ↻ 上', async () => {
    show();
    await open();
    await settle();
    const refresh = popover().querySelector('.guide-icon-btn') as HTMLElement;
    const close = popover().querySelector('.guide-pop-x') as HTMLElement;
    close.style.display = 'none';
    refresh.focus();
    fireEvent.keyDown(refresh, { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(close);
    expect(document.activeElement).toBe(popover().querySelector('.guide-item'));
  });

  it('点弹层外面收起，点里面不收起', async () => {
    show();
    await open();
    fireEvent.mouseDown(popover());
    expect(screen.getByRole('region', { name: '引路灯' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('region', { name: '引路灯' })).toBeNull();
  });
});

describe('⑦ 全部功能', () => {
  it('13 种动作分三组列出；做不了的灰着并写怎么解锁；能做的一点就执行', async () => {
    const quiz = vi.fn();
    registerGuideCap('quiz.start', quiz);
    show();
    await open();
    fireEvent.click(within(popover()).getByRole('button', { name: /全部功能/ }));
    const rows = Array.from(popover().querySelectorAll<HTMLButtonElement>('.guide-row'));
    expect(rows).toHaveLength(GUIDE_KINDS.length);
    expect(['对话', '练习', '去哪儿'].every((g) => within(popover()).getByRole('region', { name: g }))).toBe(true);
    const row = (kind: string): HTMLButtonElement => rows.find((r) => r.dataset.kind === kind) as HTMLButtonElement;
    // 没人登记的：灰着 + 解锁说明
    expect(row('quiz.explain').disabled).toBe(true);
    expect(row('quiz.explain').textContent).toContain(GUIDE_CATALOG['quiz.explain'].need.zh);
    // 登记了的：可点，显示正常说明
    expect(row('quiz.start').disabled).toBe(false);
    expect(row('quiz.start').textContent).toContain(GUIDE_CATALOG['quiz.start'].hint.zh);
    fireEvent.click(row('quiz.start'));
    expect(quiz).toHaveBeenCalledTimes(1);
  });

  it('目录里点「随机聊个话题」：用内置话题作文本（没有 AI 写的也能开聊）', async () => {
    show();
    await open();
    fireEvent.click(within(popover()).getByRole('button', { name: /全部功能/ }));
    const row = popover().querySelector<HTMLButtonElement>('.guide-row[data-kind="chat.topic"]') as HTMLButtonElement;
    fireEvent.click(row);
    const sent = takeGuideMail() ?? '';
    expect(GUIDE_TOPICS.some((t) => t.zh === sent)).toBe(true);
  });
});

describe('⑧ 成本可控', () => {
  it('同一现场收起再展开不重复请求；「换一批」强制重要；能力集变了（现场变了）重要', async () => {
    show();
    await open();
    await settle();
    expect(api.next).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(popover(), { key: 'Escape' });
    await open();
    await settle();
    expect(api.next).toHaveBeenCalledTimes(1); // 命中缓存
    fireEvent.click(within(popover()).getByRole('button', { name: '换一批' }));
    await settle();
    expect(api.next).toHaveBeenCalledTimes(2);
    // 展开期间现场变了：有人登记了新能力
    await act(async () => {
      registerGuideCap('quiz.start', () => undefined);
    });
    await settle();
    expect(api.next).toHaveBeenCalledTimes(3);
    expect((api.next.mock.calls[2]?.[0] as { can: string[] }).can).toContain('quiz.start');
    expect(getGuideLive().kinds).toContain('quiz.start');
  });
});
