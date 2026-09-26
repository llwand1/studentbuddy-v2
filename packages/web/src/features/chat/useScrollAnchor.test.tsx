// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useScrollAnchor } from './useScrollAnchor';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Harness({ count = 0 }: { count?: number }) {
  const anchor = useScrollAnchor([count], count > 0);
  return <>
    <div data-testid="scroll" ref={(el) => {
      if (el) { Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 }); }
      anchor.scrollRef.current = el;
    }} onScroll={anchor.onScroll} />
    {anchor.showJump && <button onClick={anchor.jumpToBottom}>回到底部</button>}
  </>;
}
describe('welcome and conversation scrolling', () => {
  it('starts a tall welcome at the top and anchors the first real message at the bottom', () => {
    const view = render(<Harness />);
    const scroll = screen.getByTestId('scroll');
    expect(scroll.scrollTop).toBe(0);
    fireEvent.scroll(scroll, { target: { scrollTop: 120 } });
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(<Harness count={1} />);
    expect(scroll.scrollTop).toBe(1000);
  });
  it('does not pull a reader back down during streaming, and resets on returning to welcome', () => {
    const view = render(<Harness count={1} />);
    const scroll = screen.getByTestId('scroll');
    fireEvent.scroll(scroll, { target: { scrollTop: 100 } });
    view.rerender(<Harness count={2} />);
    expect(scroll.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '回到底部' })).toBeTruthy();
    view.rerender(<Harness />);
    expect(scroll.scrollTop).toBe(0);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('respects reduced motion when the reader jumps to the newest message', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<Harness count={1} />);
    const scroll = screen.getByTestId('scroll');
    scroll.scrollTo = vi.fn();
    fireEvent.scroll(scroll, { target: { scrollTop: 100 } });
    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(scroll.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
  });
});
