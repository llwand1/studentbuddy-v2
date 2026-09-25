/**
 * coach-cards — 督促卡片流的**纯函数**（合并 / 排序 / 时间文案 / 档位）。
 *
 * ★ 为什么单独成文件：卡片流的合并规则（SSE 增量 + 乐观插入 + 服务端落库回读三方交汇）
 *   是本功能最容易出 bug 的地方，而它**完全不需要 React 就能测**——本仓既有约定
 *   （判定逻辑留在纯函数里，组件只接线，先例 `chat/doc-name.ts`）。
 * ★ 时间一律走 `shared/coach.ts` 的 `parseCoachTime`：库里的 `datetime('now')` 是
 *   **UTC 且无时区标记**，直接 `new Date(raw)` 在 +8 区会差 8 小时（"刚刚发生的复习"显示成 8 小时前）。
 */
import { localDayIndex, parseCoachTime, type CoachCard } from '@sb/shared';

/** 正在生成的那张临时 AI 卡的固定 id（done 后由真卡替换） */
export const STREAMING_CARD_ID = '__coach_streaming__';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** 同一条流的时间正序（`Array.sort` 稳定 ⇒ 同一秒内保持传入顺序） */
export function sortCards(cards: CoachCard[]): CoachCard[] {
  return [...cards].sort((a, b) => (parseCoachTime(a.at)?.getTime() ?? 0) - (parseCoachTime(b.at)?.getTime() ?? 0));
}

/**
 * 合并两条卡流：以 `prev` 为基，`incoming` 里的同 id 卡**覆盖**、新 id **追加**。
 * 覆盖而非追加是本函数的全部意义——同一张卡在「乐观插入 → 服务端落库 → 重连回放」
 * 三个阶段会出现三次，追加就会看到三张一模一样的复习卡。
 */
export function mergeCards(prev: CoachCard[], incoming: CoachCard[]): CoachCard[] {
  const map = new Map(prev.map((c) => [c.id, c]));
  for (const c of incoming) map.set(c.id, c);
  return sortCards([...map.values()]);
}

/** 把「正在流的那段文本」挂成一张临时卡（文本为空则不插——空卡会显示成一个空框） */
export function withStreaming(cards: CoachCard[], text: string, at: string): CoachCard[] {
  const rest = cards.filter((c) => c.id !== STREAMING_CARD_ID);
  if (!text) return rest;
  return [...rest, { id: STREAMING_CARD_ID, kind: 'ai', text, at, streaming: true }];
}

/** 摘掉临时卡（`done` 后由落库的真卡接管） */
export function dropStreaming(cards: CoachCard[]): CoachCard[] {
  return cards.filter((c) => c.id !== STREAMING_CARD_ID);
}

/**
 * 卡片时间文案：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / MM-DD HH:MM。
 * 只到分钟（本功能以天为最小判定单位，秒级精度没有信息量）。
 */
export function formatCardTime(at: string, now: Date = new Date()): string {
  const t = parseCoachTime(at);
  if (!t) return '';
  const diff = now.getTime() - t.getTime();
  if (diff >= 0 && diff < MIN_MS) return '刚刚';
  if (diff >= 0 && diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)} 分钟前`;
  const hm = `${`${t.getHours()}`.padStart(2, '0')}:${`${t.getMinutes()}`.padStart(2, '0')}`;
  const dayDiff = localDayIndex(now) - localDayIndex(t);
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  const md = `${`${t.getMonth() + 1}`.padStart(2, '0')}-${`${t.getDate()}`.padStart(2, '0')}`;
  return `${md} ${hm}`;
}

/** 复习动作卡的回执文案（"第 3 档 · 下次 4 天后"是用户唯一能从打卡里得到的确定信息） */
export function reviewCardResult(c: Extract<CoachCard, { kind: 'review' }>): string {
  if (!c.remembered) return '已归零，明天重来';
  if (c.stage >= 7) return '已入长期记忆，不再催了';
  return `第 ${c.stage + 1}/7 档 · 下次 ${c.intervalDays} 天后`;
}

/** 保持率分档（0..4）：**用 class 而不是行内宽度**（gates 对 `style={{}}` 有红线） */
export function retentionLevel(retention: number): number {
  const r = Number.isFinite(retention) ? Math.max(0, Math.min(1, retention)) : 0;
  if (r >= 0.9) return 4;
  if (r >= 0.7) return 3;
  if (r >= 0.5) return 2;
  if (r >= 0.3) return 1;
  return 0;
}

/** 胶囊配色档：逾期 = alert（红），今天有欠账 = warn（橙），清零 = ok */
export function capsuleTone(s: { due: number; overdue: number }): 'ok' | 'warn' | 'alert' {
  if (s.overdue > 0) return 'alert';
  if (s.due > 0) return 'warn';
  return 'ok';
}

/** 趋势卡气泡文案（契约 `docs/MEMORY-TREND-SPEC.md` §4.4 的原话） */
export const TREND_BUBBLE_TEXT = '你的近期学习趋势生成了！';

/** 气泡载荷：`cardId` 是「点开之后滚到哪张卡」的落点，文案随载荷一起带（不在渲染时重算判定） */
export interface CoachBubble {
  cardId: string;
  text: string;
}

/**
 * 该不该为新到的卡冒一个气泡 —— **只有趋势卡、且抽屉关着时**才冒（契约 §4.4 两条纪律）。
 *
 * ★ 抽屉开着 ⇒ 卡片会自己出现在用户眼前，再弹一个气泡是**重复告知**；
 * ★ 非趋势卡（尤其是提醒卡）⇒ 胶囊上已经有「报数 + 红点」这套语义了，叠加第二次提醒
 *   会让用户分不清「欠账」和「有消息」哪个更急——这正是 §4.2 说的"气泡不更新红点"。
 * ★ 判定与 `summarySource` **无关**：模型不可用时卡片照常生成（§4.3），
 *   气泡宣告的是"图出来了"，不是"模型说话了"；按摘要来源决定弹不弹，等于把功能
 *   重新绑死在可选依赖上。
 */
export function trendBubble(card: CoachCard, open: boolean): CoachBubble | null {
  if (open || card.kind !== 'trend') return null;
  return { cardId: card.id, text: TREND_BUBBLE_TEXT };
}
