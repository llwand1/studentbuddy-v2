/**
 * useChoiceQueue — 方案选择框的前端状态（契约 docs/ASK-CHOICE-SPEC.md §4）。
 *
 * 为什么单开 hook：`useChatStream.ts` 已 398/400 行，方案选择框要加 state + 三个事件分支
 * + 答复动作（约 90 行），照 AGENTS 的行数红线（`.ts` ≤400）只能先开新文件——
 * 与 server 侧 `flow.ts` → `persist.ts` 的处置同源。
 *
 * 关注点边界：本 hook 只管「挂起队列 + 答复」，不认识 token / step / tasks。
 * `useChatStream` 在事件入口把 choice-* 三帧交给 `applyEvent` 消化，其余照旧往下走。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskChoiceRecord, SseEvent } from '@sb/shared';
import { api } from '../../lib/api';

export interface ChoiceQueue {
  /** 队首挂起项（浮层用）；无挂起时为 null */
  pendingChoice: AskChoiceRecord | null;
  /**
   * 消化一条 SSE 事件。返回 true ＝ 本 hook 已接管（调用方应直接 return）；
   * false ＝ 不是本 hook 的事件，交回调用方继续分发。
   */
  applyEvent: (ev: SseEvent) => boolean;
  /** 新一轮开始（清空队列，settled 的确认态一并退场） */
  reset: () => void;
  /** 答复 */
  replyChoice: (requestId: string, reply: { optionId?: string; custom?: string }) => void;
  /** 收起队首（纯前端动作，不触碰后端状态） */
  dismissChoice: () => void;
}

export function useChoiceQueue(sessionId: string | null, onError: (msg: string) => void): ChoiceQueue {
  /**
   * 用**数组**而非单个：一轮里模型理论上连问两次也接得住，浮层只显示队首，
   * 答完一条下一条自然浮上来。ref 与 state 双写的原因同 useChatStream 的过程三件套——
   * SSE 回调闭包读不到最新 state，只有 ref 读得到。
   */
  const [choices, setChoices] = useState<AskChoiceRecord[]>([]);
  const choicesRef = useRef<AskChoiceRecord[]>([]);
  const commit = useCallback((next: AskChoiceRecord[]) => {
    choicesRef.current = next;
    setChoices(next);
  }, []);

  const reset = useCallback(() => commit([]), [commit]);

  // 会话切换：清空 + 主动捞回挂起项。
  // 为什么必须捞：SSE 缓冲「60s 无订阅即回收」，重开页面时回放流里可能已经什么都没有——
  // 不查库就会「界面看着空闲、后端工具还在等」，是最难排查的一类体验断裂。
  useEffect(() => {
    commit([]);
    if (!sessionId) return;
    let alive = true;
    void api.choices
      .pending(sessionId)
      .then((rows) => {
        if (alive && rows.length > 0) commit(rows);
      })
      .catch(() => undefined); // 拿不到卡不等于不能聊，静默
    return () => {
      alive = false;
    };
  }, [sessionId, commit]);

  const applyEvent = useCallback(
    (ev: SseEvent): boolean => {
      if (ev.type === 'choice-asked') {
        // 按 id 幂等：断线重连会回放同一帧，覆盖而非二次入队
        const exists = choicesRef.current.some((c) => c.id === ev.request.id);
        commit(
          exists
            ? choicesRef.current.map((c) => (c.id === ev.request.id ? ev.request : c))
            : [...choicesRef.current, ev.request],
        );
        return true;
      }
      if (ev.type === 'choice-replied') {
        // 切已选态但**不出队**：首 token 常有延迟，卡片凭空消失会让人以为没点成功
        commit(
          choicesRef.current.map((c) => (c.id === ev.requestId ? { ...c, status: 'answered', reply: ev.reply } : c)),
        );
        return true;
      }
      if (ev.type === 'choice-cancelled') {
        // 逃生口触发（停止生成 / 删会话 / 重启清理）：切作废态如实告知，不静默消失
        commit(
          choicesRef.current.map((c) =>
            c.id === ev.requestId ? { ...c, status: 'cancelled', cancelReason: ev.reason } : c,
          ),
        );
        return true;
      }
      return false;
    },
    [commit],
  );

  const replyChoice = useCallback(
    (requestId: string, reply: { optionId?: string; custom?: string }) => {
      // 不做乐观切态：工具与答复同进程、本机往返毫秒级，且卡片内部已有 busy 锁防连点；
      // 等服务端广播回来再切已选态，前端就不必维护第二份「我以为的状态」（409 才是最终裁决）。
      void api.choices
        .reply(requestId, reply)
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    },
    [onError],
  );

  const dismissChoice = useCallback(() => {
    commit(choicesRef.current.slice(1));
  }, [commit]);

  return { pendingChoice: choices[0] ?? null, applyEvent, reset, replyChoice, dismissChoice };
}
