// @vitest-environment jsdom
/**
 * QuoteAsk：只认助手正文里的选区；点别处 / 滚动 ⇒ 收起；点小牌 ⇒ 回调选区文本。
 * 端到端（选区 → 输入框里的引用块 → 聚焦）在 ChatView.test.tsx。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';
import { QuoteAsk, readQuotableSelection } from './QuoteAsk';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.getSelection()?.removeAllRanges();
});
/** jsdom 没实现 Range#getBoundingClientRect：给一个固定矩形，顺便验证定位变量 */
const FAKE_RECT = { left: 100, right: 300, top: 40, bottom: 60, width: 200, height: 20, x: 100, y: 40, toJSON: () => ({}) } as DOMRect;
beforeEach(() => {
  vi.useFakeTimers();
  Range.prototype.getBoundingClientRect = () => FAKE_RECT;
});

/** 一段最小消息流：一条用户气泡、一条助手正文 */
function setup() {
  const rootRef = createRef<HTMLDivElement>();
  const onQuote = vi.fn();
  const r = render(
    <div>
      <div ref={rootRef} className="chat-scroll">
        <div className="chat-row user">
          <div className="chat-bubble">我的提问文字</div>
        </div>
        <div className="chat-row">
          <div className="chat-bubble md">
            <p>闭包＝函数 + 词法环境。</p>
          </div>
        </div>
      </div>
      <QuoteAsk rootRef={rootRef} onQuote={onQuote} />
    </div>,
  );
  return { ...r, rootRef, onQuote };
}

function select(node: Node, from: number, to: number): void {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
  });
}

describe('QuoteAsk', () => {
  it('选中助手正文 ⇒ 浮出小牌；点小牌 ⇒ 回调原文并收起', () => {
    const { container, onQuote } = setup();
    const p = container.querySelector('.chat-bubble.md p')!.firstChild!;
    select(p, 0, 5);
    const btn = container.querySelector('.chat-quote-btn') as HTMLButtonElement;
    expect(btn?.textContent).toBe('↩ 引用追问');
    // 定位走 CSS 变量（门禁禁内联 style）：横向取选区中点、纵向贴选区底边
    expect(btn.style.getPropertyValue('--qa-x')).toBe('200px');
    expect(btn.style.getPropertyValue('--qa-y')).toBe('60px');
    fireEvent.click(btn);
    expect(onQuote).toHaveBeenCalledWith('闭包＝函数');
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
  });

  it('选中的是用户自己的话 ⇒ 不浮牌（引用的语义是「你刚才说的这句」）', () => {
    const { container } = setup();
    const u = container.querySelector('.chat-row.user .chat-bubble')!.firstChild!;
    select(u, 0, 4);
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
  });

  it('单个字符 / 塌缩选区 ⇒ 不浮牌；点别处 ⇒ 收起；消息流滚动 ⇒ 收起', () => {
    const { container, rootRef } = setup();
    const p = container.querySelector('.chat-bubble.md p')!.firstChild!;
    select(p, 0, 1);
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
    select(p, 0, 4);
    expect(container.querySelector('.chat-quote-btn')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
    select(p, 0, 4);
    expect(container.querySelector('.chat-quote-btn')).toBeTruthy();
    fireEvent.scroll(rootRef.current!);
    expect(container.querySelector('.chat-quote-btn')).toBeNull();
  });

  it('readQuotableSelection：没有 root / 没有选区 ⇒ null', () => {
    expect(readQuotableSelection(null)).toBeNull();
    const { rootRef } = setup();
    document.getSelection()?.removeAllRanges();
    expect(readQuotableSelection(rootRef.current)).toBeNull();
  });
});
