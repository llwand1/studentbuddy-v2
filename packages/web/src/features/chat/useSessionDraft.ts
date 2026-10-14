/**
 * useSessionDraft —— 输入框草稿按会话隔离。
 *
 * 问题：`input` 是 ChatView 的 state，切会话既不清也不存：在 A 打了半句切去 B 看一眼，
 * 半句话跟着漂进 B 的输入框；切回 A 却是空的（发错会话／丢草稿两种坏结果都有）。
 * 主流做法（ChatGPT／豆包）是每个会话各记各的草稿。
 *
 * 规则：
 * · 切走：把当前输入存到旧会话名下；切到：取新会话的草稿（没有就空）。
 * · 唯一例外——从「无会话」切到刚开的新会话：那半句话本来就是给新会话的，原样带过去
 *   （不存到 null 名下、也不被新会话的空草稿冲掉）。改版前靠它承接建议卡「先填字再开会话」；
 *   空会话直接开聊（CHAT-UX §2.9）之后，它承接的是「打了半句还没发、先点了一张建议卡」——
 *   卡的提示语作为第一问发出，半句话跟进新会话的输入框，不丢。
 * · 主窗口只存内存；桌面悬浮窗额外存本机 WebView 存储，渲染进程恢复后仍能接着输入。
 *
 * StrictMode 双跑安全：恢复值落进输入框之前不回写旧空串，普通重复运行只保存当前草稿。
 */
import { useEffect, useRef } from 'react';

export function useSessionDraft(sessionId: string | null, input: string, setInput: (v: string) => void): void {
  const drafts = useRef(new Map<string | null, string>());
  const inputRef = useRef(input);
  inputRef.current = input;
  const prevRef = useRef<string | null | undefined>(undefined);
  const restoring = useRef<string | null>(null);
  const persistent = useRef(typeof document !== 'undefined' && !!document.documentElement.dataset.float).current;
  const key = (id: string | null) => `sb:float:draft:${id ?? 'new'}`;
  const read = (id: string | null): string => {
    if (drafts.current.has(id)) return drafts.current.get(id)!;
    try { return persistent ? localStorage.getItem(key(id)) ?? '' : ''; } catch { return ''; }
  };
  const write = (id: string | null, value: string) => {
    drafts.current.set(id, value);
    if (!persistent) return;
    try { if (value) localStorage.setItem(key(id), value); else localStorage.removeItem(key(id)); } catch { /* Memory drafts remain available. */ }
  };

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = sessionId;
    const current = inputRef.current;
    if (restoring.current !== null) {
      if (prev === sessionId && current !== restoring.current) return;
      restoring.current = null;
    }
    if (prev === undefined) {
      const saved = read(sessionId);
      if (persistent && !current && saved) { restoring.current = saved; setInput(saved); return; }
    }
    if (prev === undefined || prev === sessionId) { write(sessionId, current); return; }
    const carryOver = prev === null && sessionId !== null && current.trim() !== '';
    if (carryOver) {
      write(null, ''); write(sessionId, current);
      return;
    }
    write(prev, current);
    const saved = read(sessionId);
    restoring.current = persistent ? saved : null;
    setInput(saved);
  // The helpers deliberately close over refs; only input/session changes should save a draft.
  }, [sessionId, input, setInput]);
}
