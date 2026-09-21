/**
 * llm/platform-quota — 平台免费通道的**调用次数**配额（服务端计数）。
 *
 * 常量与形状在 `@sb/shared/platform-quota`（前后端共用）；本文件放**读写库**的那一段，
 * 外加一个 `PlatformMeter` 接口——让闸门能替换掉"怎么记的"（理由见文件末尾）。
 * 口径、计数单位、作用域的理由见 shared 那份文件头，此处不重复。
 *
 * ── 为什么挂在这里而不是新开一层中间件 ────────────────────────────────────
 * 计数点必须是「**一笔上游请求确实要发出去了**」那一刻，而这个时刻在本仓只有一处：
 * `upstream-gate.ts#acquireUpstream`（两个适配器 `openai.ts` / `anthropic.ts` 的 `chat()`
 * 都经过它）。挂在别处（路由层、flow 层）会漏掉后台任务——而 `extractTerms` 与
 * `compactIfNeeded` **恰恰是最容易被漏掉、且真花平台钱**的两笔。
 *
 * ── 时序：**先断言、后计数**，两件事分开 ──────────────────────────────────
 * · `assertPlatformQuota` 在读路径上**快速失败**，让超限请求**不占用并发槽**——
 *   否则额度用完的用户会持续抢占 `upstream-gate` 的桶，把正常用户挡在门外。
 * · `recordPlatformUsage` 在**两层并发槽都拿到之后**才写——被闸门拒绝（外层队列满、
 *   排队中被停止）的请求**不该计费**：用户没得到服务，凭什么扣次数。
 * ★ 代价：同一用户并发 2 路时，两路可能都通过断言、各记一笔（最多超出 1~2 次）。
 *   这是刻意的取舍——为它加一把跨请求锁，收益（少扣 1 次）远小于代价（多一个死锁面）。
 */
import {
  PLATFORM_QUOTA_CODE,
  PLATFORM_QUOTA_MAX_CALLS,
  PLATFORM_QUOTA_MESSAGE,
  PLATFORM_QUOTA_WINDOW_MS,
  type PlatformQuotaState,
} from '@sb/shared';
import { getDb } from '../storage/db.js';

/**
 * 平台额度用尽。★ 单独一个错误类而不是抛 `Error` 字符串：
 * 上层（`chat/flow.ts` 的失败回灌、路由层）要据此**换一种处置**——
 * 普通上游故障的文案是"重试"，本条的文案是"去设置页配自己的模型"。
 */
export class PlatformQuotaExceededError extends Error {
  readonly code = PLATFORM_QUOTA_CODE;
  /** 最早那笔消耗滑出窗口的时间（毫秒）——前端可据此给"约 X 分钟后可再试" */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(PLATFORM_QUOTA_MESSAGE);
    this.name = 'PlatformQuotaExceededError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 窗口下界（含边界：`ts >` 这个界，恰好满 5 小时的那笔算过期） */
function windowStart(now: number): number {
  return now - PLATFORM_QUOTA_WINDOW_MS;
}

/** 窗口内的调用次数（只读，不写库）。 */
export function platformUsageCount(ownerId: string, now: number = Date.now()): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM platform_usage WHERE owner_id = ? AND ts > ?')
    .get(ownerId, windowStart(now)) as { c: number };
  return row.c;
}

/** 配额状态（供 `/api/.../quota` 之类接口回给前端显示剩余次数）。 */
export function platformQuotaState(ownerId: string, now: number = Date.now()): PlatformQuotaState {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c, MIN(ts) AS first FROM platform_usage WHERE owner_id = ? AND ts > ?')
    .get(ownerId, windowStart(now)) as { c: number; first: number | null };
  const used = row.c;
  const first = row.first ?? now;
  return {
    used,
    limit: PLATFORM_QUOTA_MAX_CALLS,
    windowStart: used === 0 ? now : first,
    resetAt: used === 0 ? now : first + PLATFORM_QUOTA_WINDOW_MS,
  };
}

/**
 * 超限即抛（快速失败）。★ 放在拿并发槽**之前**调用。
 * 边界：`used >= limit` 就拒——即第 251 笔被挡（前 250 笔正常发出）。
 */
export function assertPlatformQuota(ownerId: string, now: number = Date.now()): void {
  const used = platformUsageCount(ownerId, now);
  if (used < PLATFORM_QUOTA_MAX_CALLS) return;
  const state = platformQuotaState(ownerId, now);
  throw new PlatformQuotaExceededError(Math.max(0, state.resetAt - now));
}

/**
 * 记一笔消耗（含清理该用户已滑出窗口的旧行，避免表随使用无限增长）。
 *
 * ★ 清理与插入放**同一个事务**：分开写会出现"清完了但插入失败"⇒ 用户白赚一次额度；
 *   或者"插入成功但没清"⇒ 表缓慢膨胀。事务把两者绑成一件。
 * ★ 只清**本用户**的旧行（`WHERE owner_id = ?`）：全表 DELETE 会在用户量上来后
 *   变成一把大锁，而每个用户自己的旧行本来就够清了。
 */
export function recordPlatformUsage(ownerId: string, now: number = Date.now()): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM platform_usage WHERE owner_id = ? AND ts <= ?').run(ownerId, windowStart(now));
    db.prepare('INSERT INTO platform_usage (owner_id, ts) VALUES (?, ?)').run(ownerId, now);
  })();
}

/** 测试用：清空用量表（生产路径不调用）。 */
export function resetPlatformUsage(): void {
  getDb().prepare('DELETE FROM platform_usage').run();
}

// ── 计量器接口（v39 自查补）：让闸门能换掉"怎么记的" ────────────────────────────
/**
 * 闸门只认这两个动作，不认"怎么记的"。
 *
 * ★ 为什么需要这一层：`upstream-gate.test.ts` 是**纯逻辑**用例（文件头明写「不打网络、
 *   不起真定时器」），而它验证"按 owner 分桶"的那组用例带的正是
 *   `{ ownerId: 'A', platform: true }`——**恰是会被计量的那一态**。若闸门直接调落库实现，
 *   那 60 来次 acquire 会**打开并迁移老板的真实库**（`getDb()` 是懒加载真实数据目录，见
 *   `storage/db.ts`），后果有两个，都不轻：
 *   ① 违反 ADR-6「不碰用户数据」——测试往真实库里写一批假 owner 的用量行；
 *   ② 与正在跑的 dev server / 线上进程**争同一把 WAL 写锁** ⇒ 随机红、且现象不可复现。
 *
 * ★ 默认值取**落库实现**而不是 NOOP：这是**fail-closed** 的方向——万一某条新路径忘了显式
 *   装计量器，代价是"照常计量"；反过来（默认 NOOP）的代价是"配额静默失效"，那正是
 *   `upstream-gate.ts` 文件头反复强调要消灭的那类 bug。
 */
export interface PlatformMeter {
  assert(ownerId: string): void;
  record(ownerId: string): void;
}

/** 生产计量器：落库。 */
export const DB_PLATFORM_METER: PlatformMeter = {
  assert: assertPlatformQuota,
  record: recordPlatformUsage,
};

/** 不落库的计量器（**仅测试用**：给纯逻辑用例，不碰任何数据库）。 */
export const NOOP_PLATFORM_METER: PlatformMeter = { assert: () => {}, record: () => {} };
