/**
 * shared/platform-quota — 平台免费通道的**调用次数**配额。
 *
 * ── 背景：为什么要有这一条 ────────────────────────────────────────────────
 * 默认零配置：每 5 小时限定 250 次 AI 调用，直接走平台 key 的额度但不让用户看到；
 * 默认模型额度不够或用户想自己配置模型时，按常规通道去配。
 *
 * 拆成三件事：
 *   ① **零配置**：用户开箱即用，不需要自带 key（平台出钱）。实现＝平台通道的 key/base_url/model
 *      从**环境变量**读（见 `server/src/llm/router.ts` 的 `platformEnvTarget`），
 *      数据库里平台行的 `api_key` 保持为空 ⇒ **用户在任何接口里都读不到那把 key**。
 *   ② **限额**：每用户每 5 小时 250 次（可被 env `SB_PLATFORM_QUOTA_MAX` 取消）。
 *      本文件是这条口径的**唯一常量源**。★ 2026-10-02 起另有**全站每日上限**
 *      （env `SB_PLATFORM_DAILY_MAX`，默认 10000）兜「平台这一整笔钱」——取消每用户上限后
 *      它是唯一还能拦住「批量建号慢慢刷」的闸（只限并发管不住总量）。
 *   ③ **保底通道**：额度用完或用户想用自己的模型 ⇒ 走既有的 BYOK 通道（用户自建 provider + 角色绑定），
 *      那条路本仓 M2c 已经建好，这里不改它，只负责在超限时把用户**引到那里去**。
 *
 * ── 计数单位：**每次上游请求**，不是每轮对话 ─────────────────────────────
 * 一轮对话实际会产生 1~3 次上游调用（主链回复 + `extractTerms` 抽词 + `compactIfNeeded` 压缩）。
 * 若按"每轮对话"计数，用户看到的剩余次数很经用，但**平台的实际成本是 2~3 倍**——
 * 配额是成本控制手段，口径就必须贴着成本走。⇒ 250 次 ≈ 80~120 轮对话。
 *
 * ── 作用域：**每个用户各 250 次**（不是全站合计）──────────────────────────
 * 全站合计会让几个活跃用户互相挤占（先来的把额度吃光，后来的直接不可用）。
 * 代价是总成本随用户数线性增长，需要靠外层并发闸门（`SB_UPSTREAM_SITE_MAX_CONCURRENT`）兜总量。
 * ★ 2026-10-02 起线上取消每用户上限（付费 key），此处的「全站合计会让活跃用户互相挤占」
 *   正是那时**新增全站每日上限**要防的事——所以它做成"全站每日总量"而不是"全站每窗口 250"：
 *   前者是成本阀，后者会把活跃用户互相挤占的老问题原样搬回来。
 *
 * ★ 本文件**只放常量与形状**，不放任何计数逻辑——逻辑在 `server/src/llm/platform-quota.ts`。
 *   理由：常量前后端共用（前端要显示"还剩 N 次"），而计数只发生在服务端。
 */

/** 滚动窗口长度：5 小时。 */
export const PLATFORM_QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * 窗口内允许的**上游调用**次数上限的**默认值**。
 *
 * ★ 2026-10-02 起可被 env 覆盖（`SB_PLATFORM_QUOTA_MAX`）：配 `off`/`unlimited`/`none`
 *   ⇒ **不限**（线上付费 key 上线后即为此态）。未配/空串 ⇒ 仍是本默认值，其它部署行为不变。
 *   解析口径见 `parsePlatformQuotaMax`。
 */
export const PLATFORM_QUOTA_MAX_CALLS = 250;

/** 每用户次数上限的 env 名（见 `parsePlatformQuotaMax`）。 */
export const PLATFORM_QUOTA_MAX_ENV = 'SB_PLATFORM_QUOTA_MAX';

/**
 * 超限错误码（前后端共用）。★ **平台通道的两道限流共用这一个码**（每用户次数上限
 * + 全站每日上限），**刻意不新造码**：上层（`chat/flow.ts` 等）的处置是"重试"还是
 * "去配自己的模型"，是按这个码分的——新造码会让全站闸的失败退化成一句没用的"稍后再试"，
 * 而全站闸恰恰是最需要把用户**引到 BYOK** 的那一态（平台通道当天已经打烊）。
 *
 * ★ 单独给一个码而不是复用 429：429 在本仓已经是"限流，稍后再试"的语义
 *   （`retryAfterMs` 那条链路），而本条的处置动作是「**去配自己的模型**」——
 *   两者给用户的下一步完全不同，混用会让前端只能给出一句无用的"稍后再试"。
 */
export const PLATFORM_QUOTA_CODE = 'PLATFORM_QUOTA_EXCEEDED';

/** 超限时的用户可读文案（ADR-5：失败必须可读、可重试/可自救）。 */
export const PLATFORM_QUOTA_MESSAGE =
  '平台免费额度已用完（每 5 小时 250 次）。你可以在设置页配置自己的模型继续使用，或稍后再试。';

// ── 全站每日上限（2026-10-02）：兜「平台这一整笔钱」的闸 ────────────────────
/**
 * 全站每日调用上限的 env 名（见 `parsePlatformBudgetMax`）。
 *
 * ★ 与「每用户次数上限」是**两回事**，别混：
 *   · 每用户上限（`SB_PLATFORM_QUOTA_MAX`）管「一个人能刷多少」——付费 key 上线后它被取消；
 *   · 全站上限（本条）管「**平台这一整天**总共花多少」——不分用户，是取消每人上限后**唯一**
 *     还能兜住成本的那道闸（只限并发的话，批量建号可以慢慢刷一整天）。
 */
export const PLATFORM_BUDGET_ENV = 'SB_PLATFORM_DAILY_MAX';

/** 全站每日上限的默认值（未配 env 时用它；`off`/`unlimited`/`none` ⇒ 不限）。 */
export const PLATFORM_BUDGET_DEFAULT_MAX = 10000;

/**
 * 全站每日超限时的用户可读文案（ADR-5：失败必须可读、可自救）。
 * ★ 与 `PLATFORM_QUOTA_MESSAGE` 并列，都是「去配自己的模型」这条处置——两者共用
 *   `PLATFORM_QUOTA_CODE` 错误码（见上方「超限错误码」的说明），前端据此给同一句出路。
 */
export const PLATFORM_BUDGET_MESSAGE =
  '全站今日 AI 调用额度已用完，请稍后再试；也可以在设置页配置自己的模型继续使用。';

/** 配额状态（供前端显示剩余次数与回补时刻）。 */
export interface PlatformQuotaState {
  /** 当前窗口内已消耗的调用次数 */
  used: number;
  /** 上限（= `PLATFORM_QUOTA_MAX_CALLS`，随响应带上便于前端不写死） */
  limit: number;
  /** 窗口内**最早**那次调用的时刻（unix ms）；`used === 0` 时等于 `now` */
  windowStart: number;
  /**
   * 额度**开始回补**的时刻（unix ms）= 最早那笔消耗滑出窗口的时间。
   * ★ 注意语义：不是"到点全部重置"，而是**滚动窗口**——到点后每次回补一笔，
   *   所以前端文案应写「最早一笔将在 X 后可再调用」，不要写「X 后额度重置」。
   */
  resetAt: number;
}

/**
 * `/quota` 回给前端的**三态**说明：
 *   · `limited`   —— 该用户有每用户次数上限，且当前**受限**（`PlatformQuotaState` 有效）；
 *   · `local`     —— 未登录本地单人模式：**不计量**（`owner === null`）；
 *   · `unlimited` —— 平台通道已由 env 取消「每用户次数上限」：**不限次数**（但仍受全站每日闸约束）。
 *
 * ★ `limited === false` 有**两种**含义（`local` / `unlimited`），前端必须按 `reason` 分支，
 *   否则会把「不限」显示成「本地模式」，在设置页撒谎。
 */
export type PlatformQuotaReason = 'limited' | 'local' | 'unlimited';

/** `GET /quota` 的响应形状（`limited` 是 `reason` 的便捷投影，两者必须一致）。 */
export interface PlatformQuotaView extends PlatformQuotaState {
  limited: boolean;
  reason: PlatformQuotaReason;
}

/**
 * 上限 env 的**通用解析**（每用户与全站共用同一把口径，只是默认值不同）。
 *
 * 取值规则（完整矩阵见 `llm/platform-quota.test.ts`）：
 *   · 未配 / 空串（去空白后）        ⇒ 返回 `fallback`（保持其它部署的既有行为）；
 *   · 小写等于 `off`/`unlimited`/`none` ⇒ 返回 `null`（＝**不限**）；
 *   · 纯数字且 > 0                    ⇒ 返回该数；
 *   · **其它任何值**（`0`/`-1`/`abc`/`250次`…）⇒ 返回 `fallback`。
 *
 * ★ 最后一条是**刻意的取舍：宁可限额，不静默放开**。一个错字（比如把 `off` 写成 `of`）
 *   若被当成"不限"，线上当场变成成本无上限；而当成默认上限的代价只是"多限了一点"，
 *   用户撞到限额时还能按 `PLATFORM_QUOTA_MESSAGE` 去配自己的模型自救。两侧代价不对称 ⇒ 取严的一侧。
 */
function parseLimit(raw: string | undefined | null, fallback: number): number | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === '') return fallback;
  if (s === 'off' || s === 'unlimited' || s === 'none') return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 0) return n;
  }
  return fallback;
}

/** 解析每用户次数上限（`null` ＝ 不限）。口径与取舍见 `parseLimit`。 */
export function parsePlatformQuotaMax(raw: string | undefined | null): number | null {
  return parseLimit(raw, PLATFORM_QUOTA_MAX_CALLS);
}

/** 解析全站每日上限（`null` ＝ 不限）。口径与取舍见 `parseLimit`，默认值换成 10000。 */
export function parsePlatformBudgetMax(raw: string | undefined | null): number | null {
  return parseLimit(raw, PLATFORM_BUDGET_DEFAULT_MAX);
}
