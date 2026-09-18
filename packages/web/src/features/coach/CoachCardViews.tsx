/**
 * CoachCardViews — 卡片流里的两种卡（**展示组件**，只有渲染没有状态）。
 *
 * ① `QueueCard` —— 今日队列里的一条词条：**先翻牌、再看释义**，然后「记住了 / 忘了」。
 *    翻面这个动作是刻意的：复习的核心是"先自己回忆，再对照答案"，一上来就摊开释义
 *    等于把复习降级成阅读（与词条页 `ReviewPanel` 同一条取舍）。
 * ② `StreamCard` —— 流水里的五种卡：督促 AI / 我 / 提醒 / 复习动作 / 趋势（P4 起）。
 *    ★ 复习动作独立成卡而不是一句灰色小字：**"我今天到底做了多少"是小窗一半的价值**，
 *      它值得有形状（词名 + 记得/忘了 + 下一档间隔），而不是淹没在时间线里。
 *    ★ 趋势卡（P5）的折线**由本地代码画、不由模型画**：数字全部来自服务端 SQL
 *      （契约 `docs/MEMORY-TREND-SPEC.md` §4.3），前端只负责把它画出来。
 */
import { useMemo } from 'react';
import type { CoachCard } from '@sb/shared';
import type { ReviewTermItem } from '../../lib/api';
import { renderTrendSvg } from '../../lib/chart-utils';
import { prepareSvg } from '../../lib/svg-utils';
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

/** 流水卡：五种 kind 各自的一种形状（P5 起趋势卡带 SVG 折线） */
export function StreamCard({ card, now }: { card: CoachCard; now?: Date }) {
  const time = formatCardTime(card.at, now);
  // 卡片锚点：`CoachFeed` 靠它把「点气泡 → 滚到那张卡」落到具体节点。
  // ★ 只在这里定义一次、五处 `{...anchor}` 复用——将来加第六种卡也不会漏掉这个属性。
  const anchor = { 'data-card-id': card.id };
  // 趋势卡的折线。★ 必须过 `prepareSvg`（本仓约定「自产 SVG 也要净化一遍」）：
  // 这是本组件唯一一处把字符串塞进 innerHTML 的地方，净化就是这行代码的许可证。
  // ★ 空数组（坏 meta 被服务端退成的形状）⇒ `renderTrendSvg` 返回 ''，图形整块不渲染，
  //   而下面的摘要**照常显示**（契约 §4.5）。
  const trendSvg = useMemo(
    () =>
      card.kind === 'trend'
        ? prepareSvg(renderTrendSvg({ labels: card.labels, values: card.values }))
        : '',
    [card],
  );
  if (card.kind === 'review') {
    return (
      <div className="coach-card coach-card-review" {...anchor}>
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
      <div className="coach-card coach-card-nudge" {...anchor}>
        <div className="coach-nudge-body">{card.text}</div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  if (card.kind === 'me') {
    return (
      <div className="coach-card coach-card-me" {...anchor}>
        <div className="coach-me-body">{card.text}</div>
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  if (card.kind === 'trend') {
    // 趋势卡：**图是主产物，摘要是配文**（契约 §4.3）。
    // ★ 摘要来源写进 `title` 而不是卡面：`fallback` 是"模型本次没参与"的诊断信息，
    //   摊在卡面上会让用户以为图有问题（其实图才是真的那一半），悬停可查即可。
    return (
      <div className="coach-card coach-card-trend" {...anchor}>
        <div
          className="coach-tr-head"
          title={card.summarySource === 'ai' ? '摘要由模型根据这些数据写成' : '模型本次未参与，摘要由数据自动生成'}
        >
          近期学习趋势 · 近 {card.windowDays} 天
        </div>
        {/* 注入点：renderTrendSvg 自产（文本已 esc）+ prepareSvg 净化，同 ChartCard 的落法 */}
        {trendSvg && <div className="coach-tr-chart" dangerouslySetInnerHTML={{ __html: trendSvg }} />}
        <div className="coach-tr-body">{card.summary}</div>
        {/* top 榜（契约 §6.3：本版就是「单序列 + top 榜」）——领域在前、术语在后，
            ★ 与摘要是**同一次取数**的两个视图，不是另算一套口径 */}
        {(card.topDomains.length > 0 || card.topTerms.length > 0) && (
          <div className="coach-tr-ranks">
            {card.topDomains.map((d) => (
              <span key={`d:${d.domain}`} className="coach-tr-chip">
                {d.domain}
                <span className="coach-tr-n">{d.count}</span>
              </span>
            ))}
            {card.topTerms.map((t) => (
              <span key={`t:${t.term}`} className="coach-tr-chip term">
                {t.term}
                <span className="coach-tr-n">{t.count}</span>
              </span>
            ))}
          </div>
        )}
        <span className="coach-card-time">{time}</span>
      </div>
    );
  }
  return (
    <div className={card.streaming ? 'coach-card coach-card-ai streaming' : 'coach-card coach-card-ai'} {...anchor}>
      <div className="coach-ai-tag">督促</div>
      <div className="coach-ai-body">{card.text || '…'}</div>
      <span className="coach-card-time">{time}</span>
    </div>
  );
}
