/**
 * QuoteAsk —— 选中助手回答里的文字，浮出一枚「引用追问」小牌；点它把选区变成输入框里的引用块。
 *
 * 只认**助手正文**（`.chat-row:not(.user) .chat-bubble.md`）里的选区：用户自己的话、
 * 过程面板、题卡里的字都不算——引用的语义是「你刚才说的这句」。
 *
 * 事件口径：
 * · `selectionchange`（去抖 180ms）统一覆盖鼠标拖选、Shift+方向键、触屏拉柄三种来路；
 *   选区塌缩（点别处／Esc）⇒ 小牌收起。
 * · `mousedown` 在小牌之外 ⇒ 立刻收起（开始一段新选择时旧牌不该还挂着）；
 *   小牌自己的 mousedown 阻止默认行为——否则浏览器会先清掉选区、click 拿不到文本。
 * · 消息流滚动 ⇒ 收起（fixed 定位的小牌不跟着选区走，留着会飘在错的位置）。
 * 位置用 CSS 变量（`--qa-x/--qa-y`）写在元素上，不走内联 style（门禁红线），样式在 chat-extras.css。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { isQuotableSelection } from './quote-ask';

const DEBOUNCE_MS = 180;
const BTN_CLASS = 'chat-quote-btn';

interface Hit {
  text: string;
  x: number;
  y: number;
}

/** 读当前选区：必须整段落在 root 内的某条助手正文里，否则 null */
export function readQuotableSelection(root: HTMLElement | null): Hit | null {
  if (!root || typeof document === 'undefined') return null;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!isQuotableSelection(text)) return null;
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
  const bubble = el?.closest('.chat-row:not(.user) .chat-bubble.md');
  if (!bubble || !root.contains(bubble)) return null;
  const rect = range.getBoundingClientRect();
  return { text, x: rect.left + rect.width / 2, y: rect.bottom };
}

export function QuoteAsk({ rootRef, onQuote }: { rootRef: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  const [hit, setHit] = useState<Hit | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let timer = 0;
    const read = (): void => setHit(readQuotableSelection(rootRef.current));
    const onSelectionChange = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, DEBOUNCE_MS);
    };
    const onMouseDown = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest?.(`.${BTN_CLASS}`)) return;
      setHit(null);
    };
    const onScroll = (): void => setHit(null);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown);
    const root = rootRef.current;
    root?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown);
      root?.removeEventListener('scroll', onScroll);
    };
  }, [rootRef]);

  useEffect(() => {
    const el = btnRef.current;
    if (!el || !hit) return;
    el.style.setProperty('--qa-x', `${Math.round(hit.x)}px`);
    el.style.setProperty('--qa-y', `${Math.round(hit.y)}px`);
  }, [hit]);

  if (!hit) return null;
  return (
    <button
      ref={btnRef}
      type="button"
      className={BTN_CLASS}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(hit.text);
        setHit(null);
        document.getSelection()?.removeAllRanges();
      }}
    >
      ↩ 引用追问
    </button>
  );
}
