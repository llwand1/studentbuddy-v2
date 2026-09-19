/**
 * term-index — 对话页的**词条索引**（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §5，数据路线 ①）。
 *
 * ★ 为什么走前端索引、而不是等服务端标注回传（路线 ②，完整记账见契约 §5）：
 *   ① 正文是**流式**的，要逐字即时高亮；而服务端 `countUsage` 是回复**完成后**才跑，
 *      路线 ② 只能等整段答完才上色；
 *   ② **历史消息也要能高亮**——路线 ② 要么落「命中快照」（多一张表，还会与词条变更
 *      失同步），要么每次回放重算（等于又把活推回前端）。
 *
 * ★ 索引**编译一次、扫描多次**：`createTermMatcher` 把合并正则缓存住。正文渲染本身是
 *   O(n²) 的既有热点（见 `Markdown.tsx` 文件头），这里绝不能再加一层二次方开销。
 * ★ 拉取失败一律**降级为不高亮**（ADR-4 失败隔离）：高亮是次级功能，词条接口挂了不该
 *   影响正文渲染，更不该弹错。
 * ★ **无 Provider 时返回空索引** ⇒ 其他调用 `Markdown` 的页面（笔记页等）自动不高亮，
 *   不需要各自判断（也不必改它们的调用点）。
 * ★ 卡片数据**现取当前词条状态、不做快照**：用户改了释义或合并了别名，卡片要跟着变；
 *   卡片里的动作（纳入复习等）改完调 `refresh()` 让索引跟上。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTermMatcher, type TermHit, type TermKey } from '@sb/shared';
import { api, type TermItem } from '../../lib/api';

export interface TermIndex {
  /** 索引是否就绪（首屏拉取完成）。未就绪时正文照常渲染，只是不高亮 */
  ready: boolean;
  /** 按**主词条名**取词条（卡片的数据源） */
  lookup: (term: string) => TermItem | undefined;
  /** 扫出正文里的命中（已缓存的匹配器） */
  find: (text: string) => TermHit[];
  /** 词条变更后刷新索引（卡片动作后调；失败静默保持旧索引） */
  refresh: () => void;
  /** 跨页跳词条库（卡片动作；由 App 的 `openTerms` 注入，未注入时按钮不出现） */
  openTerms?: (keyword: string) => void;
}

/** 无 Provider 时的空索引：不高亮、不报错 */
const EMPTY_INDEX: TermIndex = {
  ready: false,
  lookup: () => undefined,
  find: () => [],
  refresh: () => undefined,
};

const TermIndexCtx = createContext<TermIndex>(EMPTY_INDEX);

export function useTermIndex(): TermIndex {
  return useContext(TermIndexCtx);
}

/**
 * ★ `onOpenTerms` 走 Provider 的 prop 而**不是**穿透 `Markdown`/`MessageRow` 的 props 链：
 *   前者只加一处接线，后者要改四个组件的签名（且 `Markdown` 已被笔记页复用，
 *   不该为了对话页的导航能力污染它的公共 props）。
 */
export function TermIndexProvider({
  children,
  onOpenTerms,
}: {
  children: ReactNode;
  onOpenTerms?: (keyword: string) => void;
}) {
  const [terms, setTerms] = useState<TermItem[]>([]);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      // 无参 = 全量（服务端 listTerms 的既有口径）；词条数在单用户本地库里是百量级
      setTerms(await api.terms.list());
    } catch {
      /* 静默：拉不到就保持现有索引（首屏失败 = 不高亮），功能降级不报错 */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<TermIndex>(() => {
    const byName = new Map<string, TermItem>();
    for (const t of terms) byName.set(t.term, t);
    const keys: TermKey[] = terms.map((t) => ({ term: t.term, aliases: t.aliases }));
    const matcher = createTermMatcher(keys);
    return {
      ready,
      lookup: (name) => byName.get(name),
      find: (text) => matcher.find(text),
      refresh: () => void load(),
      ...(onOpenTerms ? { openTerms: onOpenTerms } : {}),
    };
  }, [terms, ready, load, onOpenTerms]);

  return <TermIndexCtx.Provider value={value}>{children}</TermIndexCtx.Provider>;
}

