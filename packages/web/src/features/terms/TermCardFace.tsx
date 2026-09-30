/** 一条词条对应的一张卡面摘要；卡数和稀有度来自 cards/state 的同一份服务端快照。 */
import type { CardWallRow } from '../../lib/api-cards';

export function TermCardFace({ row }: { row?: CardWallRow }) {
  if (!row) return null;
  const { card } = row;
  return (
    <span
      className="term-card-face"
      data-r={card.rarity}
      title={`${card.rarity} 卡 · ${card.cards} 张 · ★${card.star}`}
      aria-label={`卡面 ${card.rarity}，${card.cards} 张，${card.star} 星`}
    >
      <span className="term-card-face-gem" aria-hidden="true">✦</span>
      <span>{card.rarity}</span>
      <span>★{card.star}</span>
      <span>{card.cards} 张</span>
    </span>
  );
}
