/**
 * useQuickStart —— 空会话直接开聊（契约 `docs/CHAT-UX-SPEC.md` §2.9）。
 *
 * 问题：还没选会话时输入框能打字却发不出去（`send` 要会话、要 SSE 就绪），建议卡也只把提示语
 * 填进输入框——新用户第一屏得先去侧栏点「新建对话」、或点卡再点发送，才真的开始对话。
 * 「开始页」应当就是开始：在输入框里打字回车、或点一张卡，这一问就该发出去。
 *
 * 规则：
 * · `fire(text, images)`：有会话 ⇒ 直接发；没会话 ⇒ **暂存这一问**、请 App 开新会话，等新会话
 *   SSE 就绪且不忙时自动发出——`send` 的四道前置门（会话 / 就绪 / 不忙 / 历史已载）一道不跳。
 * · 开会话期间 `starting` 为真：输入区按它禁发，连按 Enter 不会开出两间。
 * · 「历史加载中」是唯一的瞬态被拒（`send` 在任何副作用之前返回它）⇒ 按 `QUICK_START_RETRY_MS`
 *   重试、`QUICK_START_TIMEOUT_MS` 内放弃；其余被拒（上游错等）原样上报、**不重试**——那时用户
 *   气泡已乐观上屏，重发＝发两遍。
 * · 发成功即清暂存，**不看 effect 是否已被清理**：`send` 成功会把 `busy` 翻真，deps 变化先触发
 *   cleanup 再回调——若按「已清理就忽略」处理，暂存留到轮末又会再发一遍（同一问发两次）。
 * · 卸载即丢：暂存只对「这一坐、刚为它开的那间」有效，不做持久化。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseReadyState } from '../../lib/sse-client';
import { HISTORY_LOADING_ERROR } from './useSendActions';

type ChatImage = { dataUrl: string; name?: string };
type SendResult = { ok: boolean; error?: string };
type Pending = { text: string; images?: ChatImage[] };

/** 「历史加载中」重试间隔 / 放弃时限（新会话的 /messages 通常几十毫秒就回，5 秒还没回是网络问题） */
export const QUICK_START_RETRY_MS = 50;
export const QUICK_START_TIMEOUT_MS = 5000;

export function useQuickStart(opts: {
  sessionId: string | null;
  ready: SseReadyState;
  busy: boolean;
  /** 请 App 开一间新会话并切过去（App 的 `newSession`）；新 id 随后从 `sessionId` 进来 */
  onNewSession: () => void;
  send: (text: string, images?: ChatImage[]) => Promise<SendResult>;
  /** 被拒 / 失败的上报口（ChatView 的 `setSendError`）：不静默 */
  onError: (msg: string) => void;
}): { starting: boolean; fire: (text: string, images?: ChatImage[]) => void } {
  const { sessionId, ready, busy, onNewSession } = opts;
  // send / onError 每次渲染都是新函数：ref 锁最新，flush effect 不因它们重跑（仓内同法：useRoundBegin）
  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;
  const errorRef = useRef(opts.onError);
  errorRef.current = opts.onError;
  /** 暂存以 ref 为真相源（同步判重），state 只是给渲染层的镜像 */
  const pendingRef = useRef<Pending | null>(null);
  const [starting, setStarting] = useState(false);
  const deadlineRef = useRef(0);

  const settle = useCallback((): void => {
    pendingRef.current = null;
    setStarting(false);
  }, []);

  const fire = useCallback(
    (text: string, images?: ChatImage[]): void => {
      if (sessionId) {
        void sendRef.current(text, images).then((r) => {
          if (!r.ok && r.error) errorRef.current(r.error);
        });
        return;
      }
      if (pendingRef.current) return; // 已经在开会话：这一下是连按，忽略
      pendingRef.current = { text, images };
      deadlineRef.current = Date.now() + QUICK_START_TIMEOUT_MS;
      setStarting(true);
      onNewSession();
    },
    [sessionId, onNewSession],
  );

  // 开会话超时兜底：App 建会话失败（网络 / 401）时新 id 永远不来，不能让输入区一直锁在「正在开新对话…」
  useEffect(() => {
    if (!starting || sessionId) return;
    const t = window.setTimeout(() => {
      if (!pendingRef.current) return;
      settle();
      errorRef.current('开新对话没成功，请重试');
    }, QUICK_START_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [starting, sessionId, settle]);

  // 新会话就绪 ⇒ 把暂存的那一问发出去
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !starting || !sessionId || ready !== 'open' || busy) return;
    let alive = true;
    let timer: number | undefined;
    const attempt = (): void => {
      void sendRef.current(pending.text, pending.images).then((r) => {
        if (r.ok) {
          settle();
          return;
        }
        if (!alive) return;
        if (r.error === HISTORY_LOADING_ERROR && Date.now() < deadlineRef.current) {
          timer = window.setTimeout(attempt, QUICK_START_RETRY_MS);
          return;
        }
        settle();
        errorRef.current(r.error ?? '发送失败，请重试');
      });
    };
    attempt();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [starting, sessionId, ready, busy, settle]);

  return { starting, fire };
}
