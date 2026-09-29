/**
 * useSourceKeys —— 资料架的键盘切换（契约 docs/SOURCE-TRACE-SPEC.md §8.4）。
 *
 *  `[` / `]`          上一条 / 下一条（面板顺序：精选 → 读过 → 搜到，两端回绕）
 *  Alt+← / Alt+→      同上（给不习惯方括号的人）
 *  Alt+1 … Alt+9      直达第 k 条
 *
 * ★ 只在「不是在打字」时生效：焦点在 input / textarea / contentEditable 里一律放行给输入框——
 *   学习者在聊天框里敲 `[` 是要打字，不是要翻资料。Alt 组合同理（Alt+← 在部分输入法里是光标跳词）。
 * ★ 不抢 Esc：Esc 已被刷词小窗与「停止生成」用着；关面板点 ×。
 */
import { useEffect } from 'react';
import { selectSourceAt, stepSource } from '../../lib/sources-store';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 纯函数：一次按键该做什么（可单测；返回 false 表示不归本 hook 管） */
export function handleSourceKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>): boolean {
  if (e.ctrlKey || e.metaKey || isTyping(e.target)) return false;
  if (!e.altKey && (e.key === '[' || e.key === ']')) {
    stepSource(e.key === ']' ? 1 : -1);
    return true;
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    stepSource(e.key === 'ArrowRight' ? 1 : -1);
    return true;
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    selectSourceAt(Number(e.key));
    return true;
  }
  return false;
}

export function useSourceKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (handleSourceKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
