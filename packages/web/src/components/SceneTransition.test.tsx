// @vitest-environment jsdom
/**
 * 像素场景转场 ＋ 启动画面的回归锁。jsdom 看不见 CSS，这里锁的是**结构与时机**：
 * 幕布什么时候在场、什么时候不该在场、它是否只是装饰、内容是不是同步换掉。
 * 「掀开」的视觉本身由 pixel-motion.css 负责，属真机目检范围。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// ★ 必须在 react-dom 加载**之前**补上：jsdom 没有 `AnimationEvent`，react-dom 初始化时据此判定「浏览器只认
//   带前缀的动画事件」，转而监听 `webkitAnimationEnd`——那样 `fireEvent.animationEnd` 永远打不到 `onAnimationEnd`。
//   真浏览器都有 `AnimationEvent`，补上它才是让 jsdom 走真机同一条路，而不是让测试去迁就 jsdom 的怪癖。
vi.hoisted(() => {
  if (!('AnimationEvent' in globalThis)) Object.assign(globalThis, { AnimationEvent: Event });
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SceneTransition } from './SceneTransition';
import { BootScreen } from './BootScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wipeOf = (root: HTMLElement) => root.querySelectorAll('.sb-scene-wipe');
/** 取那块唯一的幕布；不在场就直接失败，比 `?.` 吞掉更诚实 */
const theWipe = (root: HTMLElement): Element => {
  const w = wipeOf(root);
  if (w.length !== 1) throw new Error(`expected exactly one curtain, found ${w.length}`);
  return w[0] as Element;
};

describe('SceneTransition', () => {
  it('persistent workspace preserves a hidden draft; portal changes never add a second curtain', () => {
    const children = (hidden: boolean) => <><div hidden={hidden}><textarea defaultValue="保留这份草稿" /></div><p>词条目的地</p></>;
    const view = render(<SceneTransition scene="chat" persistent>{children(false)}</SceneTransition>);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement; input.value = '尚未发送';
    view.rerender(<SceneTransition scene="terms" persistent quiet>{children(true)}</SceneTransition>);
    expect(input.isConnected).toBe(true); expect(screen.queryByRole('textbox')).toBeNull();
    expect(wipeOf(view.container)).toHaveLength(0);
    view.rerender(<SceneTransition scene="terms" persistent>{children(true)}</SceneTransition>);
    expect(wipeOf(view.container)).toHaveLength(0);
    view.rerender(<SceneTransition scene="chat" persistent>{children(false)}</SceneTransition>);
    expect(screen.getByRole('textbox')).toBe(input); expect(input.value).toBe('尚未发送');
  });
  it('first mount renders the scene without a curtain (opening the app must not show a wipe)', () => {
    const { container } = render(
      <SceneTransition scene="chat">
        <p>对话</p>
      </SceneTransition>,
    );
    expect(screen.getByText('对话')).toBeTruthy();
    expect(container.querySelector('.sb-scene')?.getAttribute('data-scene')).toBe('chat');
    expect(wipeOf(container)).toHaveLength(0);
  });

  it('a scene change swaps content synchronously and lays exactly one decorative curtain', () => {
    const { container, rerender } = render(
      <SceneTransition scene="chat">
        <p>对话</p>
      </SceneTransition>,
    );
    rerender(
      <SceneTransition scene="terms">
        <p>词条</p>
      </SceneTransition>,
    );
    // 内容不等幕布：切换的同一帧新场景就在屏上、旧场景已卸载
    expect(screen.getByText('词条')).toBeTruthy();
    expect(screen.queryByText('对话')).toBeNull();
    expect(container.querySelector('.sb-scene')?.getAttribute('data-scene')).toBe('terms');
    const wipe = theWipe(container);
    // 纯装饰：不进辅助技术、没有任何可交互后代、默认不盖整屏（full 才 fixed）
    expect(wipe.getAttribute('aria-hidden')).toBe('true');
    expect(wipe.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(wipe.classList.contains('is-full')).toBe(false);
  });

  it('re-rendering with the same scene does not lay a curtain; the curtain leaves once its animation ends', () => {
    const { container, rerender } = render(
      <SceneTransition scene="chat">
        <p>A</p>
      </SceneTransition>,
    );
    rerender(
      <SceneTransition scene="chat">
        <p>B</p>
      </SceneTransition>,
    );
    expect(screen.getByText('B')).toBeTruthy();
    expect(wipeOf(container)).toHaveLength(0);
    rerender(
      <SceneTransition scene="cards">
        <p>C</p>
      </SceneTransition>,
    );
    act(() => {
      fireEvent.animationEnd(theWipe(container));
    });
    expect(wipeOf(container)).toHaveLength(0);
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('rapid consecutive switches replace the curtain instead of stacking them', () => {
    const { container, rerender } = render(
      <SceneTransition scene="chat">
        <p>1</p>
      </SceneTransition>,
    );
    for (const scene of ['terms', 'cards', 'continent', 'settings']) {
      rerender(
        <SceneTransition scene={scene}>
          <p>{scene}</p>
        </SceneTransition>,
      );
      expect(wipeOf(container)).toHaveLength(1);
    }
    expect(screen.getByText('settings')).toBeTruthy();
  });

  it('honours prefers-reduced-motion: content still swaps but no curtain node is ever rendered', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({ matches: q.includes('prefers-reduced-motion'), media: q })),
    );
    const { container, rerender } = render(
      <SceneTransition scene="chat">
        <p>对话</p>
      </SceneTransition>,
    );
    rerender(
      <SceneTransition scene="terms">
        <p>词条</p>
      </SceneTransition>,
    );
    expect(screen.getByText('词条')).toBeTruthy();
    expect(wipeOf(container)).toHaveLength(0);
  });

  it('full mode marks stage and curtain as viewport-wide (root-level Landing / App / PK swap)', () => {
    const { container, rerender } = render(
      <SceneTransition scene="landing" full>
        <p>门面</p>
      </SceneTransition>,
    );
    expect(container.querySelector('.sb-scene-stage')?.classList.contains('is-full')).toBe(true);
    rerender(
      <SceneTransition scene="app" full>
        <p>应用</p>
      </SceneTransition>,
    );
    expect(theWipe(container).classList.contains('is-full')).toBe(true);
  });
});

describe('BootScreen', () => {
  it('is a live status region with the brand name and keeps the mascot decorative', () => {
    const { container } = render(<BootScreen />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('studentbuddy');
    expect(status.textContent).toContain('正在进入营地');
    expect(container.querySelector('.welcome-mascot')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.sb-boot-bar')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('button, a, input')).toHaveLength(0);
  });
});
