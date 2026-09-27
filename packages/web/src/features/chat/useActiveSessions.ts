/**
 * useActiveSessions —— 「谁在生成」的订阅（侧栏「回复中」徽标的数据源之一）。
 *
 * ## 为什么需要它
 * 生成发生在服务端且**不随页面切换中止**（断开 SSE 只摘订阅者，`handleMessage` 照跑照落库，
 * 见 `routes.ts` 的 `/api/chat/active` 注释）。所以「我在 A 里发了一句、然后切到 B」时，
 * 客户端的任何局部状态都不知道 A 还在跑——只能问服务端。本 hook 就是那一问，外加节流。
 *
 * ## 轮询策略（成本与实时性的取舍）
 * - 挂载即对齐一拍：刷新页面后也能立刻恢复「别的会话正在生成」的徽标。
 * - **只在真有会话在跑时才起 2s 定时器**（`shouldPollActive`）：空闲时零请求，
 *   不给后台常驻一个心跳——本功能是提示，不值得一直占用资源。
 * - 内容没变就保持原引用（`sameIds`）：否则每 2s 一次 setState 会让 App 与正在流式的
 *   ChatView 白重渲染一轮。
 * - 失败静默：徽标是提示性 UI，接口抖动不该弹错误、更不该把已有的徽标清掉（保守留旧值）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { busySessionIds, sameIds, shouldPollActive } from './session-busy';

/** 轮询间隔：徽标是「大概齐」的提示，2s 足够，再密就是拿资源换观感边际 */
export const ACTIVE_POLL_MS = 2000;

export function useActiveSessions(localSid: string | null): Set<string> {
  const [serverSids, setServerSids] = useState<readonly string[]>([]);
  const busy = busySessionIds(localSid, serverSids);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      void api.chat
        .active()
        .then((r) => {
          if (!alive) return;
          // 内容一致就保留旧引用（省掉一次无谓重渲染）
          setServerSids((prev) => (sameIds(prev, r.sessionIds) ? prev : r.sessionIds));
        })
        .catch(() => undefined); // 静默：提示性 UI 不因接口抖动报错
    };
    tick();
    if (!shouldPollActive(busy)) {
      return () => {
        alive = false;
      };
    }
    const timer = setInterval(tick, ACTIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // 依赖刻意只取 busy.size（而非 busy 本身）：Set 每次渲染都是新引用，直接依赖会让 effect 反复重建
  }, [busy.size, localSid]);

  return busy;
}
