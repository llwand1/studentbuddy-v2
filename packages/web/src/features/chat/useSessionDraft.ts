/**
 * useSessionDraft —— 输入框草稿按会话隔离。
 *
 * 问题：`input` 是 ChatView 的 state，切会话既不清也不存：在 A 打了半句切去 B 看一眼，
 * 半句话跟着漂进 B 的输入框；切回 A 却是空的（发错会话／丢草稿两种坏结果都有）。
 * 主流做法（ChatGPT／豆包）是每个会话各记各的草稿。
 *
 * 规则：
 * · 切走：把当前输入存到旧会话名下；切到：取新会话的草稿（没有就空）。
 * · 唯一例外——从「无会话」切到刚开的新会话：建议卡 `pick()` 是先填字再开会话，那半句话
 *   本来就是给新会话的，原样带过去（不存到 null 名下、也不被新会话的空草稿冲掉）。
 * · 只存内存（ref 里的 Map）：刷新页面不保留——草稿是「这一坐」的上下文，不做持久化。
 *
 * StrictMode 双跑安全：首跑 prev 为 undefined 只登记不动作，二跑 prev===sessionId 直接返回。
 */
import { useEffect, useRef } from 'react';

export function useSessionDraft(sessionId: string | null, input: string, setInput: (v: string) => void): void {
  const drafts = useRef(new Map<string | null, string>());
  const inputRef = useRef(input);
  inputRef.current = input;
  const prevRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = sessionId;
    if (prev === undefined || prev === sessionId) return;
    const current = inputRef.current;
    const carryOver = prev === null && sessionId !== null && current.trim() !== '';
    if (carryOver) {
      drafts.current.set(null, '');
      return;
    }
    drafts.current.set(prev, current);
    setInput(drafts.current.get(sessionId) ?? '');
  }, [sessionId, setInput]);
}
