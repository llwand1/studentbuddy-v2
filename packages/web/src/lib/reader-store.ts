/**
 * reader-store —— 侧栏阅读器的**导航状态**（契约 `docs/SOURCE-TRACE-SPEC.md` §14.2）。
 *
 * 为什么需要它：阅读页以前是一张 iframe，「当前在看哪一页」等于 iframe 的 src，浏览器替我们记着。
 * 改成主文档渲染之后，前进后退、跳转确认、加载中/失败态都得自己拿着——于是有了这个状态件。
 *
 * 三条口径：
 *  ① **每一跳都要人点头**：阅读页里的链接不直接跳，先进 `pending`（确认条），
 *     用户点「在侧栏打开」才 `POST /api/sources/follow` 登记许可、再取页。
 *     这是授权模型本身（§14.2）——把人设成闸门，每一次越界都对应一次明确的人类点击。
 *  ② **历史栈按会话隔离**：换会话即清空。上一个会话的浏览足迹不该出现在新会话的「返回」里。
 *  ③ **资料架切条目 = 新的一次阅读**：从标签页点到第 3 条资料时历史清空，
 *     因为「返回」在那个语境下应该指「回到第 3 条的上一页」，不是「回到第 2 条资料」。
 */
import { useSyncExternalStore } from 'react';
import type { ReaderPageResult } from '@sb/shared';

export interface ReaderNavState {
  sessionId: string;
  /** 当前正在读的网址（可能是资料架上的，也可能是点进去的） */
  url: string;
  title: string;
  page: ReaderPageResult | null;
  loading: boolean;
  /** 等用户点头的那一跳；null ＝ 没有待确认的跳转 */
  pending: { url: string; site: string; label: string } | null;
  /** 可返回的历史（不含当前页） */
  stack: { url: string; title: string }[];
  /** 跳转被拒 / 取页失败时给人看的一句话（ADR-5 不静默） */
  notice: string;
}

const EMPTY: ReaderNavState = { sessionId: '', url: '', title: '', page: null, loading: false, pending: null, stack: [], notice: '' };
let state: ReaderNavState = EMPTY;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of listeners) l();
};
const set = (patch: Partial<ReaderNavState>): void => {
  state = { ...state, ...patch };
  emit();
};

export const subscribeReader = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getReaderNav = (): ReaderNavState => state;
export function useReaderNav(): ReaderNavState {
  return useSyncExternalStore(subscribeReader, getReaderNav, getReaderNav);
}

/** 站名：只用来在确认条上告诉人「要去哪」，取不出就原样显示网址 */
export function siteLabelOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * 面板切到某条资料（或换会话）⇒ 这是一次**全新的阅读**：历史清空、确认条收起。
 * 口径 ②③ 都落在这一个入口上。
 */
export function startReading(sessionId: string, url: string, title: string): void {
  if (state.sessionId === sessionId && state.url === url) return;
  state = { ...EMPTY, sessionId, url, title, loading: true };
  emit();
}

export function readerLoaded(url: string, page: ReaderPageResult): void {
  if (state.url !== url) return; // 迟到的响应：用户已经翻走了，丢弃（不覆盖当前页）
  set({ page, loading: false, title: page.ok ? page.title || state.title : state.title });
}

/** 阅读页里点了链接：不跳，先挂确认条（口径 ①） */
export function askFollow(url: string, label: string): void {
  set({ pending: { url, site: siteLabelOf(url), label }, notice: '' });
}

export function cancelFollow(): void {
  set({ pending: null });
}

/** 用户点了头：把当前页压栈、切到新页（许可登记由调用方先完成） */
export function commitFollow(url: string, title: string): void {
  const stack = state.url ? [...state.stack, { url: state.url, title: state.title }].slice(-20) : state.stack;
  set({ stack, url, title, page: null, loading: true, pending: null, notice: '' });
}

/** 返回上一页；栈空时什么都不做（按钮那时是禁用的） */
export function readerBack(): void {
  const prev = state.stack[state.stack.length - 1];
  if (!prev) return;
  set({ stack: state.stack.slice(0, -1), url: prev.url, title: prev.title, page: null, loading: true, pending: null, notice: '' });
}

export function readerNotice(line: string): void {
  set({ notice: line, loading: false, pending: null });
}

export function resetReaderNav(): void {
  state = EMPTY;
  emit();
}
