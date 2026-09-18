/**
 * CoachCardViews — 卡片流里的两种卡（**展示组件**，只有渲染没有状态）。
 *
 * ① `QueueCard` —— 今日队列里的一条词条：**先翻牌、再看释义**，然后「记住了 / 忘了」。
 *    翻面这个动作是刻意的：复习的核心是"先自己回忆，再对照答案"，一上来就摊开释义
 *    等于把复习降级成阅读（与词条页 `ReviewPanel` 同一条取舍）。
 * ② `StreamCard` —— 流水里的五种卡：督促 AI / 我 / 提醒 / 复习动作 / 趋势（P4 起）。
 *    ★ 复习动作独立成卡而不是一句灰色小字：**"我今天到底做了多少"是小窗一半的价值**，
 *      它值得有形状（词名 + 记得/忘了 + 下一档间隔），而不是淹没在时间线里。
 */
import type { CoachCard } from '@sb/shared';
import type { ReviewTermItem } from '../../lib/api';
import { formatCardTime, retentionLevel, reviewCardResult } from './coach-cards';

/** 队列卡：一条待复习词条（翻牌 + 打卡） */
export function QueueCard({
  item,
  revealed,
  busy,
  onReveal,
  onReview,
}: {
  item: ReviewTermItem;
  revealed: boolean;
  busy: boolean;
  onReveal: () => void;
  onReview: (remembered: boolean) => void;
}) {
  const r = item.review;
  const overdue = r.overdueDays > 0;
  return (
    <div className={`coach-qcard lv-${retentionLevel(r.retention)}${revealed ? ' revealed' : ''}`}>
      <button className="coach-qcard-face" onClick={onReveal} title={revealed ? '收起释义' : '看释义'}>
        <span className="coach-qterm">{item.term}</span>
        <span className="coach-qdomain">{item.domain}</span>
        <span className={overdue ? 'coach-qdays overdue' : 'coach-qdays'}>
          {overdue ? `逾期 ${r.overdueDays} 天` : '今天到期'} · {r.daysSince} 天没碰
        </span>
        <span className="coach-qret">记忆 ≈ {Math.round(r.retention * 100)}%</span>
      </button>
      {revealed && <div className="coach-qdef">{item.definition || '（这条还没有释义）'}</div>}
      <div className="coach-qacts">
        <button className="coach-qbtn ok" disabled={busy} onClick={() => onReview(true)}>
          记住了
        </button>
        <button className="coach-qbtn danger" disabled={busy} onClick={() => onReview(false)}>
          忘了
        </button>
      </div>
    </div>
  );
}

/** 流水卡：五种 kind 各自的一种形状（趋势卡的图形化渲染属 P5，本批先给标题 + 摘要） */
export function StreamCard({ card, now }: { card: CoachCard; now?: Date }) {
  const time = formatCardTime(card.at, now);
  if (card.kind === 'review') {
    return (
      <div className="coach-card coach-card-review">
        <span className={card.remembered ? 'coach-rv-mark ok' : 'coach-rv-mark bad'}>
          {card.remembered ? '记住' : '忘了'}
        </span>
        <div className="coach-rv-main">
          <div className="coach-rv-term">{card.term}</div>
          <div className="coach-rv-sub">{reviewCardResult(card)}</div>
        </div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  if (card.kind === 'nudge') {
    return (
      <div className="coach-card coach-card-nudge">
        <div className="coach-nudge-body">{card.text}</div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  if (card.kind === 'me') {
    return (
      <div className="coach-card coach-card-me">
        <div className="coach-me-body">{card.text}</div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  if (card.kind === 'trend') {
    // P4 只给「能看见」的最小形状：标题（含窗口）+ 摘要。★ 真正的 SVG 折线图与胶囊旁
    // 那个「你的近期学习趋势生成了！」气泡属 P5——本批是后端（定时 + 模型 + SSE），
    // 但卡片已经在同一条流水里，前端不认它就等于服务端白生成。
    return (
      <div className="coach-card coach-card-trend">
        <div className="coach-tr-head">近期学习趋势 · 近 {card.windowDays} 天</div>
        <div className="coach-tr-body">{card.summary}</div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  return (
    <div className={card.streaming ? 'coach-card coach-card-ai streaming' : 'coach-card coach-card-ai'}>
      <div className="coach-ai-tag">督促</div>
      <div className="coach-ai-body">{card.text || '…'}</div>
      <span className="coach-card-time">{time}</span>
    </div>
  );
}
