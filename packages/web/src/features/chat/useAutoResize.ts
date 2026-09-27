/**
 * useAutoResize —— textarea 随内容自增高（替代固定 rows=2）。
 *
 * 主流（ChatGPT / Claude / 豆包）输入框都是单行起步、随内容长高、到上限再内滚；
 * 固定 rows=2 时敲多行只能靠内部滚动条，看不到全文。
 *
 * 量好的高度写进 CSS 变量 --ta-h 而不是直接改 style.height：
 * 尺寸决策留在 chat.css（门禁禁内联 style，数据驱动样式走变量）。
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

/** 上限与 chat.css 的 max-height 保持一致，超了之后交给 overflow-y:auto 内滚 */
const MAX_H = 200;

export function useAutoResize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 空值不测量：Chrome 里空 textarea 的 scrollHeight 按 placeholder 的折行行数计算，
    // 窄容器下长 placeholder（欢迎页那句 266px）折成多行会把高度撑到 MAX_H 封顶——
    // 表现为「欢迎页输入框变成 200px 大块，一输入字就恢复」（实测 vw=560 时 scrollH=238）。
    // 空值直接摘掉变量，回落 chat.css 的 height: var(--ta-h, 44px) 基准。
    if (value === '') {
      el.style.removeProperty('--ta-h');
      return;
    }
    // 必须先归到 auto 再读 scrollHeight：直接读拿到的是「当前被撑开的高度」，
    // 删字/清空时内容变短却缩不回去，会一路只增不减
    el.style.setProperty('--ta-h', 'auto');
    el.style.setProperty('--ta-h', `${Math.min(el.scrollHeight, MAX_H)}px`);
  }, [ref, value]);
}
