/**
 * use-cards-state — 卡牌面板的唯一读口：一次 `/state` + 卡牌频道 SSE + 断线降级轮询。
 *
 * ★★ **为什么事件到了还是重读 `/state`，而不是照事件里的数就地改**：
 *   `card_granted` 带的是**绝对卡数与星级**（契约 §7 文件头：不带增量，断线重放才能对齐），
 *   但卡墙上的一行还有 `mentions / reviewDays / chestGrants` 三项分解。就地只改合计的话，
 *   墙上会出现「合计 9 张，分解 3+2+3+1=9 看着对、其实是上一轮的 8 张配新一轮的分解」——
 *   一个**自洽假象**，比数字旧一帧难查得多（B-007 族「前端猜服务端事实」的同一条病）。
 *   ⇒ 事件只当**触发器**用：它说"变了"，真值永远从 `/state` 拿。
 *   ⚠️ 代价如实写在这：一轮聊天多一次 `GET /state`（≤500 行的三相关子查询）。它换的是
 *   「面板上所有数来自同一个瞬间」这条等式成立，值。
 *
 * ★ 频道的隔离在服务端（`cardsChannel(ownerId)`，前端不自报 owner），所以这里的 URL
 *   **不带任何身份参数**——与 `api.ts` 文件头「所有请求不带 userId」同一条（身份由 httpOnly
 *   cookie 会话裁定）。
 * ★ 3 次重连失败 → 关流改 2s 轮询：抄 `PkApp.tsx` 的既有形状，不是新发明。这条降级是
 *   **契约 §7.3 点名的**（Android 微信 X5 的 `EventSource` 不稳），面板不能因为拿不到推送
 *   就整块空白。
 * ⚠️ 本 hook 只在**面板挂载期间**订阅。卡数变更发生在聊天页时，这里收不到帧——
 *   切回卡牌页的第一次 `/state` 就是补齐点。这是有意的（不给全局壳加一条常驻连接）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { CardsStateResponse, ChestState } from '../../lib/api-cards';
import { connectSse, type SseReadyState } from '../../lib/sse-client';
import { ApiError } from '../../lib/api-request';

/** 连续重连失败达到该次数即降级轮询（契约 §7.3，同 `PkApp.tsx` 的那两个常数） */
const POLL_AFTER_FAILS = 3;
const POLL_INTERVAL_MS = 2000;
/** `card_granted` 的合并窗口：一轮聊天可能连发多条（提及一批 + 复习一批），别一帧读一次 */
const REREAD_MS = 600;

export type CardsLink = SseReadyState | 'polling';

export interface CardsStore {
  /** `null` = 还没读到过（与「读到了但库是空的」是两件事，UI 文案不同，不许合并） */
  data: CardsStateResponse | null;
  link: CardsLink;
  /** 最近一次读／写的可见错误（ADR-5 禁静默） */
  error: string;
  /** 本次 `task_dispatched` 带进来的单 id：清单给它们挂 `entering` 错帧类 */
  freshTaskIds: string[];
  /** 有宝箱可开且用户还没点开（`chest_ready` 推来时置真，面板一开就清） */
  chestReady: boolean;
  refresh: () => Promise<void>;
  /** 开盒／收卡后服务端已把新钥匙账随响应给出，就地换上，省掉一次「数字先旧再新」的闪烁 */
  patchChest: (chest: ChestState) => void;
  clearChestReady: () => void;
  setError: (msg: string) => void;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（${e.status}）`;
  return e instanceof Error ? e.message : '网络异常';
}

export function useCardsState(): CardsStore {
  const [data, setData] = useState<CardsStateResponse | null>(null);
  const [link, setLink] = useState<CardsLink>('connecting');
  const [error, setError] = useState('');
  const [freshTaskIds, setFreshTaskIds] = useState<string[]>([]);
  const [chestReady, setChestReady] = useState(false);

  /** 只让**最后一次**读的结果落位：手动刷新与推送触发的刷新会并发，晚到的旧响应必须丢弃 */
  const reqSeq = useRef(0);
  const mergedRef = useRef<CardsStateResponse | null>(null);
  mergedRef.current = data;

  const refresh = useCallback(async () => {
    const my = ++reqSeq.current;
    try {
      const next = await api.cards.state();
      if (my === reqSeq.current) {
        setData(next);
        setError('');
      }
    } catch (e) {
      if (my === reqSeq.current) setError(errText(e));
    }
  }, []);

  // 首挂载读一次；失败也留错误位（面板要能显示"没读到"并给重试，不是画一片空）
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let fails = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleReread = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void refresh();
      }, REREAD_MS);
    };

    const client = connectSse('/api/cards/stream', { reconcileUrl: '/api/cards/live' });
    const offState = client.onStateChange((s) => {
      if (poll) return; // 已降级：流被关掉了，它的状态回调不再驱动 UI
      setLink(s);
      if (s === 'open') fails = 0;
      if (s === 'reconnecting') fails += 1;
      if (fails >= POLL_AFTER_FAILS) {
        client.close();
        setLink('polling');
        poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);
      }
    });
    const offEvent = client.onEvent((ev) => {
      if (ev.type === 'card_granted') scheduleReread();
      if (ev.type === 'task_dispatched') {
        setFreshTaskIds(ev.taskIds);
        void refresh();
      }
      if (ev.type === 'chest_ready') {
        setChestReady(true);
        void refresh();
      }
    });
    return () => {
      offState();
      offEvent();
      client.close();
      if (poll) clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [refresh]);

  const patchChest = useCallback((chest: ChestState) => {
    setData((cur) => (cur ? { ...cur, chest } : cur));
  }, []);

  const clearChestReady = useCallback(() => setChestReady(false), []);

  return { data, link, error, freshTaskIds, chestReady, refresh, patchChest, clearChestReady, setError };
}
