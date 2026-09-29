/**
 * useDrillKeys — 刷词的键位（契约 `docs/WAIT-DRILL-SPEC.md` §5.4）：1–4 选项 / Enter 下一张（或收入词库、记住了）/
 * N 不认识 / Z 斩 / X 不要 / Esc 关闭。
 *
 * ★ 焦点在**弹窗里的**输入框（拼写卡）时字母与数字不劫持——那是在打字；Enter 由表单自己提交，Esc 照常关。
 *   弹窗外的输入框（发送完消息后焦点还留在聊天输入框里——真机实拍逮到的）不算打字：弹窗是模态，
 *   按键归弹窗，并且要 `preventDefault` 免得数字被打进聊天框。
 * ★ 只在弹窗开着时挂监听；用 ref 读最新回调，避免每次状态变化都重挂。
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
      const typing =
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.closest('.drill-overlay') !== null;
      if (e.key === 'Escape') {
        e.preventDefault();
        ref.current.onClose();
        return;
      }
      if (typing) return;
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
