/**
 * useDrillTrigger — 「什么时候弹、什么时候该切回去」（契约 `docs/WAIT-DRILL-SPEC.md` §2）。
 *
 * 输入只有一个信号：`busySessionId`（App 从 ChatView 收到的"哪间会话正在生成"，token 级零延迟）。
 *   - 它从空变非空 = 一轮开始：起一个 `delayMs`（默认 2 秒）的表；到点还在生成 ⇒ `open`。
 *     秒回的短问题在 2 秒内就结束了，表被清掉，什么都不弹——用户选的口径（不打扰短问答）。
 *   - 它变回空 = 回复到了：若弹窗开着 ⇒ `replyReady`（宿主据此"答完这张就切回去"）。
 *   - 用户手动关掉 ⇒ 记住这一轮的序号，本轮不再弹（同一轮里再弹等于跟用户抢）。
 * ★ `active`（当前在对话页）与 `enabled`（设置里的开关）走 ref：它们变了不该被当成"新的一轮"。
 * ★ 每轮开局记下 `openSession`（正在等的那间会话 id）：出新词时带给服务端，新词跟着话题走。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DRILL_OPEN_DELAY_MS } from '@sb/shared';

export interface UseDrillTriggerOptions {
  busySessionId: string | null;
  active: boolean;
  enabled: boolean;
  delayMs?: number;
}

export function useDrillTrigger({ busySessionId, active, enabled, delayMs = DRILL_OPEN_DELAY_MS }: UseDrillTriggerOptions) {
  const [open, setOpen] = useState(false);
  const [replyReady, setReplyReady] = useState(false);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const round = useRef(0);
  const dismissed = useRef(-1);
  const gate = useRef({ active, enabled });
  gate.current = { active, enabled };
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    if (busySessionId) {
      round.current += 1;
      const r = round.current;
      setReplyReady(false);
      if (!gate.current.active || !gate.current.enabled) return;
      const t = setTimeout(() => {
        if (!gate.current.active || !gate.current.enabled || dismissed.current === r || openRef.current) return;
        setOpenSession(busySessionId);
        setOpen(true);
      }, delayMs);
      return () => clearTimeout(t);
    }
    if (openRef.current) setReplyReady(true);
    return undefined;
  }, [busySessionId, delayMs]);

  const close = useCallback(() => {
    dismissed.current = round.current;
    setOpen(false);
    setReplyReady(false);
  }, []);

  /**
   * 手动打开（等待气泡旁的入口 / 设置页「试一局」/ 输入框上方的「唤回」小签）：不受 2 秒表与"本轮已关过"约束。
   * 没在等回复时打开 = 练习局，不设 `replyReady`（没有"回复到了"可切），关掉靠用户自己。
   * ★ 没在等回复时**沿用上一次的 `openSession`**：唤回收起的那局时它不该变（变了等于换话题，会再要一批新词）。
   */
  const openNow = useCallback(() => {
    if (busySessionId) setOpenSession(busySessionId);
    setReplyReady(false);
    setOpen(true);
  }, [busySessionId]);

  return { open, replyReady, openSession, close, openNow };
}
