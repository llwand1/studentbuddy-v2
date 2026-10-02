/**
 * llm/platform-budget — 平台通道的**全站每日**调用上限（2026-10-02，契约 docs/TENANCY-SPEC.md §8.1.3.4）。
 *
 * ── 为什么必须新增这道闸 ────────────────────────────────────────────────────
 * 线上切到**付费 key** 后，`SB_PLATFORM_QUOTA_MAX` 设为不限（每用户次数配额取消），只剩并发闸门。
 * 而 `auth/register-limit.ts` 的反滥用前提正是「每号一份平台配额」——前提一破，
 * 「每用户无限 + 只限并发」＝ **批量建号可无限烧钱**（脚本慢刷，每个账号都合法、并发也不高）。
 * ⇒ 补一道**不分用户**的每日总量闸：平台这一整天最多花 `SB_PLATFORM_DAILY_MAX` 次上游调用。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────────
 * · 计数单位＝**每次上游调用**，与 v39 每用户配额同口径（理由见 `@sb/shared/platform-quota`）。
 * · `day` 键＝服务器**本地日** `YYYY-MM-DD`，用 `localDayKey`——与 `growth/activity.ts` 同一把口径。
 * · 时序＝**先断言、后计数**（与并发闸门一致）：断言在拿并发槽**之前**快速失败；
 *   计数在两层并发槽都拿到之后（被闸门拒绝的请求**不计费**，用户没得到服务）。
 * · 落库表 `platform_call_day`（迁移 v53），UPSERT 自增 + 只留当天一行。
 *
 * ★ 超限**复用** `PlatformQuotaExceededError` 与 `PLATFORM_QUOTA_CODE`（**不新造码**）：
 *   上层（`chat/flow.ts` 等）按这个码给「去配自己的模型」那条处置；新造码会让全站闸的失败
 *   退化成一句没用的"稍后再试"。文案换成 `PLATFORM_BUDGET_MESSAGE`（措辞不同、出路相同）。
 */
import {
  localDayKey,
  PLATFORM_BUDGET_ENV,
  PLATFORM_BUDGET_MESSAGE,
  parsePlatformBudgetMax,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { PlatformQuotaExceededError } from './platform-quota.js';

/**
 * 当前生效的全站每日上限：`null` ＝ 不限。
 * ★ 每次调用现读 env（不模块级快照），与 `platformQuotaMax` 同一风格——便于测试改 env。
 */
export function siteBudgetMax(): number | null {
  return parsePlatformBudgetMax(process.env[PLATFORM_BUDGET_ENV]);
}

/** 服务器本地日键 `YYYY-MM-DD`（与 `growth/activity.ts` 的 `user_activity_day` 同一把 `localDayKey`）。 */
function todayKey(now: number): string {
  return localDayKey(new Date(now));
}

/** 距**服务器本地明日 0 点**的毫秒数（全站闸的 `retryAfterMs`：到点新的一天、额度清零）。 */
function msToLocalMidnight(now: number): number {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now);
}

/** 今天已消耗的全站调用次数（只读，不写库）。 */
export function siteCallsToday(now: number = Date.now()): number {
  const row = getDb().prepare('SELECT calls FROM platform_call_day WHERE day = ?').get(todayKey(now)) as
    | { calls: number }
    | undefined;
  return row?.calls ?? 0;
}

/**
 * 超限即抛（快速失败）。★ 与每用户断言**同一位置**：拿并发槽**之前**。
 * 边界：`calls >= max` 就拒——即当天的第 `max + 1` 笔被挡（前 `max` 笔正常发出）。
 */
export function assertSiteBudget(now: number = Date.now()): void {
  const max = siteBudgetMax();
  if (max === null) return; // 不限：全站闸关（只留并发闸门）
  if (siteCallsToday(now) < max) return;
  throw new PlatformQuotaExceededError(msToLocalMidnight(now), PLATFORM_BUDGET_MESSAGE);
}

/**
 * 记一笔全站消耗（UPSERT 自增 ＋ 顺手清旧日行，**放同一个事务**）。
 *
 * ★ 清理与插入放同一个事务的理由（同 `recordPlatformUsage`）：分开写会出现"清完了但插入失败"
 *   ⇒ 当天少记一笔（成本少算）；或"插入成功但没清"⇒ 表缓慢膨胀。事务把两者绑成一件。
 * ★ 只留当天一行（`day <> ?` 全删）：本表本就只有「今天」这一个热键，删旧日行不构成大锁。
 */
export function recordSiteCall(now: number = Date.now()): void {
  const db = getDb();
  const day = todayKey(now);
  db.transaction(() => {
    db.prepare(
      'INSERT INTO platform_call_day (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1',
    ).run(day);
    db.prepare('DELETE FROM platform_call_day WHERE day <> ?').run(day);
  })();
}

/** 测试用：清空全站用量表（生产路径不调用）。 */
export function resetSiteBudget(): void {
  getDb().prepare('DELETE FROM platform_call_day').run();
}