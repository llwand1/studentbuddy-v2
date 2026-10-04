/**
 * reader-selection —— 从 DOM 选区读出「划了哪段、落在哪几块」（契约 `docs/SOURCE-TRACE-SPEC.md` §14.3）。
 *
 * 这是整个划线功能能成立的原因：阅读页从 sandbox iframe 改成**主文档里的 React 渲染**之后，
 * `window.getSelection()` 直接就能拿到选区——不再需要向 iframe 注入任何脚本
 * （契约 §9「阅读页零脚本」那条承诺因此得以原样保留）。
 *
 * 块 id 怎么来：`ReaderBlocks` 给每个块挂 `data-rb="{id}"`，这里从选区两端各自 `closest('[data-rb]')`
 * 往上找，再取这两块之间的**文档序区间**——跨段落划线也能正确定位到起始块（章节反查只认第一块）。
 *
 * ★ 与 `features/chat/QuoteAsk.tsx` 同一套手法（`selectionchange` 去抖 + 选区塌缩即收起 +
 *   位置走 CSS 变量不走内联 style），因为那边已经把鼠标拖选 / Shift+方向键 / 触屏拉柄三种来路趟平了。
 */
import { isUsableSelection } from '@sb/shared';

export interface ReaderHit {
  text: string;
  /** 选区覆盖到的块 id，按文档序；第一块用来反查章节 */
  blockIds: string[];
  /** 浮动工具条的锚点（视口坐标，选区下沿居中） */
  x: number;
  y: number;
}

/** 元素（或文本节点的父元素）所属的块 id */
function blockIdOf(node: Node | null): string | null {
  const el = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const holder = el?.closest('[data-rb]');
  return holder?.getAttribute('data-rb') ?? null;
}

/**
 * 读当前选区。必须**整段落在 `root` 里**，否则返回 null——
 * 用户在面板标题栏、确认条、工具条上划中的文字不是正文，不该让三个动作亮起来。
 */
export function readReaderSelection(root: HTMLElement | null): ReaderHit | null {
  if (!root || typeof document === 'undefined') return null;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!isUsableSelection(text)) return null;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const startId = blockIdOf(range.startContainer);
  const endId = blockIdOf(range.endContainer);
  if (!startId) return null;

  // 文档序区间：从起始块一路收到结束块（单块选区时就一个）
  const all = [...root.querySelectorAll('[data-rb]')].map((el) => el.getAttribute('data-rb') ?? '');
  const from = all.indexOf(startId);
  const to = endId ? all.indexOf(endId) : from;
  const blockIds = from >= 0 && to >= from ? all.slice(from, to + 1).filter(Boolean) : [startId];

  const rect = range.getBoundingClientRect();
  return { text, blockIds, x: rect.left + rect.width / 2, y: rect.bottom };
}

/**
 * 工具条的视口夹取：选区贴着面板边缘时，浮条不能飘到屏幕外。
 * 纯函数单独拿出来是因为 jsdom 没有布局，位置逻辑只能这样测。
 */
export function clampToolbar(x: number, y: number, vw: number, vh: number, w = 220, h = 44): { x: number; y: number } {
  const half = w / 2;
  return {
    x: Math.min(Math.max(x, half + 8), Math.max(half + 8, vw - half - 8)),
    // 下方放不下就翻到选区上方
    y: y + h + 8 > vh ? Math.max(8, y - h - 24) : y + 8,
  };
}
