/**
 * CoachFeed — 抽屉里的**卡片流**（老板 2026-09-18 拍板的 E 部分）。
 *
 * 两段结构，顺序即使用顺序：
 *  ① **今日队列**（可横向滚动的一叠卡）：先干事——翻牌回忆 → 记住了/忘了；
 *  ② **流水**（时间正序的卡片列表）：再复盘——AI 说过什么、我今天背了哪些。
 * 把队列放在流水**上方**是刻意的：默认打开小窗的人多半是来"还账"的，
 * 让他先看见能立刻做的动作，而不是先读 AI 昨天说了什么。
 *
 * 翻牌状态（`revealed`）留在本组件内：它纯属浏览态，不该污染卡片数据的合并逻辑。
 */
import { useEffect, useRef, useState } from 'react';
import type { CoachCard } from '@sb/shared';
import type { ReviewTermItem } from '../../lib/api';
import { QueueCard, StreamCard } from './CoachCardViews';

export function CoachFeed({
  cards,
  queue,
  busyTerm,
  onReview,
  focusCardId,
  onFocused,
}: {
  cards: CoachCard[];
  queue: ReviewTermItem[];
  /** 正在打卡的词条 id（防重复点击） */
  busyTerm: string | null;
  onReview: (termId: string, remembered: boolean) => void;
  /** 要滚过去的卡 id（气泡点开时由 `CoachDock` 传入；`null`/缺省＝不滚） */
  focusCardId?: string | null;
  /** 滚完通知调用方清位（避免下次开抽屉又滚回去） */
  onFocused?: () => void;
}) {
  const [revealed, setRevealed] = useState<string[]>([]);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const toggle = (id: string) =>
    setRevealed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // 滚到指定卡：抽屉与 `focusCardId` 在同一次 `setState` 批次里落地（`openDrawer`），
  // 故本次 effect 跑时目标节点必然已挂载，不需要 rAF/重试。
  // ★ 用**属性值比对**而不是把 id 拼进 CSS 选择器——卡片 id 来自库，拼进选择器就开了注入面。
  useEffect(() => {
    if (!focusCardId) return;
    const hit = Array.from(streamRef.current?.querySelectorAll('[data-card-id]') ?? []).find(
      (el) => el.getAttribute('data-card-id') === focusCardId,
    );
    hit?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    onFocused?.();
  }, [focusCardId, onFocused]);

  return (
    <div className="coach-feed">
      <section className="coach-queue-sec">
        <div className="coach-sec-head">
          今日队列
          <span className="coach-sec-hint">
            {queue.length > 0 ? `${queue.length} 条 · 点卡片翻面看释义` : '空'}
          </span>
        </div>
        {queue.length === 0 ? (
          <div className="coach-queue-empty">队列是空的 —— 今天没有到期的词条。</div>
        ) : (
          <div className="coach-queue">
            {queue.map((t) => (
              <QueueCard
                key={t.id}
                item={t}
                revealed={revealed.includes(t.id)}
                busy={busyTerm === t.id}
                onReveal={() => toggle(t.id)}
                onReview={(remembered) => onReview(t.id, remembered)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="coach-stream-sec">
        <div className="coach-sec-head">
          督促记录
          <span className="coach-sec-hint">你做了什么、我说过什么，都在这里</span>
        </div>
        {cards.length === 0 ? (
          <div className="coach-stream-empty">
            还没有记录。下面问我一句「今天先背哪个」，或者直接翻上面的牌开始复习。
          </div>
        ) : (
          <div className="coach-stream" ref={streamRef}>
            {cards.map((c) => (
              <StreamCard key={c.id} card={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
