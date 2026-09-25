/**
 * 复习计划表的核心算法（纯函数，无 IO、无 DOM）。
 *
 * ★ 为什么单独一层：构建期要拿它渲那张形状表，测试要拿它核对页面里的内联脚本，
 *   两边都不该复制一份日期算术。七个复查节点本身**不在这里**——它只有一个来源：
 *   `REVIEW_INTERVALS_DAYS`（`@sb/shared`，前后端共用的复习契约）。
 * ★ 口径与产品同一套（见 `docs/EBBINGHAUS-SPEC.md`）：以**本地日历日**为最小单位，
 *   学完当天不复习，第 1/2/4/7/15/30/60 天各回炉一次；每天新学同一批，批次按「几天前学的」编号。
 */
// ★ 走子路径而不是 `@sb/shared` 根：`vite.config.ts` 在纯 Node 里加载这一层，根入口内部的 `./x.js` 说明符它解析不动
import { REVIEW_INTERVALS_DAYS } from '@sb/shared/ebbinghaus';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** `YYYY-MM-DD` + N 天 → `YYYY-MM-DD`（走 UTC 午夜，避开夏令时与本地时区的整天偏移） */
export function addCalendarDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days));
  const mm = `${dt.getUTCMonth() + 1}`.padStart(2, '0');
  const dd = `${dt.getUTCDate()}`.padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** 该日的星期短名（`一`／`六`／`日`） */
export function weekdayOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay()] as string;
}

export interface PlanRow {
  /** 距起始日的偏移，起始日为 0 */
  offset: number;
  date: string;
  weekday: string;
  /** 当天新学条数 */
  newCount: number;
  /** 当天要回炉的条数 */
  reviewCount: number;
  /** 当天回炉的是「几天前学的那几批」——元素必是 `REVIEW_INTERVALS_DAYS` 的成员 */
  reviewBatches: readonly number[];
  /** 当天合计条数 */
  total: number;
}

export function clampDailyNew(v: number): number {
  const n = Math.trunc(Number.isFinite(v) ? v : 0);
  return Math.min(Math.max(n, 1), 100);
}

export function clampDays(v: number): number {
  const n = Math.trunc(Number.isFinite(v) ? v : 0);
  return Math.min(Math.max(n, 1), 180);
}

/**
 * 排出 `days` 天的计划表。
 *
 * ★ 每天一批新学（`dailyNew` 条），第 d 天要回炉的是「d − 节点」那几天学的批次，
 *   所以回炉量随天数**阶梯式上升**——这正是这张表要让人看见的东西，不是随手加的难度。
 */
export function buildPlan(start: string, dailyNew: number, days: number): PlanRow[] {
  const n = clampDailyNew(dailyNew);
  const span = clampDays(days);
  const rows: PlanRow[] = [];
  for (let offset = 0; offset < span; offset++) {
    const date = addCalendarDays(start, offset);
    const reviewBatches = REVIEW_INTERVALS_DAYS.filter((i) => offset - i >= 0);
    const reviewCount = n * reviewBatches.length;
    rows.push({
      offset,
      date,
      weekday: weekdayOf(date),
      newCount: n,
      reviewCount,
      reviewBatches,
      total: n + reviewCount,
    });
  }
  return rows;
}

export interface PlanSummary {
  totalNew: number;
  totalReview: number;
  /** 单日合计最大的那天（并列取最早那个） */
  peak: PlanRow;
  /** 日均合计条数（整数，四舍五入） */
  avgTotal: number;
  /** 走完全部节点的那一天（最后一天是否已见过第 60 天那档回炉） */
  seesLastNode: boolean;
}

export function summarize(rows: readonly PlanRow[]): PlanSummary {
  const totalNew = rows.reduce((s, r) => s + r.newCount, 0);
  const totalReview = rows.reduce((s, r) => s + r.reviewCount, 0);
  const totalAll = totalNew + totalReview;
  let peak = rows[0] as PlanRow;
  for (const r of rows) if (r.total > (peak?.total ?? 0)) peak = r;
  const lastNode = REVIEW_INTERVALS_DAYS[REVIEW_INTERVALS_DAYS.length - 1] as number;
  return {
    totalNew,
    totalReview,
    peak,
    avgTotal: rows.length > 0 ? Math.round(totalAll / rows.length) : 0,
    seesLastNode: rows.some((r) => r.reviewBatches.includes(lastNode)),
  };
}

/** 表头的「回炉」列文案：`1/2/4/7/15/30/60 天前` —— 与契约同源，不另写一份数字 */
export const NODES_LINE = REVIEW_INTERVALS_DAYS.join('/');
