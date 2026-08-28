import { describe, it, expect, vi, afterEach } from 'vitest';
import { closePreview, getPreview, openPreview, refreshPreview, subscribePreview } from './preview-store';

afterEach(() => {
  closePreview();
});

describe('预览面板状态件', () => {
  it('初始无预览；openPreview 出目标并通知订阅者', () => {
    expect(getPreview()).toBeNull();
    const fn = vi.fn();
    const off = subscribePreview(fn);
    openPreview('/api/preview/a', '弹跳小球');
    expect(getPreview()).toEqual({ url: '/api/preview/a', label: '弹跳小球', nonce: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    openPreview('/api/preview/b', '另一页');
    expect(fn).toHaveBeenCalledTimes(1); // 退订后不再打扰
  });

  it('同 url 重复点 → nonce 递增（强制 iframe 重载）；换 url → nonce 归零', () => {
    openPreview('/api/preview/a', 'x');
    openPreview('/api/preview/a', 'x');
    expect(getPreview()?.nonce).toBe(1);
    refreshPreview();
    expect(getPreview()).toEqual({ url: '/api/preview/a', label: 'x', nonce: 2 });
    openPreview('/api/preview/b', 'y');
    expect(getPreview()?.nonce).toBe(0);
  });

  it('快照引用稳定（useSyncExternalStore 靠它防死循环）；close 幂等', () => {
    openPreview('/api/preview/a', 'x');
    expect(getPreview()).toBe(getPreview());
    const fn = vi.fn();
    const off = subscribePreview(fn);
    closePreview();
    closePreview();
    expect(getPreview()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it('无预览时 refresh 是空操作，不会凭空造出面板', () => {
    refreshPreview();
    expect(getPreview()).toBeNull();
  });
});
