/**
 * video-route-store —— 资料架「视频线路」的状态件（契约 docs/SOURCE-TRACE-SPEC.md §12.3）。
 *
 * 与 `sources-store` 分开：架子是 AI 这一轮引用的资料（编号即身份、随消息落库），视频线路是**学习者自己**
 * 点出来的一次搜索（不编号、不落库、刷新即散）。两者只在面板层会合：视频线路打开时面板显示它，关掉回到架子。
 *
 * 行为口径：
 *  - **一次一条线路一个词**：切线路即重搜（结果按线路各留一份，来回切不重搜）；改词要按「搜」或回车才搜。
 *  - **旧请求作废**：连续搜两次只认最后一次的结果（AbortController 掐掉前一次，并按序号丢迟到的）。
 *  - **就地播只给 B站**：`playing` 只会是 `route:'bilibili'` 的命中；抖音卡片由面板直接开新标签页。
 *  - 打开时若给了种子词而当前词为空 ⇒ 用种子词并**立即搜一次**（学习者点「找视频」就该看到结果，不该再点一次）。
 */
import { useSyncExternalStore } from 'react';
import { cleanVideoQuery, type VideoHit, type VideoRoute, type VideoRouteResult } from '@sb/shared';
import { searchVideos } from './api-sources';

export type VideoPhase = 'idle' | 'loading' | 'done' | 'error';

export interface VideoRouteState {
  open: boolean;
  sessionId: string;
  route: VideoRoute;
  query: string;
  phase: VideoPhase;
  /** 当前线路当前词的结果（`phase === 'done'` 时非空） */
  result: VideoRouteResult | null;
  error: string;
  /** 正在就地播的 B站命中 */
  playing: VideoHit | null;
}

const EMPTY: VideoRouteState = { open: false, sessionId: '', route: 'bilibili', query: '', phase: 'idle', result: null, error: '', playing: null };
let state: VideoRouteState = EMPTY;
/** 每条线路最近一次成功的结果（同词才复用） */
const perRoute = new Map<VideoRoute, VideoRouteResult>();
let ac: AbortController | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of listeners) l();
};
export const subscribeVideoRoute = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getVideoRoute = (): VideoRouteState => state;
export function useVideoRoute(): VideoRouteState {
  return useSyncExternalStore(subscribeVideoRoute, getVideoRoute, getVideoRoute);
}

const set = (patch: Partial<VideoRouteState>): void => {
  state = { ...state, ...patch };
  emit();
};

/** 打开视频线路；`seed` 只在当前词为空（或换了会话）时生效，并立即搜一次 */
export function openVideoRoute(sessionId: string, seed = ''): void {
  const fresh = state.sessionId !== sessionId;
  const query = fresh || !state.query ? cleanVideoQuery(seed) : state.query;
  if (fresh) {
    perRoute.clear();
    ac?.abort();
    ac = null;
    state = { ...EMPTY, sessionId, route: state.route };
  }
  set({ open: true, sessionId, query });
  if (query && (fresh || state.phase === 'idle' || state.result?.query !== query)) void runVideoSearch();
}

export function closeVideoRoute(): void {
  if (!state.open) return;
  set({ open: false, playing: null });
}

export function setVideoQuery(query: string): void {
  if (query === state.query) return;
  set({ query });
}

/** 切线路：该线路已有**同词**结果就直接换上，否则立即搜 */
export function setVideoRoute(route: VideoRoute): void {
  if (route === state.route) return;
  const cached = perRoute.get(route);
  const q = cleanVideoQuery(state.query);
  if (cached && cached.query === q) {
    set({ route, result: cached, phase: 'done', error: '', playing: null });
    return;
  }
  set({ route, result: null, phase: q ? 'loading' : 'idle', error: '', playing: null });
  if (q) void runVideoSearch();
}

/** 搜一次（当前线路 + 当前词）；空词不搜。返回的 Promise 只为测试等待，UI 不需要 */
export async function runVideoSearch(): Promise<void> {
  const query = cleanVideoQuery(state.query);
  if (!query) return;
  ac?.abort();
  const mine = new AbortController();
  ac = mine;
  const my = ++seq;
  const route = state.route;
  set({ query, phase: 'loading', error: '', playing: null });
  try {
    const result = await searchVideos(route, query, mine.signal);
    if (my !== seq) return; // 迟到的旧结果：丢
    perRoute.set(route, result);
    set({ phase: 'done', result, error: '' });
  } catch (e) {
    if (my !== seq || mine.signal.aborted) return;
    set({ phase: 'error', result: null, error: e instanceof Error ? e.message : '视频线路没搜成' });
  }
}

/** 就地播（只认 B站命中；抖音卡片不会调到这里） */
export function playVideo(hit: VideoHit | null): void {
  if (hit && hit.route !== 'bilibili') return;
  if (hit === state.playing) return;
  set({ playing: hit });
}

/** 测试用 */
export function resetVideoRouteStore(): void {
  ac?.abort();
  ac = null;
  seq = 0;
  perRoute.clear();
  state = EMPTY;
  emit();
}
