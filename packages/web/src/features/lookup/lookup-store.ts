/**
 * lookup-store —— 划词速查小窗的状态（契约 `docs/LOOKUP-SPEC.md` §5）。
 *
 * 为什么是全局 store 而不是 ReaderView 的局部 state：小窗要能从**多处**打开
 *（侧栏阅读器的划线、将来对话正文里的划词都该是同一个窗），而它挂在应用壳层、
 * 不在任何一个面板的子树里——与 `sources-store` / `preview-store` 同一手法。
 *
 * ★ 一次只开一个窗：划新的一段就**换内容**而不是叠一摞窗口。
 *   学习者同时想看两个词的情况极少，而满屏浮窗的代价很大。
 */
import { useSyncExternalStore } from 'react';
import type { LookupContext } from '@sb/shared';

export interface LookupState {
  open: boolean;
  /** 送给三个动作的材料（划中句 + 章节 + 出处），小窗顶部**原样显示** `text` */
  ctx: LookupContext | null;
  /** 锚点（视口坐标），小窗据此定位 */
  x: number;
  y: number;
  /** 打开时就想直接跑的动作；'wiki' 是默认（免费优先） */
  initial: 'wiki' | 'explain' | 'quiz';
}

const EMPTY: LookupState = { open: false, ctx: null, x: 0, y: 0, initial: 'wiki' };
let state: LookupState = EMPTY;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of listeners) l();
};

export const subscribeLookup = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getLookup = (): LookupState => state;
export function useLookup(): LookupState {
  return useSyncExternalStore(subscribeLookup, getLookup, getLookup);
}

export function openLookup(ctx: LookupContext, x: number, y: number, initial: LookupState['initial'] = 'wiki'): void {
  state = { open: true, ctx, x, y, initial };
  emit();
}

export function closeLookup(): void {
  state = EMPTY;
  emit();
}
