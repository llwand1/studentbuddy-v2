/**
 * shared/review-goal — 自定义复习目标（日目标条数 + 优先领域）的契约层。
 * 契约 `docs/EBBINGHAUS-SPEC.md` §10（2026-09-21 新建）。
 *
 * ★ 为什么放 shared：**同一个目标值前后端都要读**——前端要画达标进度、要算"还剩几条"，
 *   服务端要按它截断队列。两边各归一一次，就会出现「前端说还差 3 条、服务端说已达标」
 *   （本仓 `doc-rag.ts` 常量双写那次病同款）。故归一只有这一份。
 *
 * ★ 为什么是纯函数、不碰 IO：本仓既有约定（判定逻辑留在可单测的纯函数里，
 *   组件与路由只接线，先例 `ebbinghaus.ts` / `chat/doc-name.ts`）。
 *
 * ★ 口径三条（改码前必读）：
 *  1. **`count = 0` 是合法值，语义是「关闭自定义目标」**——队列退回只放到期（v1.1 行为）。
 *     这是本节的向后兼容承诺：**不设目标 = 什么都没变**。若把 0 当非法而回落到某个非 0
 *     默认值，所有老用户升级后队列会突然从 3 条变 30 条，而他们从没要求过。
 *  2. **`domains` 只做形状归一，不校验领域是否存在**（契约 §10.2）：领域可后建、可改名、
 *     可删除，校验会把一个纯 KV 写变成带跨表查询的写，且领域改名时会让目标配置连带失效。
 *     残留的孤儿名字**退化安全**——队列里自然没有该域的词条。
 *  3. **归一从不抛异常**：喂 `null` / 数字 / 数组 / 字符串都只回一个合法的 `ReviewGoal`。
 *     它挂在读口上（每次队列请求都跑一次），抛异常等于让整个复习面板打不开。
 */
/** 日目标条数上限。★ 比 §5 的 `REVIEW_QUEUE_MAX`(100) 宽松：目标数是**用户意图**，队列长度是实现细节 */
export const REVIEW_GOAL_MAX = 200;

/** 优先领域个数上限（实测词条库 12 个领域；给到 30 是留余量，不是鼓励） */
export const REVIEW_GOAL_DOMAINS_MAX = 30;

/** `app_settings` 里的键（M2d v30 起主键是 `(owner_id, key)`，读写都要带 ownerId） */
export const SETTING_KEY_REVIEW_GOAL = 'review_goal';

/**
 * 自定义复习目标。
 * `count = 0` ⇒ 关闭（默认值，行为与 v1.1 逐字相同）。
 */
export interface ReviewGoal {
  /** 今日目标条数 0..REVIEW_GOAL_MAX */
  count: number;
  /** 优先领域（只影响补位段排序，不影响真账段；契约 §10.4） */
  domains: string[];
}

/** 默认目标：关闭自定义目标（队列只放到期词条，即 v1.1 行为） */
export const DEFAULT_REVIEW_GOAL: ReviewGoal = { count: 0, domains: [] };

/**
 * 一份**全新的**默认目标。
 * ★ 不用 `{ ...DEFAULT_REVIEW_GOAL }`：那只浅拷贝，`domains` 数组仍与常量**共享引用**，
 *   调用方一次 `push` 就把全局默认值改了——下一个请求拿到的"默认值"里凭空多一个领域，
 *   而两次请求之间没有任何写操作。这类"常量被调用方改掉"的错，只会在并发下复现。
 */
export function freshDefaultReviewGoal(): ReviewGoal {
  return { count: 0, domains: [] };
}

/**
 * 形状归一：**唯一的**目标值入口（读写两侧共用）。
 * 非法/缺字段/类型不对一律回落，**不做猜测、不做纠正**（同 `normalizeSpeechSettings` 取向）。
 */
export function normalizeReviewGoal(raw: unknown): ReviewGoal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return freshDefaultReviewGoal();
  const o = raw as { count?: unknown; domains?: unknown };
  // ★ 非数字一律 0（＝关闭），不尝试 `Number("30")` 这类宽松转换：那是**猜测**用户意图，
  //   而猜错的方向恰好是「把关闭读成开启」，用户会莫名其妙被塞 30 条复习任务。
  const n = typeof o.count === 'number' && Number.isFinite(o.count) ? Math.trunc(o.count) : 0;
  const count = Math.min(Math.max(n, 0), REVIEW_GOAL_MAX);

  const domains: string[] = [];
  for (const item of Array.isArray(o.domains) ? o.domains : []) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || domains.includes(name)) continue;
    domains.push(name);
    if (domains.length >= REVIEW_GOAL_DOMAINS_MAX) break;
  }
  return { count, domains };
}

/** 目标是否生效（`count > 0`）。★ 前端据此决定画不画进度条，避免在多处重复写 `count > 0` */
export function reviewGoalActive(goal: ReviewGoal): boolean {
  return goal.count > 0;
}

/**
 * 今日进度（服务端队列响应里的 `doneCards` / `doneTerms` 投影成 UI 可直接用的形状）。
 * ★ `remaining` 钳在 0：超额完成时显示"-3 条"是负数噪声，不是信息。
 */
export function reviewGoalProgress(goal: ReviewGoal, doneCards: number): { done: number; target: number; remaining: number; reached: boolean } {
  const done = Math.max(Math.trunc(doneCards) || 0, 0);
  const remaining = Math.max(goal.count - done, 0);
  return { done, target: goal.count, remaining, reached: goal.count > 0 && done >= goal.count };
}
