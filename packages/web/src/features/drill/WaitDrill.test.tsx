// @vitest-environment jsdom
/**
 * WaitDrill 页面测试 ①——「什么时候弹、什么时候回」（契约 docs/WAIT-DRILL-SPEC.md §2 / §3.4 / §6）：
 *  - 发送 2 秒还没回完才弹；到期词条答对 ⇒ 真打卡（`mark(id,true)`）+ 通知说清"怪消失了"；
 *  - 回复到了 ⇒ 横幅 + 答完这张自动切回；不答也在 8 秒后切回；「继续刷」按下后不再自动切；
 *  - 秒回不弹；Esc 关掉本轮不再弹；设置关掉自动弹后仍可从入口手动打开（练习局不自动关）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { clickCorrect, correctIndex, dialog, flush, mapMock, markMock, newTermsMock, keepMock, dismissMock, resetDrillMocks } from './WaitDrill.testkit';
import { requestDrillOpen, saveDrillPrefs } from './drill-prefs';

vi.mock('../../lib/api-terms-continent', () => ({ termsContinentApi: { map: mapMock } }));
vi.mock('../../lib/api-terms-review', () => ({ termsReviewApi: { mark: markMock } }));
vi.mock('../../lib/api-drill', () => ({ drillApi: { newTerms: newTermsMock, keep: keepMock, dismiss: dismissMock } }));

const { WaitDrill, READY_GRACE_S } = await import('./WaitDrill');

async function openBusy(sid = 's1') {
  const view = render(<WaitDrill busySessionId={sid} active />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await flush();
  return view;
}

describe('WaitDrill：弹与回', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetDrillMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('★ 2 秒还在生成才弹；第一张是到期词条，答对 ⇒ mark(id,true) + 「怪消失了」；回复到了 ⇒ 答完这张自动切回', async () => {
    const view = await openBusy();
    expect(dialog()).not.toBeNull();
    expect(mapMock).toHaveBeenCalledTimes(1);
    expect(newTermsMock).toHaveBeenCalledWith('s1');
    expect(screen.getByText('到期 · 答对即打卡')).toBeTruthy();
    expect(screen.getByText('AI 正在回复…')).toBeTruthy();

    clickCorrect();
    expect(markMock).toHaveBeenCalledWith('d1', true);
    expect(document.querySelector('.drill-opt.right')).not.toBeNull();
    expect(document.querySelector('.drill-fx-slash')).not.toBeNull(); // 第一次答对 = 斩击特效
    await flush();
    expect(screen.getByText(/已打卡——大陆上那只怪消失了/)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.queryByText('到期 · 答对即打卡')).toBeNull(); // 自动翻到下一张（普通词条）
    expect(dialog()).not.toBeNull();

    // 回复到了：横幅 + 倒计时；答完这张就切回
    view.rerender(<WaitDrill busySessionId={null} active />);
    expect(screen.getByText(new RegExp(`回复到了——答完这张自动切回（${READY_GRACE_S}s）`))).toBeTruthy();
    clickCorrect();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(dialog()).toBeNull();
    expect(markMock).toHaveBeenCalledTimes(1); // 普通词条不打卡
  });

  it('回复到了却一直不答 ⇒ 8 秒后自动切回；「现在回去」立刻切', async () => {
    const view = await openBusy();
    view.rerender(<WaitDrill busySessionId={null} active />);
    await act(async () => {
      vi.advanceTimersByTime(READY_GRACE_S * 1000 - 500);
    });
    expect(dialog()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(dialog()).toBeNull();

    // 下一轮：点「现在回去」
    view.rerender(<WaitDrill busySessionId="s2" active />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(dialog()).not.toBeNull();
    view.rerender(<WaitDrill busySessionId={null} active />);
    fireEvent.click(screen.getByText('现在回去'));
    expect(dialog()).toBeNull();
  });

  it('「继续刷」：横幅收起、答完也不切、8 秒也不切，直到自己关', async () => {
    const view = await openBusy();
    view.rerender(<WaitDrill busySessionId={null} active />);
    fireEvent.click(screen.getByText('继续刷'));
    expect(screen.queryByText(/回复到了——/)).toBeNull();
    clickCorrect();
    await act(async () => {
      vi.advanceTimersByTime(READY_GRACE_S * 1000 + 1000);
    });
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByTitle('关闭（Esc）'));
    expect(dialog()).toBeNull();
  });

  it('秒回不弹；Esc 关掉后本轮不再弹', async () => {
    const view = render(<WaitDrill busySessionId="s1" active />);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    view.rerender(<WaitDrill busySessionId={null} active />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(dialog()).toBeNull();
    expect(mapMock).not.toHaveBeenCalled();

    view.rerender(<WaitDrill busySessionId="s2" active />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(dialog()).toBeNull();
  });

  it('设置关掉自动弹 ⇒ 不弹；入口 requestDrillOpen 仍能打开练习局（没有回复可等，不自动关）', async () => {
    saveDrillPrefs({ enabled: false });
    render(<WaitDrill busySessionId="s1" active />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(dialog()).toBeNull();
    act(() => requestDrillOpen());
    await flush();
    expect(dialog()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(READY_GRACE_S * 1000 + 2000);
    });
    expect(dialog()).not.toBeNull();
  });

  it('焦点留在聊天输入框也能按数字作答（且不会把数字打进去）；打开时焦点进弹窗，关掉还回输入框', async () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    await openBusy();
    expect(document.activeElement?.classList.contains('drill-stage')).toBe(true);
    ta.focus(); // 模拟用户又点回聊天框——弹窗是模态，按键仍归弹窗
    const i = correctIndex();
    const notPrevented = fireEvent.keyDown(ta, { key: String(i + 1) });
    expect(notPrevented).toBe(false);
    expect(document.querySelector('.drill-opt.right')).not.toBeNull();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(ta);
    ta.remove();
  });

  it('不在对话页不自动弹；音效钮切换写回本机偏好', async () => {
    render(<WaitDrill busySessionId="s1" active={false} />);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(dialog()).toBeNull();
    cleanup();
    await openBusy();
    const btn = screen.getByTitle('关掉音乐与音效');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(screen.getByTitle('打开音乐与音效').getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('sb:drill:prefs') ?? '{}')).toEqual({ enabled: true, sound: false });
  });
});
