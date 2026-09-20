/**
 * features/search/use-global-search — 全站搜索的前端状态与两个纯函数（契约 `docs/FTS-SPEC.md` §3.4）。
 *
 * ★ 纯函数（`groupHits` / `splitByQuery`）与 hook 放同一文件：它们是这个交互的**全部可测逻辑**
 *   （分区口径、高亮切分），渲染层只负责把它们摆出来。`global-search.test.ts` 直接测这两个。
 * ★ 失败**静默降级**（ADR-4）：搜索接口挂了就当作"没有结果"，不弹错、不阻塞——
 *   侧栏那路**纯前端 title 过滤仍然在工作**（本功能是**追加**一路，不是替换，见 FTS-SPEC §3.4），
 *   所以搜索接口不可用时用户并没有失去全部搜索能力。
 */
import { useEffect, useState } from 'react';
import { FTS_MIN_QUERY_CHARS, type FtsHit } from '@sb/shared';
import { api } from '../../lib/api';

/** 命中按 kind 分区。固定三键（空的一侧给空数组），渲染层不必再判 undefined。 */
export interface SearchGroups {
  message: FtsHit[];
  term: FtsHit[];
  note: FtsHit[];
}

/**
 * 按 kind 分区。
 * ★ 用**固定三键**而不是 `Record<string, FtsHit[]>`：后者让渲染层每次都要判 undefined，
 *   而"少判一次"的表现是整块结果不渲染（用户以为没搜到）。多一个键的成本是零。
 */
export function groupHits(hits: FtsHit[]): SearchGroups {
  const groups: SearchGroups = { message: [], term: [], note: [] };
  for (const h of hits) groups[h.kind].push(h);
  return groups;
}

/**
 * 把文本按查询词切成「命中 / 未命中」片段，供渲染层包 `<mark>`。
 *
 * ★ 为什么不用 `dangerouslySetInnerHTML` + 字符串替换：snippet 来自**用户自己的数据**
 *   （消息正文、词条释义），拼 HTML 就是把 XSS 面开在自己的数据上——本仓 `Markdown.tsx`
 *   已立过「模型输出的原始 HTML 永不变成活元素」的同款承诺。切成片段后由 React 建节点，
 *   注入面为零。
 * ★ 大小写不敏感（与服务端 `tokenizeForFts` 统一小写同口径），但**保留原文大小写**显示。
 * ★ 查询串为空 ⇒ 原样一段，不做任何切分。
 */
export function splitByQuery(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const low = text.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (;;) {
    const at = low.indexOf(q, cursor);
    if (at < 0) break;
    if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    cursor = at + q.length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

/** 防抖窗口：输入停止 250ms 才发请求（中文输入法逐字上屏时，不防抖会每敲一个字发一次） */
const DEBOUNCE_MS = 250;

export interface GlobalSearchState {
  groups: SearchGroups;
  loading: boolean;
  /** 查询是否达到触发门槛（< `FTS_MIN_QUERY_CHARS` 时不发请求、渲染层整块不显示） */
  active: boolean;
}

/**
 * 搜索状态。`active` 为 false 时**一个请求都不发**——侧栏搜索框每敲一个字都会走这里，
 * 门槛判定必须在前端做（服务端对 1 个字的查询也会真跑一次 fts5 MATCH）。
 */
export function useGlobalSearch(query: string): GlobalSearchState {
  const q = query.trim();
  const active = q.length >= FTS_MIN_QUERY_CHARS;
  const [groups, setGroups] = useState<SearchGroups>({ message: [], term: [], note: [] });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) {
      setGroups({ message: [], term: [], note: [] });
      setLoading(false);
      return;
    }
    // ★ `cancelled` 是**必须**的：防抖窗口内用户继续输入会重跑本 effect，
    //   旧请求的回包若仍然 setState，屏幕上会出现"后一次查询的结果被前一次覆盖"的闪变。
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api.search
        .global(q)
        .then((res) => {
          if (cancelled) return;
          setGroups(groupHits(res.hits));
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setGroups({ message: [], term: [], note: [] });
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, active]);
  return { groups, loading, active };
}
