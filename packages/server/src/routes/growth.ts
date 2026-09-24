/**
 * routes/growth — 诚实计数的**只读**出口（渠道台账 C4，契约 `docs/GROWTH-SPEC.md` §3）。
 *
 * `GET /api/growth/counters`：公开、无 cookie 也能读，返回三种真实动作的「IP·天」数与它们的口径。
 *
 * ★ 为什么公开（老板 2026-09-23 拍板「公开 GET ＋限流」而不是挂 `requireAuth`）：
 *   这批数**将来就是要给未登录访客看的**（落地页），先把接口按公开口径定型——限流、响应形状、
 *   「0 就返回 0」这三件事如果等显示批再补，就是拿一个已经上线的接口做二次改动。
 *   ★ 本批**页面什么都不画**：真实数为 0 的显示是噪音，判据留给有数之后（GROWTH-SPEC §3）。
 * ⚠️ 公开的代价如实写：任何人都能读到这三个整数。它们**不含 IP、不含邮箱、不含任何个体痕迹**
 *   （表里只有哈希桶），所以暴露面是「有多少人来过」，不是「谁来过」。
 * ★ 与强制登录开关的关系：`isAuthProtected` 的豁免白名单里加了这个路径——
 *   豁免清单是「必须公开」的名单，加一行是一个**决策**，不是配置细节（见 `index.ts` 行内注）。
 */
import { Router, type Request, type Response } from 'express';
import { readGrowthSnapshot, type GrowthSourceRow } from '../growth/counters.js';

/** 与 demo-login／发码同档（`DEMO_LOGIN_MAX_PER_IP_HOUR=20`）——同类的公开读端点用同一把尺。 */
export const GROWTH_MAX_PER_IP_HOUR = 20;
const WINDOW_MS = 3_600_000;

/** 进程内计数，重启清零（同 §4.4 的已知边界，不另起话）。★ 只对**读**限流：这个端点不写库，被刷也只刷 CPU。 */
const attempts = new Map<string, number[]>();

/** 测试用：内存桶跨用例会串，`beforeEach` 清一次（同 `resetDemoLoginLimits` 的理由）。 */
export function resetGrowthRateLimits(): void {
  attempts.clear();
}

function rateLimited(ip: string, now: number): number | null {
  const kept = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= GROWTH_MAX_PER_IP_HOUR) {
    attempts.set(ip, kept);
    const oldest = kept[0] ?? now;
    return oldest + WINDOW_MS - now;
  }
  kept.push(now);
  attempts.set(ip, kept);
  return null;
}

export interface GrowthCountersResponse {
  counts: { app_open: number; demo_enter: number; register_done: number };
  /**
   * 同一个答案的「按渠道」那一面（契约 §2.5／§3）。★ 每个渠道名的三动作之和与 `counts` 逐项相等——
   * 这条不是注释里的承诺，`routes/growth.test.ts` 与 `counters.test.ts` 各锁一遍（§5 第 7 条）。
   * ⚠️ `source: 'direct'` 那一行**含第三方抓取器**（台账 §3 最后那行的裁定：本批不换采集点，
   * 先用这份分解取证），所以对外引用它要带这句前缀。
   */
  bySource: GrowthSourceRow[];
  unit: string;
  unitLabel: string;
  firstDay: string | null;
}

export const growthRouter = Router();

growthRouter.get('/counters', (req: Request, res: Response) => {
  const retryAfterMs = rateLimited(req.ip ?? '', Date.now());
  if (retryAfterMs !== null) {
    res.status(429).json({
      error: '查询过于频繁，请稍后再试',
      code: 'GROWTH_RATE_LIMITED',
      retryAfterMs,
    });
    return;
  }
  res.json(readGrowthSnapshot() satisfies GrowthCountersResponse);
});
