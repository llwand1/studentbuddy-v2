/**
 * sources/shelf —— 一轮回答的「资料架」（契约 docs/SOURCE-TRACE-SPEC.md §4）。
 *
 * 职责：把这一轮里 AI **搜到 / 读过 / 精选** 的网址收成一张有编号的表，每变一次就整表下发
 * （SSE `block` 帧、`payload.kind = 'sources'`），前端右侧面板整表替换——与 tasks 表同一套
 * 「整表下发」思路：帧可丢可重放，最后一帧永远是全貌。
 *
 * 三个不变量：
 *  1. **编号全轮唯一且只增**（`known` 记住每个网址第一次露面的号）：第二次搜索接着上次的号，
 *     模型看到的 `[n]`、架上的 n、正文引用的 n 是同一个数。上不了架（超出每次 5 条）的结果也占号，
 *     这样它稍后被 fetch_page 读到时仍以原号上架，不会出现「模型引用 [8] 而架上第 8 条是别的」。
 *  2. **架子有上限**（`SOURCE_SHELF_MAX`）：读过 / 精选优先级高，满了就挤掉编号最大的 `search` 条；
 *     `read`/`pick` 之间不互挤（一轮读十几页的情况极少，真到了就让最早读的留着——它们已经落在正文里）。
 *  3. **只收 http(s)**：模型编出来的 `javascript:`/`file:` 一律不上架也不编号。
 *
 * 注册表（`shelfOf`）是 reader 端点的许可依据：浏览器只能通过 `/api/sources/view` 打开
 * **架上有的**网址（在线架或已落库），本服务不是任意网址的代理。
 */
import {
  SOURCE_PER_SEARCH,
  SOURCE_PICK_MAX,
  SOURCE_SHELF_MAX,
  SOURCE_SNIPPET_MAX,
  SOURCE_TITLE_MAX,
  SOURCE_WHY_MAX,
  detectSourceKind,
  isShelvableUrl,
  siteOf,
  type SourceItem,
  type SourcesBlockPayload,
} from '@sb/shared';
import type { SearchResult } from '../search/types.js';
import { publish } from '../chat/sse-bus.js';

export interface PickInput {
  url: string;
  why: string;
}

export interface PickOutcome {
  picked: SourceItem[];
  /** 不在架上（本轮没搜到也没读过）的网址：原样回给模型，让它只挑真看过的 */
  unknown: string[];
}

/** 工具侧看到的资料架（挂在 ToolContext.sources 上；工具不关心发布与持久化） */
export interface SourceSink {
  /** 一次搜索的结果：给每条分配全轮编号并把前几条上架；返回与 results 等长的编号数组 */
  found(query: string, results: readonly SearchResult[]): number[];
  /** fetch_page 开始读：面板给它打「在读」标（不在架上的网址会先以 read 档上架占位） */
  reading(url: string): void;
  /** fetch_page 读完：升成 read 档、补标题；`ok=false`（没读到）只清「在读」标 */
  read(url: string, title: string | undefined, ok: boolean): void;
  /** pick_sources：最多 SOURCE_PICK_MAX 条精选，带理由 */
  pick(picks: readonly PickInput[]): PickOutcome;
  /** 当前架上全部条目（编号序）——落库与工具回灌都用它 */
  items(): SourceItem[];
  /** 本轮是否上过任何资料（没有就不落库、不发帧） */
  size(): number;
}

export interface SourceShelf extends SourceSink {
  readonly sessionId: string;
  /** 架上（含已挤出的 known 表）是否见过这个网址：reader 端点许可 */
  knows(url: string): boolean;
  /** 从在线注册表摘掉（测试与显式清理用；正常路径靠 TTL 与下一轮替换） */
  dispose(): void;
}

/**
 * 在线资料架注册表：sessionId → 最近一轮的架子。一轮一只，新一轮 create 时旧的自动被替换；
 * 不在轮末主动摘（flow.ts 贴着行数红线，且轮末落库前后面板上还开着这些资料）——
 * 改为每次 create 顺手清掉超过 `LIVE_TTL_MS` 没动静的旧架子。落库之后许可由 DB 表接力。
 */
const live = new Map<string, { shelf: SourceShelf; at: number }>();
const LIVE_TTL_MS = 2 * 60 * 60_000;

function pruneLive(now: number): void {
  for (const [k, v] of live) if (now - v.at > LIVE_TTL_MS) live.delete(k);
}

/** 在线注册表里查一个网址是否在该用户任一会话的架上（reader 端点许可用；无归属校验时按会话 id 查） */
export function liveShelfKnows(sessionId: string, url: string): boolean {
  return live.get(sessionId)?.shelf.knows(url) ?? false;
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 网址归一：去 hash、去尾斜杠——同一页不同写法只占一个号 */
export function normalizeSourceUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/' && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function createSourceShelf(sessionId: string): SourceShelf {
  /** 每个网址第一次露面的编号与元数据（含未上架的） */
  const known = new Map<string, { n: number; title: string; snippet?: string; query?: string }>();
  const shelf = new Map<number, SourceItem>();
  let next = 1;
  let readingN: number | undefined;

  const emit = (): void => {
    const payload: SourcesBlockPayload = {
      kind: 'sources',
      sessionId,
      items: items(),
      ...(readingN !== undefined ? { readingN } : {}),
    };
    publish(sessionId, { type: 'block', sessionId, blockId: `sources:${sessionId}`, done: false, payload });
  };

  const items = (): SourceItem[] => [...shelf.values()].sort((a, b) => a.n - b.n);

  /** 满了就挤掉编号最大的 search 条；没有可挤的（全是 read/pick）就放弃上架 */
  const makeRoom = (): boolean => {
    if (shelf.size < SOURCE_SHELF_MAX) return true;
    const victim = items()
      .filter((s) => s.origin === 'search')
      .pop();
    if (!victim) return false;
    shelf.delete(victim.n);
    return true;
  };

  const numberOf = (url: string, meta: { title: string; snippet?: string; query?: string }): number => {
    const k = normalizeSourceUrl(url);
    const hit = known.get(k);
    if (hit) {
      if (!hit.title && meta.title) hit.title = meta.title;
      return hit.n;
    }
    const n = next++;
    known.set(k, { n, ...meta });
    return n;
  };

  const place = (url: string, n: number, origin: SourceItem['origin'], extra: Partial<SourceItem> = {}): SourceItem | null => {
    const existing = shelf.get(n);
    if (existing) {
      const rank = { pick: 0, read: 1, search: 2 } as const;
      const merged: SourceItem = {
        ...existing,
        ...(rank[origin] < rank[existing.origin] ? { origin } : {}),
        ...(extra.title ? { title: extra.title } : {}),
        ...(extra.why ? { why: extra.why } : {}),
      };
      shelf.set(n, merged);
      return merged;
    }
    if (!makeRoom()) return null;
    const meta = known.get(normalizeSourceUrl(url));
    const item: SourceItem = {
      n,
      url: normalizeSourceUrl(url),
      title: clip(extra.title || meta?.title || '', SOURCE_TITLE_MAX) || siteOf(url),
      site: siteOf(url),
      kind: detectSourceKind(url),
      origin,
      ...(meta?.snippet ? { snippet: meta.snippet } : {}),
      ...(meta?.query ? { query: meta.query } : {}),
      ...(extra.why ? { why: extra.why } : {}),
    };
    shelf.set(n, item);
    return item;
  };

  const api: SourceShelf = {
    sessionId,
    found(query, results) {
      const q = clip(query, 60);
      const numbers: number[] = [];
      let shelved = 0;
      for (const r of results) {
        if (!isShelvableUrl(r.url)) {
          numbers.push(0);
          continue;
        }
        const n = numberOf(r.url, { title: clip(r.title, SOURCE_TITLE_MAX), snippet: clip(r.snippet, SOURCE_SNIPPET_MAX), query: q });
        numbers.push(n);
        if (shelved < SOURCE_PER_SEARCH && !shelf.has(n) && place(r.url, n, 'search')) shelved++;
      }
      if (shelved > 0) emit();
      return numbers;
    },
    reading(url) {
      if (!isShelvableUrl(url)) return;
      const n = numberOf(url, { title: '' });
      place(url, n, 'read');
      readingN = n;
      emit();
    },
    read(url, title, ok) {
      if (!isShelvableUrl(url)) return;
      const n = numberOf(url, { title: title ? clip(title, SOURCE_TITLE_MAX) : '' });
      if (ok) place(url, n, 'read', title ? { title: clip(title, SOURCE_TITLE_MAX) } : {});
      if (readingN === n) readingN = undefined;
      emit();
    },
    pick(picks) {
      const picked: SourceItem[] = [];
      const unknown: string[] = [];
      for (const p of picks.slice(0, SOURCE_PICK_MAX)) {
        const k = normalizeSourceUrl(p.url);
        const meta = known.get(k);
        if (!meta || !isShelvableUrl(k)) {
          unknown.push(p.url);
          continue;
        }
        const item = place(k, meta.n, 'pick', { why: clip(p.why, SOURCE_WHY_MAX) });
        if (item) picked.push(item);
      }
      if (picked.length > 0) emit();
      return { picked, unknown };
    },
    items,
    size: () => shelf.size,
    knows: (url) => known.has(normalizeSourceUrl(url)),
    dispose() {
      if (live.get(sessionId)?.shelf === api) live.delete(sessionId);
    },
  };
  pruneLive(Date.now());
  live.set(sessionId, { shelf: api, at: Date.now() });
  return api;
}
