/**
 * 词条页组合入口：同一份卡牌 state 同时驱动每条词卡徽记与下方的宝箱／任务／卡墙，
 * 避免重复订阅 SSE 或发两次 `/api/cards/state`。
 */
import { useCardsState } from '../game/use-cards-state';
import { TermsPage } from './TermsPage';

export function TermsLibraryView({
  initialKeyword = '',
  onGoContinent,
}: {
  initialKeyword?: string;
  onGoContinent: () => void;
}) {
  const cards = useCardsState();
  return <TermsPage initialKeyword={initialKeyword} cardsState={cards} onGoContinent={onGoContinent} />;
}
