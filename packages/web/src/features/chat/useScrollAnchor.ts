/**
 * useScrollAnchor —— 流式输出的滚动锚定（修「上翻被强制拉回底部」）。
 *
 * 原实现是 useEffect 里无条件 `scrollIntoView({behavior:'smooth'})`，依赖 streamingText
 * ⇒ 每个 token 触发一次平滑滚动：① 用户上翻看长回答会被持续拽回底部；② 高频 smooth 队列堆积。
 * 改法：只有「用户贴底」时才跟随；离底时交出控制权并显示「回到底部」。
 *
 * 贴底判定用 ref 而非 state：滚动事件极高频，state 每次都要重渲染，
 * 而跟随判断是同步读取的（滚动回调里立刻用），ref 才是正确载体。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldAutoScroll } from './chat-meta';

export function useScrollAnchor(signal: readonly unknown[]) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = shouldAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight);
    setShowJump(!stickRef.current);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    // 贴底时用 scrollTop 直接赋值而不是 smooth：每帧一次 smooth 会互相打断，反而抖
    el.scrollTop = el.scrollHeight;
    // signal 是调用方给的变化信号（消息数/流式文本/步骤）
  }, signal);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  return { scrollRef, showJump, onScroll, jumpToBottom };
}
