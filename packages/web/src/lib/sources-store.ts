/**
 * sources-store —— 右侧「资料架」面板的状态件（契约 docs/SOURCE-TRACE-SPEC.md §8）。
 *
 * 与 `preview-store.ts` 同一手法：微型外部 store + useSyncExternalStore，
 * 因为触发点散在三处——SSE 分派（chat-blocks，live 整表替换）、消息脚注「资料 n 条」（历史重开）、
 * 正文 `[n]` 引用（跳到第 n 条）——而面板挂在应用壳右侧，provider 穿层不值得。
 *
 * 三条行为口径：
 *  - **live 帧整表替换、保持当前选中**：AI 每搜一次 / 读一页架子就变一次；用户正在看第 3 条时不能被跳走。
 *    只有「还没选过」或「选中的条目被挤掉了」才自动落到最值得看的那条（精选 > 在读 > 首条）。
 *  - **本轮关过就不再自动弹**：`dismissedTurn` 记住用户在这一轮点过关闭；下一轮（新的 turnKey）重新允许。
 *  - **归位到消息**：`takeTurnSources` 在回答收口时被 useChatStream 调一次，把本轮架子挂到那条回答上
 *    （随后同一份数据由 `/messages` 的 `sources` 列接力），消费后清标记，避免下一轮无搜索的回答误挂旧架。
 *  - **单条可叉掉**（2026-09-30，`removeSource`）：架子越堆越长时用户要能把没用的一条条清走。叉掉按**网址**记在
 *    本会话的隐藏表里（页面级、不落库）：live 整表替换与收口归位都先过这张表，否则下一帧就把它端回来。
 *    刷新页面后历史消息的架子会恢复原样——这是有意的最小做法：叉掉是"我现在不想看"，不是"删资料"。
 */
import { useSyncExternalStore } from 'react';
import { orderSources, type SourceItem, type SourcesBlockPayload } from '@sb/shared';

export interface SourcesState {
  open: boolean;
  sessionId: string;
  items: SourceItem[];
  /** 当前选中条目的编号（不是数组下标：编号才是跨帧稳定的身份） */
  activeN: number | null;
  /** AI 正在读的那条（live 帧带来；历史打开时为空） */
  readingN: number | null;
  /** 面板正在展示的是不是进行中的一轮（true 时显示「AI 正在看」的口吻） */
  live: boolean;
}

const EMPTY: SourcesState = { open: false, sessionId: '', items: [], activeN: null, readingN: null, live: false };
let state: SourcesState = EMPTY;
/** 本轮（sessionId 维度）尚未归位到消息的架子；`takenAt` 见 takeTurnSources */
let pendingTurn: { sessionId: string; items: SourceItem[]; takenAt?: number } | null = null;
/** 用户在这一轮里关过面板：sessionId → 该轮首帧到达时间戳（作为轮次身份） */
let dismissed: { sessionId: string; turn: number } | null = null;
let turnStamp = 0;
/** 用户叉掉的资料：sessionId → 网址集合（页面级；见文件头「单条可叉掉」） */
const hidden = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

const visible = (sessionId: string, items: SourceItem[]): SourceItem[] => {
  const h = hidden.get(sessionId);
  return h && h.size > 0 ? items.filter((s) => !h.has(s.url)) : items;
};

const emit = (): void => {
  for (const l of listeners) l();
};
export const subscribeSources = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getSources = (): SourcesState => state;
export function useSources(): SourcesState {
  return useSyncExternalStore(subscribeSources, getSources, getSources);
}

/** 最值得先看的那条：精选 > 在读 > 排序后的首条 */
function preferred(items: SourceItem[], readingN: number | null): number | null {
  const ordered = orderSources(items);
  const pick = ordered.find((s) => s.origin === 'pick');
  if (pick) return pick.n;
  if (readingN !== null && items.some((s) => s.n === readingN)) return readingN;
  return ordered[0]?.n ?? null;
}

/** live：SSE block(kind=sources) 整表替换（chat-blocks 分派调用） */
export function applyLiveSources(p: SourcesBlockPayload): void {
  const sameTurn = state.live && state.sessionId === p.sessionId && pendingTurn?.sessionId === p.sessionId && pendingTurn.takenAt === undefined;
  if (!sameTurn) turnStamp += 1; // 单调计数而不是 Date.now()：同一毫秒内收口又开新轮会撞号
  const items = visible(p.sessionId, p.items);
  pendingTurn = { sessionId: p.sessionId, items };
  const readingN = p.readingN ?? null;
  const keep = state.activeN !== null && items.some((s) => s.n === state.activeN) && state.sessionId === p.sessionId;
  const suppressed = dismissed !== null && dismissed.sessionId === p.sessionId && dismissed.turn === turnStamp;
  state = {
    open: suppressed ? state.open && state.live : true,
    sessionId: p.sessionId,
    items,
    activeN: keep ? state.activeN : preferred(items, readingN),
    readingN,
    live: true,
  };
  emit();
}

/** 历史 / 引用：打开某条回答的资料架，可指定先看第 n 条 */
export function openSources(sessionId: string, all: SourceItem[], n?: number): void {
  const items = visible(sessionId, all);
  if (items.length === 0) return;
  const activeN = n !== undefined && items.some((s) => s.n === n) ? n : preferred(items, null);
  state = { open: true, sessionId, items, activeN, readingN: null, live: false };
  emit();
}

/** 引用芯片：面板已在显示这份架子就只切条目并确保打开；否则按这份架子重新打开（历史消息各有各的架） */
export function showSource(sessionId: string, items: SourceItem[], n: number): void {
  if (state.items === items) {
    if (!items.some((s) => s.n === n)) return;
    state = { ...state, open: true, activeN: n };
    emit();
    return;
  }
  openSources(sessionId, items, n);
}

export function selectSource(n: number): void {
  if (!state.items.some((s) => s.n === n) || state.activeN === n) return;
  state = { ...state, activeN: n };
  emit();
}

/** 按面板顺序（精选 → 读过 → 搜到）前后切换，两端回绕 */
export function stepSource(delta: 1 | -1): void {
  const ordered = orderSources(state.items);
  if (ordered.length === 0) return;
  const i = ordered.findIndex((s) => s.n === state.activeN);
  const next = ordered[(i + delta + ordered.length) % ordered.length];
  if (next) selectSource(next.n);
}

/** 按面板顺序选第 k 条（Alt+1..9） */
export function selectSourceAt(k: number): void {
  const target = orderSources(state.items)[k - 1];
  if (target) selectSource(target.n);
}

export function closeSources(): void {
  if (!state.open) return;
  if (state.live) dismissed = { sessionId: state.sessionId, turn: turnStamp };
  state = { ...state, open: false };
  emit();
}

/**
 * 叉掉第 n 条：从当前架上拿掉并记入本会话隐藏表（之后的 live 帧 / 归位 / 历史重开都不再露面）。
 * 正在看的那条被叉掉 ⇒ 落到剩下里最值得看的；一条不剩 ⇒ 面板收起（空面板没有意义）。
 */
export function removeSource(n: number): void {
  const target = state.items.find((s) => s.n === n);
  if (!target) return;
  const set = hidden.get(state.sessionId) ?? new Set<string>();
  set.add(target.url);
  hidden.set(state.sessionId, set);
  const items = state.items.filter((s) => s.n !== n);
  if (pendingTurn && pendingTurn.sessionId === state.sessionId) pendingTurn = { ...pendingTurn, items: visible(state.sessionId, pendingTurn.items) };
  state = {
    ...state,
    items,
    open: items.length > 0 && state.open,
    activeN: state.activeN === n ? preferred(items, state.readingN) : state.activeN,
    readingN: state.readingN === n ? null : state.readingN,
  };
  emit();
}

/**
 * 回答收口：取走本轮架子挂到消息上（会话不符或没有架子 ⇒ 空对象，不给消息塞空键）。
 * ★ 调用点在 `setMessages` 的 updater 里，StrictMode 下 updater 会被**同步调两遍**——
 *   所以不是「取一次就清」，而是记下取走时刻：同一秒内重复取给同一结果，之后才视为已消费
 *   （下一轮无搜索的回答不能误挂上一轮的架子）。
 */
export function takeTurnSources(sessionId: string | null): { sources?: SourceItem[] } {
  if (!sessionId || !pendingTurn || pendingTurn.sessionId !== sessionId) return {};
  const now = Date.now();
  if (pendingTurn.takenAt !== undefined && now - pendingTurn.takenAt > 1000) {
    pendingTurn = null;
    return {};
  }
  pendingTurn.takenAt ??= now;
  const items = visible(sessionId, pendingTurn.items);
  if (state.live && state.sessionId === sessionId) {
    state = { ...state, live: false, readingN: null };
    // 调用方在 setMessages 的 updater 里（ChatView 渲染中）：通知放到微任务，避免「渲染 A 时更新 B」告警
    queueMicrotask(emit);
  }
  return items.length > 0 ? { sources: items } : {};
}

/** 测试用：回到初始态 */
export function resetSourcesStore(): void {
  state = EMPTY;
  pendingTurn = null;
  dismissed = null;
  turnStamp = 0;
  hidden.clear();
  emit();
}

/** 面板里每条资料的 iframe 地址（阅读页 / PDF 转发 / 官方播放器由面板按 kind 决定） */
export function readerUrl(sessionId: string, s: SourceItem): string {
  const q = new URLSearchParams({ session: sessionId, url: s.url, title: s.title });
  return `/api/sources/${s.kind === 'pdf' ? 'pdf' : 'view'}?${q.toString()}`;
}
