/**
 * drill-focus — 番茄钟工作段的刷词取词口径（契约 `docs/POMODORO-SPEC.md` §5.3）。
 *
 * 为什么单独一个文件：取词这件事在 `useDrillSession` 里只是 `serve()` 开头的四行，
 * 但「方向内刷完了怎么办」是**三级兜底**的产品决策，它值得被单独测、也值得被单独读。
 *
 * ★ 硬过滤（v0.2.157 起）：工作段里方向外的词条**整条不进队列**。
 *   旧的 soft 口径只在同优先级内部排序，而到期词条恒压最上面 ⇒ 定了「数学」照样刷英语，
 *   用户侧的体感就是「方向没生效」。方向是用户显式定的，它该赢过到期排序。
 *
 * ★ 排空后的三级兜底（硬过滤必须自带退路，否则就是把人锁死在空队列前）：
 *     ① `focused`  — 方向内还有没刷的，正常出；
 *     ② `repeat`   — 方向内今天都刷过了 ⇒ **忽略今天「斩」过的**，在方向内重复巩固
 *                    （重复同一批词 > 滑走到别的方向：番茄钟这段时间是用户买给这个方向的）；
 *     ③ `exhausted`— 词库里这个方向一条都没有 ⇒ 队列给空，由调用方去「现场出题」，
 *                    并**如实告诉用户**正在出题，而不是默默回退到全库。
 *   ②③ 都会让调用方顺带去要一次新词（新词提示词里带方向，见 `learning/drill.ts`）。
 *
 * ★ 没开钟 / 休息段（`subject` 为 null）一律走 soft 原路：休息段不是「学数学」（口径 1）。
 */
import { orderDrillQueue, type DrillQueueItem, type DrillQueueTerm } from '@sb/shared';

/** 这一轮取词的结局；`none` ＝ 没有方向（没开钟或休息段），其余三档见文件头 */
export type DrillFocusOutcome = 'none' | 'focused' | 'repeat' | 'exhausted';

export interface DrillFocusQueue {
  items: DrillQueueItem[];
  outcome: DrillFocusOutcome;
}

export interface DrillFocusInput {
  terms: readonly DrillQueueTerm[];
  /** 已含轮次的排序键（同 `useDrillSession`：`${dayKey}|r${served}`） */
  dayKey: string;
  /** 今天「斩」掉的词条 id */
  exclude: ReadonlySet<string>;
  /** 番茄钟工作段的方向；没开钟 / 休息段传 null */
  subject: string | null;
}

/**
 * 按方向取下一轮队列。纯函数、零 IO——`subject` 由调用方从 store 读好再传进来，
 * 这样「现在有没有方向」仍然只有 `pomodoroFocus` 一个判定处（口径 3：不记第二套账）。
 */
export function buildDrillQueue({ terms, dayKey, exclude, subject }: DrillFocusInput): DrillFocusQueue {
  const focus = subject && subject.trim() !== '' ? subject : null;
  if (!focus) return { items: orderDrillQueue(terms, dayKey, exclude), outcome: 'none' };

  const focused = orderDrillQueue(terms, dayKey, exclude, focus, 'hard');
  if (focused.length > 0) return { items: focused, outcome: 'focused' };

  // ② 方向内今天都斩完了：忽略 exclude 再排一次，仍然只在方向内
  const repeat = orderDrillQueue(terms, dayKey, new Set(), focus, 'hard');
  if (repeat.length > 0) return { items: repeat, outcome: 'repeat' };

  // ③ 词库里这个方向一条都没有
  return { items: [], outcome: 'exhausted' };
}

/**
 * 结局对应的屏上说明。返回空串＝不用说话（正常出词时不该有任何提示噪音）。
 * ★ 文案必须说清「为什么你看到的是这些」——ADR-5：状态变化不静默。
 */
export function drillFocusNotice(outcome: DrillFocusOutcome, subject: string | null): string {
  if (!subject || outcome === 'none' || outcome === 'focused') return '';
  if (outcome === 'repeat') return `「${subject}」方向的词条今天都刷过了，开始重复巩固`;
  return `词库里还没有「${subject}」方向的词条，正在现场出新词`;
}

/** 排空（②③）时才去要新词；正常出词不额外打网络 */
export function needsFocusRefill(outcome: DrillFocusOutcome): boolean {
  return outcome === 'repeat' || outcome === 'exhausted';
}
