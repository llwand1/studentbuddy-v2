// @vitest-environment jsdom
/**
 * WaitDrillCard 单测：两个开关点选即存（本机偏好）并广播；「现在试一局」发 sb:drill-open。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { WaitDrillCard } from './WaitDrillCard';
import { DRILL_OPEN_EVENT, DRILL_PREFS_EVENT, loadDrillPrefs } from '../drill/drill-prefs';

describe('WaitDrillCard', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('开关点选即存并广播；试一局发 sb:drill-open', () => {
    const prefsSpy = vi.fn();
    const openSpy = vi.fn();
    window.addEventListener(DRILL_PREFS_EVENT, prefsSpy);
    window.addEventListener(DRILL_OPEN_EVENT, openSpy);
    render(<WaitDrillCard />);
    expect(screen.getByText(/2 秒没回完就弹/)).toBeTruthy();
    const auto = screen.getByText('等回复时自动弹：开');
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(auto);
    expect(screen.getByText('等回复时自动弹：关').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByText('音乐与音效：开'));
    expect(screen.getByText('音乐与音效：关')).toBeTruthy();
    expect(loadDrillPrefs()).toEqual({ enabled: false, sound: false });
    expect(prefsSpy).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('现在试一局'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener(DRILL_PREFS_EVENT, prefsSpy);
    window.removeEventListener(DRILL_OPEN_EVENT, openSpy);
  });
});
