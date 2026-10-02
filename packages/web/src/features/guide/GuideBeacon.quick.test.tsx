// @vitest-environment jsdom
/**
 * GuideBeacon 快捷项（契约 `docs/POMODORO-SPEC.md` §9 / `GUIDE-SPEC.md` §8.1）：亮灯时提灯正下方直接摆出
 * 第一条推荐，一点即执行；点提灯本身才是整张清单。锁四条：
 *  ① 亮灯 ⇒ 短提示 + 快捷键（规则推荐第一项，此刻＝出题）；点快捷键执行该动作并灭灯，**不展开**清单；
 *  ② 点提灯 ⇒ 展开整张清单（快捷项收起）；
 *  ③ ✕ 只收起这一次：同一次亮灯里不再出现，再次亮灯重新出现；
 *  ④ ★ 番茄钟刚开 ⇒ 灯亮、提示写方向、快捷项的话题落在方向里（规则推荐即刻可用，不等 AI）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { startPomodoro } from '@sb/shared';
import { GuideBeacon } from './GuideBeacon';
import { registerGuideCap, resetGuideStore, setGuideChat } from './guide-store';
import { GUIDE_SEEN_KEY, resetGuidePrefs } from './guide-prefs';

const api = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('../../lib/api-guide', () => ({ guideApi: api }));
const pomoApi = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), clear: vi.fn() }));
vi.mock('../../lib/api-pomodoro', () => ({ pomodoroApi: pomoApi }));
const store = await import('../pomodoro/pomodoro-store');

const handlers = { onView: vi.fn(), onNewSession: vi.fn(), onFreshChat: vi.fn() };
const show = () => render(<GuideBeacon lang="zh" view="chat" sessionId="s" {...handlers} />);
const lantern = (): HTMLElement => screen.getByRole('button', { name: '下一步做什么？' });
const quick = (c: HTMLElement): HTMLButtonElement | null => c.querySelector('.guide-quick-btn');
const chat = (busy: boolean): void => setGuideChat({ sessionId: 's', rounds: 1, empty: false, busy });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(GUIDE_SEEN_KEY, '1');
  resetGuidePrefs();
  resetGuideStore();
  store.resetPomodoroStore();
  api.next.mockReset();
  api.next.mockReturnValue(new Promise(() => undefined)); // AI 一直不回：只验规则推荐那一层
  Object.values(handlers).forEach((h) => h.mockReset());
  window.matchMedia = undefined as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('快捷项', () => {
  it('① 聊完一轮亮灯 ⇒ 快捷项＝出题；点它执行并灭灯，清单不展开', async () => {
    const run = vi.fn();
    registerGuideCap('quiz.start', run);
    const { container } = show();
    act(() => chat(true));
    act(() => chat(false));
    expect(container.querySelector('.guide-teaser')?.textContent).toBe('来套题检验下？');
    expect(quick(container)?.textContent).toContain('出题');
    await act(async () => {
      fireEvent.click(quick(container)!);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.guide-beacon')?.className).not.toContain('is-lit');
    expect(screen.queryByRole('region', { name: '引路灯' })).toBeNull();
    expect(container.querySelector('.guide-quick')).toBeNull();
  });

  it('② 点提灯 ⇒ 整张清单，快捷项收起；③ ✕ 只收起这一次', async () => {
    registerGuideCap('quiz.start', () => undefined);
    const { container } = show();
    act(() => chat(true));
    act(() => chat(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '收起' }));
    });
    expect(container.querySelector('.guide-quick')).toBeNull();
    // 再聊一轮 ⇒ 重新亮、重新露出
    act(() => chat(true));
    act(() => chat(false));
    expect(container.querySelector('.guide-quick')).not.toBeNull();
    await act(async () => {
      fireEvent.click(lantern());
    });
    expect(screen.getByRole('region', { name: '引路灯' })).toBeTruthy();
    expect(container.querySelector('.guide-quick')).toBeNull();
  });

  it('④ 番茄钟刚开 ⇒ 灯亮、提示写方向、快捷项与追问都落在方向里', async () => {
    // 聊过之后的阶段里带文本的动作是追问（chat.ask）：它的那句话要落在方向里
    registerGuideCap('chat.ask', () => undefined);
    registerGuideCap('quiz.start', () => undefined);
    const { container } = show();
    act(() => chat(false));
    expect(container.querySelector('.guide-beacon')?.className).not.toContain('is-lit');
    pomoApi.get.mockResolvedValue({ session: startPomodoro({ subject: '有机化学', workMin: 25 }, new Date()), focus: null });
    await act(async () => {
      await store.loadPomodoroState();
    });
    expect(container.querySelector('.guide-beacon')?.className).toContain('is-lit');
    expect(container.querySelector('.guide-teaser')?.textContent).toBe('专注「有机化学」，从这开始？');
    // chatted 阶段必备项是出题；快捷项是第一条（出题），其 hint 写方向
    expect(quick(container)?.textContent).toContain('有机化学');
    await act(async () => {
      fireEvent.click(lantern());
    });
    const topic = screen.getByRole('region', { name: '引路灯' }).querySelector('[title^="会发送："]');
    expect(topic?.getAttribute('title')).toContain('有机化学');
  });
});
