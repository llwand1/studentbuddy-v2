/**
 * llm/image-quota — 生图平台通道的**张数闸**（每日每用户）与**并发闸**（每人同时 1 张）。
 *
 * 契约 `docs/IMAGE-GEN-SPEC.md` §5。存在理由是归属的老问题在生图上的新形态：
 * 「谁付钱」——BYOK 用户烧自己的 key 不设张数（他自愿），平台通道（env key）是平台的真金，
 * 必须有闸。闸不落在调用方、落在本文件，是因为「先查再打」必须在**发起上游请求之前**发生：
 * 到顶还照发，等于白烧一次上游调用（钱花了、图没给）。
 *
 * ★ 计次落点 ＝ `tool_stats`（不是 `event_log`）：`event_log` **没有 owner 列**（obs.ts 头注
 *   实锤，归属只能回 sessions 判，而生图事件未必有会话锚），`tool_stats` 自 v35 起就带
 *   `owner_id / tool / ok / created_at`——恰好是「谁、用了什么工具、成没成、哪天」四要素，
 *   **零迁移**。且计次与设置页「工具」卡读同一张表，两边数字天然对得上。
 *
 * ★ 已知保守偏置（如实登记，SPEC §5）：同用户同日 BYOK 与平台混用时（绑定 provider 被停用
 *   会整条回落平台），计数分不出通道，BYOK 成功张数也占平台额度——宁紧勿松；解开来要给
 *   tool_stats 加列（迁移），收益不抵，留给需要时再做。
 */
import { getDb } from '../storage/db.js';

/** 工具名唯一登记处：`tool_stats.tool` 落的就是它，工具注册文件也 import 这一个常量。 */
export const IMAGE_TOOL_NAME = 'generate_image';

/** 平台通道每用户每日张数缺省（env 可调）。 */
const DEFAULT_DAILY_LIMIT = 15;

/**
 * 每日张数上限（env `SB_IMAGE_DAILY_LIMIT`，**每次调用都读**——同 platform-channel 的
 * 凭据口径，测试要能改 env 验证，运维改完重启即生效）。
 * ★ `0` ＝ 平台通道整体关闭生图（已知状态不是故障，回灌文案要说「不是坏了」）；
 *   非法值（NaN/负数/小数取整前）一律回落缺省——配置错误不该把闸门悄悄拆掉。
 */
export function imageDailyLimit(): number {
  // ★ 必须先拦空串：`Number('') === 0` 而**不是 NaN**——不拦的话「env 未配」会被当成
  // 「limit 0 ＝ 平台生图整体关闭」，零配置部署的生图一行代码没跑就全灭。
  // 这正是仓里记过的 `normalizeImportance` 同族坑（空值回落的是"关"不是"默认"）。
  const raw = (process.env.SB_IMAGE_DAILY_LIMIT ?? '').trim();
  if (raw === '') return DEFAULT_DAILY_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_LIMIT;
  return Math.floor(n);
}

/**
 * 「今天」的起点，按 `tool_stats.created_at` 的口径表达（SQLite `datetime('now')` ＝
 * **UTC** 的 `YYYY-MM-DD HH:MM:SS`）。字符串比较即区间判断。
 *
 * ★ 日期边界按**本地日历日**（同款口径：天数按本地日历日、存储按 UTC 读）——
 *   「每天 15 张」的用户预期是本地午夜重置，不是东八区早上 8 点。故先在 JS 里算出
 *   **本地零点**，再换算成它对应的 UTC 时刻去比 `created_at`。
 * ★ `now` 参数是给测试的（同 date-context.ts 的手法）：不注入就测不到跨日边界。
 */
export function localDayStartUtc(now: Date = new Date()): string {
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return localMidnight.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 该用户今天（本地日历日）已成功生成几张。**只数 `ok = 1`**——失败的上游调用没出图，
 * 让用户为平台的 429 白白付张数，等于把上游故障转嫁给用户（ADR-5 的账不能这么算）。
 */
export function countTodayImages(ownerId: string, now: Date = new Date()): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM tool_stats
        WHERE tool = ? AND owner_id = ? AND ok = 1 AND created_at >= ?`,
    )
    .get(IMAGE_TOOL_NAME, ownerId, localDayStartUtc(now)) as { c: number };
  return Number(row.c);
}

// ── 并发闸：同用户同时只允许 1 张在处理 ────────────────────────────────────────
// 为什么必须有它：日闸是「计数后放行」，两次并发同时查账都看到「还差一张」就双双放行
// （check-then-act 竞态）⇒ 日限 15 能打出 29 张。单用户串行化是唯一便宜且可靠的封法，
// 也顺带防了 BYOK 用户并发轰炸上游吃 429。进程内 Set 即可：单机部署没有多实例问题
// （upstream-gate.ts「已知边界」同款口径，如实登记不假装它是分布式的）。

const inFlight = new Set<string>();

/** 进行中桶键：`null`（未登录单人模式）归同一个桶——单人模式本来就只有一个用户。 */
export function imageSlotKey(ownerId: string | null): string {
  return ownerId ?? '';
}

/** 占坑；已占则 `false`（调用方据此回「上一张还在画」的 busy 文案，不排队）。 */
export function tryAcquireImageSlot(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** 释放坑位（**必须**放在调用方 finally 里——漏放等于该用户永久 1 张都出不来）。 */
export function releaseImageSlot(key: string): void {
  inFlight.delete(key);
}
