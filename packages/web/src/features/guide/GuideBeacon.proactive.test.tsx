// @vitest-environment jsdom
/**
 * GuideBeacon 主动程度单测（契约 `docs/GUIDE-SPEC.md` §8「主动程度」）：何时亮灯、首次自动展开、静默开关、
 * 悬停预取、「不在用户手下换列表」。交互部分在 `GuideBeacon.test.tsx`。
 *
 * 锁六条：
 *  ① 亮灯只在「刚发生了什么」：聊完一轮（忙 → 闲）、一组题**刚变得可解析**；打开一场有历史的会话不亮；
 *     点开 / 新一轮开始就灭；亮灯时图标下冒短提示，且读屏有一条实时播报；
 *  ② ★ 回归：讲解生成期间题卡能力暂时注销、生成完「再练一遍」重新登记——灯**不许**再亮一次「看解析」；
 *  ③ 静默：`sb_guide_proactive=0` ⇒ 不亮、不冒提示；弹层页脚的开关落盘、立即生效；
 *  ④ 首次自动展开：本机第一次、对话页、空白态、宽屏 ⇒ 1.2 秒后展开一次并置 seen；之后永不；
 *     非对话页 / 已看过 / 静默 / 窄屏 / 已聊过 都不展开；1.2 秒内用户自己点开了，定时器不再开第二遍（不换掉他眼前的话题）；
 *  ⑤ 悬停 0.4 秒才预取 AI（提前移开取消），聚焦立刻预取；
 *  ⑥ 用户已把指针放到某一项上时，AI 回来不在他手下换：挂起并出现「有新建议 ↻」，点了才换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GuideNextResponse } from '@sb/shared';
import { GuideBeacon } from './GuideBeacon';
import { registerGuideCap, resetGuideStore, setGuideChat } from './guide-store';
import { GUIDE_PROACTIVE_KEY, GUIDE_SEEN_KEY, resetGuidePrefs } from './guide-prefs';
import { GUIDE_AUTO_OPEN_MS, GUIDE_HOVER_PREFETCH_MS } from './use-guide';

const api = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('../../lib/api-guide', () => ({ guideApi: api }));

const AI: GuideNextResponse = {
  mode: 'ai',
  stage: 'fresh',
  headline: 'AI 的开场白',
  items: [{ kind: 'nav.terms', label: 'AI：翻词条', hint: '看看词条库' }],
};

const handlers = { onView: vi.fn(), onNewSession: vi.fn(), onFreshChat: vi.fn() };
const show = (over: Partial<Parameters<typeof GuideBeacon>[0]> = {}) =>
  render(<GuideBeacon lang="zh" view="chat" sessionId={null} {...handlers} {...over} />);
const beacon = (c: HTMLElement): HTMLElement => c.querySelector('.guide-beacon') as HTMLElement;
const lantern = (): HTMLElement => screen.getByRole('button', { name: '下一步做什么？' });
const popover = (): HTMLElement | null => screen.queryByRole('region', { name: '引路灯' });
const chat = (over: Partial<{ rounds: number; busy: boolean }> = {}): void =>
  setGuideChat({ sessionId: 's', rounds: 1, empty: false, busy: false, ...over });
const ticks = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(GUIDE_SEEN_KEY, '1'); // 默认已看过；首次自动展开的用例自己清掉
  resetGuidePrefs();
  resetGuideStore();
  api.next.mockReset();
  api.next.mockResolvedValue(AI);
  Object.values(handlers).forEach((h) => h.mockReset());
  window.matchMedia = undefined as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('① 何时亮灯', () => {
  it('聊完一轮（忙 → 闲）亮灯：图标下冒短提示，读屏有实时播报；点开即灭', async () => {
    const { container } = show();
    expect(beacon(container).className).not.toContain('is-lit');
    act(() => chat({ busy: true }));
    expect(beacon(container).className).not.toContain('is-lit'); // 忙着不亮
    act(() => chat({ busy: false }));
    expect(beacon(container).className).toContain('is-lit');
    expect(container.querySelector('.guide-teaser')?.textContent).toBe('来套题检验下？');
    expect(container.querySelector('.guide-dot')).toBeTruthy();
    expect(container.querySelector('[role="status"].guide-sr')?.textContent).toBe('来套题检验下？');
    await act(async () => {
      fireEvent.click(lantern());
    });
    expect(beacon(container).className).not.toContain('is-lit');
    expect(container.querySelector('.guide-teaser')).toBeNull();
    expect(container.querySelector('.guide-sr')?.textContent).toBe('');
  });

  it('★ 直接打开一场有历史的会话不亮（那不是「刚发生了什么」）', () => {
    const { container } = show();
    act(() => chat({ rounds: 5 }));
    expect(beacon(container).className).not.toContain('is-lit');
  });

  it('新一轮开始（又忙了）灯就灭', () => {
    const { container } = show();
    act(() => chat({ busy: true }));
    act(() => chat({ busy: false }));
    expect(beacon(container).className).toContain('is-lit');
    act(() => chat({ busy: true }));
    expect(beacon(container).className).not.toContain('is-lit');
  });

  it('一组题刚变得可解析（能力里多了 quiz.explain）⇒ 亮灯「做完了，看解析」', () => {
    const { container } = show();
    act(() => chat());
    act(() => {
      registerGuideCap('quiz.explain', () => undefined);
      registerGuideCap('quiz.retry', () => undefined);
    });
    expect(beacon(container).className).toContain('is-lit');
    expect(container.querySelector('.guide-teaser')?.textContent).toBe('做完了，看解析');
  });
});

describe('② ★ 回归：讲解出来后灯不再重亮', () => {
  it('讲解生成期间两个能力都注销、生成完只有「再练一遍」回来 ⇒ 不亮', async () => {
    const { container } = show();
    act(() => chat());
    let offExplain = (): void => undefined;
    let offRetry = (): void => undefined;
    act(() => {
      offExplain = registerGuideCap('quiz.explain', () => undefined);
      offRetry = registerGuideCap('quiz.retry', () => undefined);
    });
    expect(beacon(container).className).toContain('is-lit');
    // 用户走提灯执行「一键解析」：灯灭；随后题卡进入生成期，两个能力暂时注销
    await act(async () => {
      fireEvent.click(lantern());
    });
    act(() => {
      offExplain();
      offRetry();
    });
    // 讲解出来：只剩「再练一遍」重新登记（阶段又回到 quizzed，但已经没有可解析的了）
    act(() => {
      registerGuideCap('quiz.retry', () => undefined);
    });
    expect(beacon(container).className).not.toContain('is-lit');
  });
});

describe('③ 静默', () => {
  it('sb_guide_proactive=0：聊完也不亮、不冒提示；弹层仍能点开', async () => {
    localStorage.setItem(GUIDE_PROACTIVE_KEY, '0');
    resetGuidePrefs();
    const { container } = show();
    act(() => chat({ busy: true }));
    act(() => chat({ busy: false }));
    expect(beacon(container).className).not.toContain('is-lit');
    expect(container.querySelector('.guide-teaser')).toBeNull();
    await act(async () => {
      fireEvent.click(lantern());
    });
    expect(popover()).toBeTruthy();
  });

  it('页脚「主动提示」：取消勾选落盘并立即生效（灯当场熄灭），再勾回去恢复', async () => {
    const { container } = show();
    act(() => chat({ busy: true }));
    act(() => chat({ busy: false }));
    expect(beacon(container).className).toContain('is-lit');
    await act(async () => {
      fireEvent.click(lantern()); // 点开会灭灯；再造一次亮灯前先拿到开关
    });
    const box = within(popover() as HTMLElement).getByRole('checkbox', { name: /主动提示/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(localStorage.getItem(GUIDE_PROACTIVE_KEY)).toBe('0');
    fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    act(() => chat({ busy: true }));
    act(() => chat({ busy: false }));
    expect(beacon(container).className).not.toContain('is-lit');
    await act(async () => {
      fireEvent.click(lantern());
    });
    fireEvent.click(within(popover() as HTMLElement).getByRole('checkbox', { name: /主动提示/ }));
    expect(localStorage.getItem(GUIDE_PROACTIVE_KEY)).toBe('1');
  });
});

describe('④ 首次自动展开', () => {
  beforeEach(() => localStorage.removeItem(GUIDE_SEEN_KEY));

  it('★ 本机第一次 + 对话页 + 空白态：1.2 秒后展开一次并置 seen；之后重新进入永不再展开', async () => {
    const { unmount } = show();
    await ticks(GUIDE_AUTO_OPEN_MS - 1);
    expect(popover()).toBeNull();
    await ticks(1);
    expect(popover()).toBeTruthy();
    expect(localStorage.getItem(GUIDE_SEEN_KEY)).toBe('1');
    expect(api.next).toHaveBeenCalledTimes(1);
    unmount();
    cleanup();
    show();
    await ticks(GUIDE_AUTO_OPEN_MS * 2);
    expect(popover()).toBeNull();
  });

  const notAuto: Array<[string, Partial<Parameters<typeof GuideBeacon>[0]>, () => void]> = [
    ['非对话页', { view: 'terms' }, () => undefined],
    ['静默', {}, () => localStorage.setItem(GUIDE_PROACTIVE_KEY, '0')],
    ['已经聊过（不是空白态）', {}, () => void act(() => chat({ rounds: 3 }))],
    [
      '手机宽度（≤700px 只靠亮灯，不盖屏）',
      {},
      () => {
        window.matchMedia = ((q: string) => ({ matches: /max-width:\s*700px/.test(q) })) as unknown as typeof window.matchMedia;
      },
    ],
  ];
  it.each(notAuto)('%s ⇒ 不自动展开', async (_name, props, arrange) => {
    arrange();
    resetGuidePrefs();
    show(props);
    await ticks(GUIDE_AUTO_OPEN_MS * 2);
    expect(popover()).toBeNull();
    expect(localStorage.getItem(GUIDE_SEEN_KEY)).toBeNull();
  });

  it('★ 1.2 秒内用户自己点开了：定时器触发时不再「开第二遍」（否则会换掉他眼前的话题）', async () => {
    const random = vi.spyOn(Math, 'random');
    show();
    await ticks(500);
    await act(async () => {
      fireEvent.click(lantern());
    });
    expect(popover()).toBeTruthy();
    const afterManual = random.mock.calls.length; // 手动展开时已为「本次展开」抽过一次随机种子
    await ticks(GUIDE_AUTO_OPEN_MS);
    expect(popover()).toBeTruthy();
    expect(random.mock.calls.length).toBe(afterManual);
    expect(api.next).toHaveBeenCalledTimes(1);
  });
});

describe('⑤ 悬停 / 聚焦预取', () => {
  it('悬停满 0.4 秒才预取；提前移开取消；聚焦立刻预取；已在途 / 已缓存不重复', async () => {
    show();
    fireEvent.pointerEnter(lantern());
    await ticks(GUIDE_HOVER_PREFETCH_MS - 1);
    expect(api.next).not.toHaveBeenCalled();
    fireEvent.pointerLeave(lantern());
    await ticks(50);
    expect(api.next).not.toHaveBeenCalled(); // 提前移开 ⇒ 取消
    fireEvent.pointerEnter(lantern());
    await ticks(GUIDE_HOVER_PREFETCH_MS);
    expect(api.next).toHaveBeenCalledTimes(1);
    act(() => lantern().focus());
    await ticks(10);
    expect(api.next).toHaveBeenCalledTimes(1); // 缓存命中
    expect(popover()).toBeNull(); // 预取不展开
  });

  it('预取回来的结果在点开时直接就是 AI 现挑（不用再等）', async () => {
    show();
    act(() => lantern().focus());
    await ticks(10);
    await act(async () => {
      fireEvent.click(lantern());
    });
    expect(within(popover() as HTMLElement).getByText('AI 现挑')).toBeTruthy();
    expect(api.next).toHaveBeenCalledTimes(1);
  });
});

describe('⑥ 不在用户手下换列表', () => {
  it('指针已放到某一项上时 AI 才回来：列表不动，出现「有新建议 ↻」；点了才换', async () => {
    let resolve: (r: GuideNextResponse) => void = () => undefined;
    api.next.mockReturnValue(new Promise<GuideNextResponse>((r) => (resolve = r)));
    show();
    await act(async () => {
      fireEvent.click(lantern());
    });
    const first = (popover() as HTMLElement).querySelector('.guide-item') as HTMLElement;
    const before = first.textContent;
    fireEvent.pointerEnter(first);
    await act(async () => resolve(AI));
    expect((popover() as HTMLElement).querySelector('.guide-item')?.textContent).toBe(before);
    fireEvent.click(within(popover() as HTMLElement).getByRole('button', { name: '有新建议 ↻' }));
    expect(within(popover() as HTMLElement).getByText('AI：翻词条')).toBeTruthy();
    expect(within(popover() as HTMLElement).queryByRole('button', { name: '有新建议 ↻' })).toBeNull();
  });

  it('没碰过任何一项：AI 回来立刻原位替换，不出现「有新建议」', async () => {
    let resolve: (r: GuideNextResponse) => void = () => undefined;
    api.next.mockReturnValue(new Promise<GuideNextResponse>((r) => (resolve = r)));
    show();
    await act(async () => {
      fireEvent.click(lantern());
    });
    await act(async () => resolve(AI));
    expect(within(popover() as HTMLElement).getByText('AI：翻词条')).toBeTruthy();
    expect(within(popover() as HTMLElement).queryByRole('button', { name: '有新建议 ↻' })).toBeNull();
  });

  it('忙态：没有推荐项，只显示占位与一句话', async () => {
    show();
    act(() => chat({ busy: true }));
    api.next.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      fireEvent.click(lantern());
    });
    const pop = popover() as HTMLElement;
    expect(pop.querySelectorAll('.guide-item')).toHaveLength(0);
    expect(within(pop).getByText('稍等片刻…')).toBeTruthy();
    expect(within(pop).getByText(/AI 正在回答/)).toBeTruthy();
  });
});
