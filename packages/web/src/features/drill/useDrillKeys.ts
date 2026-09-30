/**
 * useDrillKeys — 刷词的键位（契约 `docs/WAIT-DRILL-SPEC.md` §5.4）：1–4 选项 / Enter 下一张（或收入词库、记住了）/
 * N 不认识 / Z 斩 / X 不要 / Esc 收起。
 *
 * ★ 焦点在**小窗里的**输入框（拼写卡）时字母与数字不劫持——那是在打字；Enter 由表单自己提交，Esc 照常关。
 * ★ 2026-09-30 小窗改成非模态浮窗（§5.6）之后，**小窗外的输入框也算打字**：学习者点回聊天框敲字、按 Esc 停止生成，
 *   都不该被刷词截走。打开小窗时焦点会被挪进去（DrillOverlay），所以「发完消息直接按 1–4」仍然生效——
 *   只有学习者**自己点回**输入框之后，按键才归输入框。焦点在 body / 小窗里时照旧归小窗并 `preventDefault`。
 * ★ 只在小窗开着时挂监听；用 ref 读最新回调，避免每次状态变化都重挂。
 */
import { useEffect, useRef } from 'react';

export interface DrillKeyHandlers {
  onDigit: (index: number) => void;
  onEnter: () => void;
  onDontKnow: () => void;
  onSlay: () => void;
  onDismiss: () => void;
  onClose: () => void;
}

export function useDrillKeys(enabled: boolean, handlers: DrillKeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      const inDrill = el?.closest('.drill-overlay') !== null;
      const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
      // 小窗外的输入框：整个不管（含 Esc——那是聊天框自己的「停止生成」）
      if (isField && !inDrill) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        ref.current.onClose();
        return;
      }
      if (isField) return;
      if (e.key >= '1' && e.key <= '4') {
        e.preventDefault();
        ref.current.onDigit(Number(e.key) - 1);
        return;
      }
      const k = e.key.toLowerCase();
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ref.current.onEnter();
      } else if (k === 'n') {
        e.preventDefault();
        ref.current.onDontKnow();
      } else if (k === 'z') {
        e.preventDefault();
        ref.current.onSlay();
      } else if (k === 'x') {
        e.preventDefault();
        ref.current.onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
