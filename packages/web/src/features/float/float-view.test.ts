/**
 * 悬浮球纯逻辑锁（契约 docs/DESKTOP-SPEC.md「桌面悬浮球」）。
 *
 * ★ 本文件只锁**与 C# 宿主的消息常量**：它们是跨语言契约（`tools/desktop/Launcher.cs` 里逐字比对），
 *   改了一边不改另一边，表现是「点不开 / 收不回 / 拖不动」这种**不报错的静默失败**。
 * ★ 球的外形与裁剪是**几何契约**（96 窗口 / 80 画面 / 每格 5px / 起点 8px）：网页侧写在 float.css、
 *   宿主侧写在 Launcher.cs 的 BallCellLogical / BallOriginLogical。CSS 读不进单测（本仓不测样式值），
 *   两边一致由实机截图核对（见 DESKTOP-SPEC 的验证段）。
 * ★ 不测渲染层（FloatApp.tsx）：那是一个被 WinForms 包着的 WebView2，本仓无它的运行时。
 */
import { describe, it, expect } from 'vitest';
import { HOST_COLLAPSE, HOST_DRAG, HOST_EXPAND, HOST_TAP, hasHost, onHostMessage, postToHost } from './float-view';

describe('与宿主的消息协议（跨语言契约，逐字锁死）', () => {
  it('四个常量是与 Launcher.cs 逐字比对的字面量，不许改形状', () => {
    expect([HOST_DRAG, HOST_EXPAND, HOST_COLLAPSE, HOST_TAP]).toEqual([
      'sb-float:drag',
      'sb-float:expand',
      'sb-float:collapse',
      'sb-float:tap',
    ]);
  });

  it('没有宿主（普通浏览器 / node）时不抛，静默降级', () => {
    expect(() => postToHost(HOST_EXPAND)).not.toThrow();
    expect(hasHost()).toBe(false);
    expect(() => onHostMessage(() => undefined)()).not.toThrow();
  });

  it('有宿主时原样投给 window.chrome.webview.postMessage', () => {
    const seen: string[] = [];
    (globalThis as { window?: unknown }).window = { chrome: { webview: { postMessage: (m: string) => seen.push(m) } } };
    try {
      postToHost(HOST_COLLAPSE);
      postToHost(HOST_DRAG);
      expect(seen).toEqual([HOST_COLLAPSE, HOST_DRAG]);
      expect(hasHost()).toBe(true);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('订阅宿主消息：只透传字符串载荷，退订后不再回调', () => {
    const handlers: Array<(e: { data: unknown }) => void> = [];
    (globalThis as { window?: unknown }).window = {
      chrome: {
        webview: {
          postMessage: () => undefined,
          addEventListener: (_t: string, h: (e: { data: unknown }) => void) => handlers.push(h),
          removeEventListener: (_t: string, h: (e: { data: unknown }) => void) => {
            const i = handlers.indexOf(h);
            if (i >= 0) handlers.splice(i, 1);
          },
        },
      },
    };
    try {
      const got: string[] = [];
      const off = onHostMessage((m) => got.push(m));
      handlers.forEach((h) => {
        h({ data: HOST_TAP });
        h({ data: 42 }); // 非字符串载荷（宿主不会这么发）：忽略，不把数字当消息
      });
      expect(got).toEqual([HOST_TAP]);
      off();
      expect(handlers.length).toBe(0);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('宿主桥抛异常也不外泄（球的核心是展示与入口，不该因一次投递失败白屏）', () => {
    (globalThis as { window?: unknown }).window = {
      chrome: {
        webview: {
          postMessage: () => {
            throw new Error('bridge broken');
          },
        },
      },
    };
    try {
      expect(() => postToHost(HOST_DRAG)).not.toThrow();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});