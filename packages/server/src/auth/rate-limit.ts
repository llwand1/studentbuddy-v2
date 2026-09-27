/**
 * auth/rate-limit — 登录失败限流（防撞库；契约 docs/AUTH-SPEC.md §4.4）。
 *
 * 规则：同一邮箱在 `AUTH_LOGIN_WINDOW_MS`（15 分钟）内失败达 `AUTH_MAX_LOGIN_FAILURES`（5 次）
 * 即锁定 → 路由回 `429 TOO_MANY_ATTEMPTS`；窗口内登录成功即清零。
 *
 * ★ 按**邮箱**计数而非 IP：撞库的目标是某个账号，按账号锁最直接；且本仓单机、
 *   `x-forwarded-for` 尚未纳入信任链，按 IP 反而易被伪造头绕过。
 * ⚠️ 本版是**进程内内存计数**（重启清零，且不跨多实例）——够挡「在线暴力试」，
 *   挡不住分布式慢速撞库；后者需外部存储（列 AUTH-SPEC §6 已知缺口）。
 */
import { AUTH_LOGIN_WINDOW_MS, AUTH_MAX_LOGIN_FAILURES } from '@sb/shared';

/** key（归一化邮箱）→ 失败时刻数组（ms）。惰性清理：每次读写时剔除窗口外的旧记录。 */
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const arr = (failures.get(key) ?? []).filter((t) => now - t < AUTH_LOGIN_WINDOW_MS);
  if (arr.length === 0) failures.delete(key);
  else if (arr.length !== (failures.get(key)?.length ?? 0)) failures.set(key, arr);
  return arr;
}

/** 该账号当前是否已被锁定（失败数达上限）。 */
export function isLocked(key: string, now = Date.now()): boolean {
  return recent(key, now).length >= AUTH_MAX_LOGIN_FAILURES;
}

/** 记一次失败（登录密码错/账号不存在时调用）。 */
export function recordFailure(key: string, now = Date.now()): void {
  const arr = recent(key, now);
  arr.push(now);
  failures.set(key, arr);
}

/** 登录成功后清零该账号的失败计数。 */
export function clearFailures(key: string): void {
  failures.delete(key);
}

/** 清空全部计数（**仅测试用**：隔离库之间切换时避免残留锁定态）。 */
export function resetRateLimits(): void {
  failures.clear();
}
