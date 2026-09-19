/**
 * useConfirmQueue — 工具确认门的前端队列（契约 docs/TOOL-ECOSYSTEM-SPEC.md §6.4）。
 *
 * 形状刻意照 `useChoiceQueue`（数组队列 + ref/state 双写 + applyEvent 返回是否接管），
 * 但**有一处关键不同**：会话切换时**不主动捞回挂起项**——服务端刻意没有 GET 恢复端点：
 * 确认超时 60s 与 SSE 缓冲 60s TTL 等长，重开页面时挂点几乎必已超时收口，
 * 「保守拒绝」就是那台恢复机（routes/chat.ts `/tool-confirm` 头注同口径）。
 *
 * 前端**不本地判超时、不代答**：expiresAt 只喂卡片的倒计时显示，裁决权在服务端定时器
 * （单一裁决者，防「界面已走 / 后端还等」的分裂）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent, ToolConfirmDecision, ToolConfirmRequest } from '@sb/shared';
import { toolsApi } from '../../lib/api-tools';

export interface ConfirmItem extends ToolConfirmRequest {
  /** null = 还挂着；非 null = 已裁决（含服务端代答的 timeout/deny），卡片切结果态 */
  decision: ToolConfirmDecision | null;
}

export interface ConfirmQueue {
  /** 队首挂起项（浮层用）；无挂起时为 null */
  pendingConfirm: ConfirmItem | null;
  /** 每秒推进的当前时刻（ms）：喂卡片倒计时——计时器只留这一份，卡片保持纯渲染件 */
  nowMs: number;
  /** 消化一条 SSE 事件。true ＝ 已接管，调用方直接 return */
  applyEvent: (ev: SseEvent) => boolean;
  /** 新一轮开始清空（含已裁决卡；settled 的确认态不漂进下一轮） */
  reset: () => void;
  /** 回执：400/404/409 语义在服务端，这里只透传错误文案（服务端广播才是最终裁决） */
  replyConfirm: (requestId: string, decision: ToolConfirmDecision) => void;
  /** 收起队首（纯前端动作，只对已裁决卡有意义） */
  dismissConfirm: () => void;
}

export function useConfirmQueue(sessionId: string | null, onError: (msg: string) => void): ConfirmQueue {
  const [items, setItems] = useState<ConfirmItem[]>([]);
  // SSE 回调闭包读不到最新 state，只有 ref 读得到（同 useChoiceQueue 的立项理由）
  const itemsRef = useRef<ConfirmItem[]>([]);
  const commit = useCallback((next: ConfirmItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const reset = useCallback(() => commit([]), [commit]);

  // 换会话必清场：旧会话的卡在新一间里没有裁决通道（SSE 频道按 sessionId 分挂），留着只会挡路。
  // 注意这与 useChoiceQueue 同段落只差在**不捞回**——确认门刻意没有 GET 恢复端点（文件头注）。
  useEffect(() => {
    commit([]);
  }, [sessionId, commit]);

  const applyEvent = useCallback(
    (ev: SseEvent): boolean => {
      if (ev.type === 'tool-confirm-request') {
        const req: ConfirmItem = {
          requestId: ev.requestId,
          tool: ev.tool,
          source: ev.source,
          server: ev.server,
          actionSummary: ev.actionSummary,
          affected: ev.affected,
          items: ev.items,
          expiresAt: ev.expiresAt,
          decision: null,
        };
        const exists = itemsRef.current.some((c) => c.requestId === ev.requestId);
        if (exists) {
          // 断线回放会重发同一帧：刷回挂起态（服务端已重开等待）而不是留旧裁决
          commit(itemsRef.current.map((c) => (c.requestId === ev.requestId ? req : c)));
          return true;
        }
        // 新问进来时清掉已裁决卡：浮层只显示队首，旧结果卡不退场会把新确认压死
        commit([...itemsRef.current.filter((c) => c.decision === null), req]);
        return true;
      }
      if (ev.type === 'tool-confirm-resolved') {
        // 只标态不出队：卡凭空消失会让人以为没点上；「收起」由用户完成
        commit(
          itemsRef.current.map((c) => (c.requestId === ev.requestId ? { ...c, decision: ev.decision } : c)),
        );
        return true;
      }
      return false;
    },
    [commit],
  );

  const replyConfirm = useCallback(
    (requestId: string, decision: ToolConfirmDecision) => {
      // 不做乐观切态：卡片内部 busy 锁防连点，真实态以 tool-confirm-resolved 广播为准
      void toolsApi
        .replyConfirm(requestId, decision)
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    },
    [onError],
  );

  const dismissConfirm = useCallback(() => {
    commit(itemsRef.current.slice(1));
  }, [commit]);

  const head = items.find((c) => c.decision === null) ?? items[0] ?? null;

  /**
   * 倒计时心跳：只在「队首挂着且还没到期」时每秒推进——过期后卡片已切「正在按拒绝收口」
   * 文案，等的只是服务端广播，再秒级重渲染整棵对话树就是白烧。
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = head !== null && head.decision === null && head.expiresAt > nowMs;
  const tickKey = head ? `${head.requestId}:${head.decision}` : '';
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking, tickKey]);

  return { pendingConfirm: head, nowMs, applyEvent, reset, replyConfirm, dismissConfirm };
}
