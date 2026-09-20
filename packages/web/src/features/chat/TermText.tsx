/**
 * TermText — 正文里的一段纯文本，按词条命中切成高亮 span（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §3）。
 *
 * ★ **卡片走 `createPortal` 到 body**：正文的宿主元素是 `<p>` / `<li>` / `<td>`，
 *   而卡片是 `<div>`——直接内联会构成非法嵌套（`<p>` 里不能有 `<div>`），
 *   且会被 `.chat-scroll` 的 `overflow` 裁掉。portal 让卡片既合法、又不受裁剪。
 * ★ **无命中时直接返回纯文本**（不包 span、不多加节点）：正文绝大多数片段没有命中，
 *   给每个片段套一层节点会白白改变既有 DOM 结构与样式命中面。
 * ★ **首现强调的口径 = 「本片段内首现」**（片段 = 一个段落 / 列表项 / 引用行 / 单元格）。
 *   「整条回复内首现」需要知道块在全文中的字符偏移，而 `parseBlocks` 只给块、不给偏移；
 *   块内首现已能消除长回复的主要视觉噪声（契约 §3 已记账，不为此改块协议）。
 * ★ **每个高亮 span 挂两个 data**：`data-term`（主词条名，用于查卡片）与
 *   `data-say`（命中原文，用于发音的判定与朗读，契约 §3.1 v1.1）。两者**不能合并**——
 *   别名命中时正文显示 `closure`、`data-term` 却是 `闭包`，发音必须读前者。
 * ★ **代码不在此列**：行内 `code` 与围栏代码块走各自的渲染分支，不经本组件
 *   （代码里出现 `let` 是语法，标成词条是污染）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTermIndex } from './term-index';
import { TermCard } from './TermCard';

interface Active {
  term: string;
  /**
   * 正文里**显示的那段文本**（命中原文）——发音的判定与朗读共用它（契约 §3.1，v1.1）。
   * ★ 不能拿 `term`（主词条名）代替：别名命中时正文显示 `closure`、`term` 却是 `闭包`，
   *   用后者会漏掉喇叭按钮、或把中文交给英文语音读。
   */
  say: string;
  variant: 'mini' | 'full';
  /** 定位锚点（命中的那个 span） */
  anchor: HTMLElement;
}

/** 从事件目标找到命中的高亮 span（无 `any`、无非空断言） */
function hitEl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest('.term-hl');
  return el instanceof HTMLElement ? el : null;
}

/** 卡片定位（fixed 坐标）：优先词条上方，空间不足翻到下方；左右夹在视口内 */
function placeCard(card: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  let top = r.top - h - 10;
  let below = false;
  if (top < 8) {
    top = r.bottom + 10;
    below = true;
  }
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - h - 8)))}px`;
  card.classList.toggle('below', below);
}

export function TermText({ text }: { text: string }) {
  const { ready, find, lookup, refresh, openTerms } = useTermIndex();
  /** 命中在索引就绪前恒为空 ⇒ 首屏不闪、不误标 */
  const hits = useMemo(() => (ready ? find(text) : []), [ready, find, text]);

  const [active, setActive] = useState<Active | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  /** 延迟关闭：给鼠标从词条移到卡片留出路径（不留就等于卡片不可点） */
  const scheduleClose = useCallback((): void => {
    clearTimer();
    closeTimer.current = window.setTimeout(() => setActive(null), 140);
  }, [clearTimer]);

  const closeNow = useCallback((): void => {
    clearTimer();
    setActive(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  /**
   * 滚动 / 缩放 / Esc 一律关闭。卡片是 fixed 定位，锚点一移动位置就失效——
   * 与其追着锚点重算（滚动每帧都要算，且固定态卡片会「粘」在旧位置），
   * 不如直接关掉：重新悬停的成本极低。
   */
  useEffect(() => {
    if (!active) return;
    const onAway = (): void => closeNow();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNow();
    };
    window.addEventListener('scroll', onAway, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onAway, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, closeNow]);

  /** 完整卡：点空白处关闭（点高亮词本身不关，那是切换目标） */
  useEffect(() => {
    if (!active || active.variant !== 'full') return;
    const onDown = (e: globalThis.MouseEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && (cardRef.current?.contains(t) || t.closest('.term-hl'))) return;
      closeNow();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [active, closeNow]);

  /** 渲染后定位（要在卡片量到尺寸之后，故用 layout effect） */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card && active) placeCard(card, active.anchor);
  }, [active]);

  const onOver = (e: MouseEvent<HTMLSpanElement>): void => {
    if (active?.variant === 'full') return; // 完整卡固定中，悬停不抢
    const el = hitEl(e.target);
    const term = el?.dataset.term;
    const say = el?.dataset.say;
    if (!el || !term || say === undefined) return;
    clearTimer();
    setActive({ term, say, variant: 'mini', anchor: el });
  };

  const onOut = (e: MouseEvent<HTMLSpanElement>): void => {
    if (active?.variant === 'full') return;
    if (!hitEl(e.target)) return;
    scheduleClose();
  };

  const onClick = (e: MouseEvent<HTMLSpanElement>): void => {
    const el = hitEl(e.target);
    const term = el?.dataset.term;
    const say = el?.dataset.say;
    if (!el || !term || say === undefined) return;
    clearTimer();
    setActive({ term, say, variant: 'full', anchor: el });
  };

  /** 无命中：直接返回纯文本（不包 span、不加节点——正文绝大多数片段走这条路） */
  if (hits.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  const seen = new Set<string>();
  let pos = 0;
  hits.forEach((h) => {
    if (h.start > pos) parts.push(text.slice(pos, h.start));
    const first = !seen.has(h.term);
    seen.add(h.term);
    // 命中原文：既是要显示的字，也是发音按钮的判定与朗读输入（`data-say`，契约 §3.1）
    const shown = text.slice(h.start, h.end);
    parts.push(
      <span
        key={`${h.start}-${h.term}`}
        className={first ? 'term-hl first' : 'term-hl again'}
        data-term={h.term}
        data-say={shown}
      >
        {shown}
      </span>,
    );
    pos = h.end;
  });
  if (pos < text.length) parts.push(text.slice(pos));

  const item = active ? lookup(active.term) : undefined;

  return (
    <>
      <span className="term-text" onMouseOver={onOver} onMouseOut={onOut} onClick={onClick}>
        {parts}
      </span>
      {active && item
        ? createPortal(
            <div
              ref={cardRef}
              className="term-card-layer"
              onMouseEnter={clearTimer}
              onMouseLeave={() => {
                if (active.variant === 'mini') scheduleClose();
              }}
            >
              <TermCard
                /* ★ key 绑当前词条：悬停从词 A 移到词 B 时**重挂载**卡片。
                   不重挂载会有两个错：① A 的操作提示（「已移出复习范围」）会挂在 B 的卡上；
                   ② 发音的进行中状态跨词残留，B 的喇叭一上来就是禁用的。 */
                key={active.term}
                item={item}
                say={active.say}
                variant={active.variant}
                onClose={closeNow}
                onChanged={refresh}
                {...(openTerms ? { onOpenTerms: openTerms } : {})}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
