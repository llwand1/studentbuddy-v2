/**
 * use-guide-fetch —— 引路灯向服务端要「AI 现挑的推荐」（契约 `docs/GUIDE-SPEC.md` §8「成本可控」）。
 *
 * ★ 成本口径：只有 `load()` 被调用才请求（点开 / 悬停 0.4 秒 / 聚焦），**不随状态变化自动发**；
 *   按「语言 + 页面 + 会话 + 轮数 + 忙闲 + 能力集」缓存 10 分钟；同一现场已在请求中就不重复发；
 *   现场变了（换会话 / 又聊了一轮 / 题做完了）⇒ 旧请求作废（掐掉上游，不白等也不白花）。
 * ★ 失败不抛：`failed` 标真，界面退回规则推荐并如实说「没能联系上服务」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuideKind, GuideLang, GuideNextResponse, GuideView } from '@sb/shared';
import { guideApi } from '../../lib/api-guide';

export const GUIDE_CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 8;

export interface GuideCtx {
  lang: GuideLang;
  view: GuideView;
  sessionId: string | null;
  can: readonly GuideKind[];
  busy: boolean;
  /** 轮数进 key：每聊完一轮，上一轮的推荐就该作废 */
  rounds: number;
}

export const guideCtxKey = (c: GuideCtx): string => [c.lang, c.view, c.sessionId ?? '', c.rounds, c.busy ? 1 : 0, c.can.join(',')].join('|');

interface Cached {
  res: GuideNextResponse;
  at: number;
}

function remember(cache: Map<string, Cached>, key: string, res: GuideNextResponse): void {
  cache.delete(key);
  cache.set(key, { res, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function useGuideFetch(ctx: GuideCtx) {
  const key = guideCtxKey(ctx);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const cache = useRef(new Map<string, Cached>());
  const flight = useRef<{ key: string; ac: AbortController } | null>(null);
  const [slot, setSlot] = useState<{ key: string; res: GuideNextResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback((force = false): void => {
    const c = ctxRef.current;
    const k = guideCtxKey(c);
    if (!force) {
      const hit = cache.current.get(k);
      if (hit && Date.now() - hit.at < GUIDE_CACHE_TTL_MS) {
        setSlot({ key: k, res: hit.res });
        setFailed(false);
        return;
      }
      if (flight.current?.key === k) return; // 同一现场已经在问了
    }
    flight.current?.ac.abort();
    const ac = new AbortController();
    flight.current = { key: k, ac };
    setLoading(true);
    setFailed(false);
    guideApi
      .next({ lang: c.lang, view: c.view, sessionId: c.sessionId, can: [...c.can], busy: c.busy }, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        remember(cache.current, k, res);
        setSlot({ key: k, res });
      })
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (flight.current?.ac === ac) {
          flight.current = null;
          setLoading(false);
        }
      });
  }, []);

  // 现场变了：旧请求作废（结果已经对不上现在的局面）
  useEffect(() => {
    const cur = flight.current;
    if (cur && cur.key !== key) {
      cur.ac.abort();
      flight.current = null;
      setLoading(false);
    }
  }, [key]);
  useEffect(() => () => flight.current?.ac.abort(), []);

  return { key, res: slot && slot.key === key ? slot.res : null, loading, failed, load };
}
