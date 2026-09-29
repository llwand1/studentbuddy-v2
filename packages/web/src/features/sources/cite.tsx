/**
 * cite —— 正文里的资料引用芯片 `[n]`（契约 docs/SOURCE-TRACE-SPEC.md §8.3）。
 *
 * 两种上下文：
 *  - **消息内**：`MessageRow` 用 `MessageSourcesProvider` 把**这条回答自己的**资料架交下来——
 *    历史里第 3 条回答的 [2] 指的是它那一轮的第 2 条，不是面板此刻显示的那份。
 *  - **流式正文**（还没归位成消息，没有 Provider）：回落到 store 里进行中的 live 架子。
 * 架上没有第 n 条 ⇒ 原样输出 `[n]` 文字：`a[1]` 这类误判、模型自造的编号都不会变成死按钮。
 */
import { createContext, useContext, type ReactNode } from 'react';
import { sourceByN, type SourceItem } from '@sb/shared';
import { showSource, useSources } from '../../lib/sources-store';

interface MessageSources {
  sessionId: string;
  sources?: SourceItem[];
}

const Ctx = createContext<MessageSources | null>(null);

export function MessageSourcesProvider({ sessionId, sources, children }: MessageSources & { children: ReactNode }) {
  return <Ctx.Provider value={{ sessionId, sources }}>{children}</Ctx.Provider>;
}

export function CiteChip({ n }: { n: number }) {
  const ctx = useContext(Ctx);
  const store = useSources();
  // 消息自带的架子优先；没有（流式中 / 老消息无资料）才看 live 架
  const own = ctx?.sources && ctx.sources.length > 0 ? ctx.sources : undefined;
  const items = own ?? (store.live ? store.items : undefined);
  const sessionId = own ? ctx?.sessionId ?? '' : store.sessionId;
  const item = items ? sourceByN(items, n) : undefined;
  if (!item || !items) return <>[{n}]</>;
  return (
    <button
      type="button"
      className={`md-cite${item.origin === 'pick' ? ' md-cite-pick' : ''}`}
      title={`${item.title} · ${item.site}`}
      aria-label={`打开资料 ${n}：${item.title}`}
      onClick={() => showSource(sessionId, items, n)}
    >
      {n}
    </button>
  );
}
