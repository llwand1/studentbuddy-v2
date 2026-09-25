/**
 * features/search/GlobalSearch — 会话侧栏的**全站搜索**结果面板（契约 `docs/FTS-SPEC.md` §3.4）。
 *
 * 定位：它是侧栏搜索框的**第二路**结果。第一路是 App.tsx 里那行纯前端 `title.includes` 过滤
 * （**保留不动**）——两者并存：前者答"哪个会话标题里有这几个字"，本面板答
 * "哪条消息 / 哪个词条里有这几个字"。这也是它不复用会话列表容器的原因：
 * 结果不是会话，是**跨两类数据的命中**。
 *
 * ★ 为什么单独成组件而不是写进 App.tsx：`App.tsx` 当时 **294/300 行**（web 组件红线），
 *   再塞一个带分区渲染的面板必破线。抽出来后 App 只加两行接线（一行 import、一行 JSX）。
 *
 * ★ **P1 的跳转是「到会话/到套题」，不做精确滚动定位**（诚实记账，FTS-SPEC 升版时登记）：
 *   滚到具体那一条需要 `messageId → DOM 节点` 的映射，要把 id 一路透传进 `ChatView`
 *   并处理"消息还没加载完"的时序；而 `ChatView.tsx` 当时 279/300 行，余量不足以承载
 *   这条新链路。P1 先把"找得到、跳得到"做实，精确落点随 P2 的关键词高亮页一起做。
 */
import type { FtsHit } from '@sb/shared';
import { splitByQuery, useGlobalSearch } from './use-global-search';
import './global-search.css';

/** 结果片段：命中处包 `<mark>`（由 `splitByQuery` 切分，不用 innerHTML——注入面为零） */
function Snippet({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitByQuery(text, query).map((seg, i) =>
        seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function Group({
  label,
  hits,
  query,
  onPick,
}: {
  label: string;
  hits: FtsHit[];
  query: string;
  onPick: (hit: FtsHit) => void;
}) {
  // 空分区整块不渲染（包括标题）——列出"消息 (0)"只是噪声
  if (hits.length === 0) return null;
  return (
    <div className="sb-gs-group">
      <div className="sb-gs-head">
        {label}
        <span className="sb-gs-count">{hits.length}</span>
      </div>
      {hits.map((h) => (
        <button key={h.refId} className="sb-gs-item" onClick={() => onPick(h)}>
          <span className="sb-gs-title">{h.title}</span>
          <span className="sb-gs-snippet">
            <Snippet text={h.snippet} query={query} />
          </span>
        </button>
      ))}
    </div>
  );
}

export interface GlobalSearchProps {
  /** 侧栏搜索框的原始输入（**未 trim**，门槛判定在 hook 里） */
  query: string;
  /** 点消息结果：跳到它所在的会话 */
  onOpenSession: (sessionId: string) => void;
  /** 点词条结果：按词条名打开词条库（复用既有 `openTerms`） */
  onOpenTerm: (name: string) => void;
}

export function GlobalSearch({ query, onOpenSession, onOpenTerm }: GlobalSearchProps) {
  const { groups, loading, active } = useGlobalSearch(query);
  if (!active) return null;
  const total = groups.message.length + groups.term.length;
  return (
    <div className="sb-gs" aria-label="全站搜索结果">
      {/* 加载中且暂无结果才提示：已有上一轮结果时不闪「搜索中」，避免结果区跳动 */}
      {loading && total === 0 && <div className="sb-gs-hint">搜索中…</div>}
      {!loading && total === 0 && <div className="sb-gs-hint">没有匹配的消息 / 词条</div>}
      <Group
        label="词条"
        hits={groups.term}
        query={query}
        onPick={(h) => onOpenTerm(h.title)}
      />
      <Group
        label="消息"
        hits={groups.message}
        query={query}
        onPick={(h) => {
          if (h.parentId) onOpenSession(h.parentId);
        }}
      />
    </div>
  );
}
