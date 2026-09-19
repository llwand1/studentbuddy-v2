/**
 * useRoundBegin —— 「新一轮公共前置」的 ref 感知重置（2026-09-19 从 useChatStream 拆出）。
 * 拆的理由只有一个：useChatStream 已到 400 行红线，而 P0.5 热修（轮起点以服务端
 * round-start 帧为基准，bug-ledger B-009）必须在事件入口写 ref+state 双份，塞不进去了。
 *
 * ★ 「本轮态」重置必须走 **ref 感知的 setter**（resetTokens/clearReasoning/commit*）：
 *   done 收口读的是 ref，只 setState 清的是渲染镜像，旧值会串进下一轮 done 的归并。
 * ★ startedAt 先落本地时刻兜底——round-start 帧未到时（如旧服务端缓冲）也得有表可走；
 *   帧到达后由 useChatStream 的事件入口用服务端值覆盖（ref 与镜像一起）。
 */
import { useCallback, useRef, useState, type MutableRefObject } from 'react';

export function useRoundBegin(deps: {
  resetTokens: () => void;
  clearReasoning: () => void;
  commitSteps: (next: never[]) => void;
  commitTasks: (next: never[]) => void;
  commitStreaming: (next: string) => void;
  resetChoices: () => void;
  startedAtRef: MutableRefObject<number>;
  /** 上一轮的用量/耗时退场（setUsage(null) + setElapsedMs(0)） */
  clearRoundMeta: () => void;
}) {
  const [startedAtMs, setStartedAtMs] = useState(0);
  // deps 每次渲染都是新对象 ⇒ 不进 useCallback 依赖：ref 锁最新（与 useChatStream 的 busyCbRef 同法），beginRound 恒稳
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const begin = useCallback(() => {
    const d = depsRef.current;
    d.resetTokens();
    d.commitStreaming('');
    d.clearReasoning();
    d.commitSteps([]);
    d.commitTasks([]);
    // 方案选择框：上一轮遗留的卡片（含已选/已作废的确认态）退场——它属于上一轮，不该漂过来
    d.resetChoices();
    d.clearRoundMeta();
    d.startedAtRef.current = Date.now();
    setStartedAtMs(d.startedAtRef.current);
  }, []);
  return { begin, startedAtMs, setStartedAtMs };
}
