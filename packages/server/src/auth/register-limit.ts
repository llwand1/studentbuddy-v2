/**
 * auth/register-limit — 注册端点的**按 IP 计数**（契约 docs/AUTH-SPEC.md §2.7，2026-09-22 免验证码批）。
 *
 * ★ 这个模块存在的全部理由是**一次摘除**：注册原本是「先输邮箱验证码」，而那三道发码闸
 *   （60s 间隔 / 5 封/小时/邮箱 / 5 封/小时/IP）**就是**注册唯一的限流——脚本刷不动，
 *   因为每试一次都要先烧一封真邮件。把码摘掉而不补这里，`POST /api/auth/register`
 *   立刻变成一台**公开无限建号机**。
 * ★ 为什么必须补、不能"先看看有没有人刷"：代价不对称。每个新账号都自带一份平台配额
 *   （v39 `platform_usage`，250 次/5h 走**平台 key**）⇒ 一个脚本就能把我方免费 AI 额度
 *   整池烧干，而症状出现在**真人**那边（收到「繁忙，请稍后再试」），服务端还没有任何错误日志。
 *   等看见证据再限，被烧掉的额度与已经流失的用户都回不来。
 *
 * ★ 阈值 5/小时/IP 沿用 `AUTH_CODE_MAX_PER_IP_REGISTER_HOUR` 的同一档判断：
 *   **正常人一小时不会注册 5 次**，而脚本会。
 * ⚠️ 与那道闸相同的已知代价，一字不藏：按**出口 IP** 计数 ⇒ 校园网 / 宿舍网 / 运营商 NAT
 *   共用出口时会误伤（同一间教室第 6 个注册的人收到 429）。项目主用户群恰好在校园网里，
 *   若这成为高频反馈，处置方向是**摘掉 IP 维、改按邮箱 + 全局日额度**（同 §2.7 的旧注）。
 * ⚠️ **进程内内存计数**（同 `rate-limit.ts` / `code-limit.ts` / `demo.ts`）：重启归零、不跨实例。
 *   挡得住"在线脚本连刷"，挡不住"分布式慢刷"——后者要外部存储，属 SPEC §6 已知缺口的同一篇文章。
 * ★ 与 `admitSend` 同形：**准入，不是记账**（查过才计数，被拒不延长封锁，否则越刷越封）。
 */
import { AUTH_CODE_WINDOW_MS, AUTH_REGISTER_MAX_PER_IP_HOUR } from '@sb/shared';

/** IP → 本窗口内的注册尝试时刻（ms，升序）。 */
const byIp = new Map<string, number[]>();

/** 惰性清理：剔除窗口外的旧记录。★ 本仓的过期回收一律走"顺手清"，不另起后台定时器。 */
function recent(ip: string, now: number): number[] {
  const arr = (byIp.get(ip) ?? []).filter((t) => now - t < AUTH_CODE_WINDOW_MS);
  if (arr.length === 0) byIp.delete(ip);
  else byIp.set(ip, arr);
  return arr;
}

export type RegisterAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * 申请一次注册额度。★ `ip` 为空串也照样计数（落进同一个键）——**宁可误伤，不要放行**：
 * 拿不到 IP 恰恰是最需要限流的场景（同 `code-limit.ts#admitSend` 的取舍）。
 */
export function admitRegister(ip: string, now: number = Date.now()): RegisterAdmission {
  const tries = recent(ip, now);
  const first = tries[0];
  if (first !== undefined && tries.length >= AUTH_REGISTER_MAX_PER_IP_HOUR) {
    return { ok: false, retryAfterMs: first + AUTH_CODE_WINDOW_MS - now };
  }
  tries.push(now);
  byIp.set(ip, tries);
  return { ok: true };
}

/** 清空计数（**仅测试用**：隔离库之间切换时避免残留封锁态，同 `resetCodeLimits`）。 */
export function resetRegisterLimits(): void {
  byIp.clear();
}
