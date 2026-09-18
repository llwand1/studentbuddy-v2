/**
 * auth/code-limit — 验证码**发送侧**三道限流（契约 docs/AUTH-SPEC.md §4.5）。
 *
 * | 闸门 | 阈值 | 作用域 | 挡什么 |
 * |---|---|---|---|
 * | 最小间隔 | `AUTH_CODE_RESEND_INTERVAL_MS`（60s） | **仅同邮箱** | 连点「重新发送」（每次都是一封真邮件） |
 * | 每小时封数 | `AUTH_CODE_MAX_PER_HOUR`（5） | **仅同邮箱** | 定向刷某个邮箱（邮件轰炸 + 烧额度） |
 * | 每小时封数 | `AUTH_CODE_MAX_PER_IP_HOUR`（20） | 同 IP | 换邮箱刷（只按邮箱限流的话换个地址就绕过了） |
 *
 * ★★ **最小间隔只作用于邮箱桶、不作用于 IP 桶**——这是本模块最容易写错的一处，
 *   写错的症状是"共享出口 IP 的用户全部发不出码"（详见 `ipBlockedUntil` 的注释）。
 *
 * ★★ **准入，不是记账**：只暴露一个 `admitSend`——查完三道闸门，**全过才记账**。
 *   拆成 `check()` + `record()` 两个函数看着更灵活，实际会给"查了忘记"和"记了没查"
 *   两种错各留一个口子，而这类口子的症状是**限流静默失效**（不会有任何测试报红）。
 *
 * ★ **不区分是哪一道闸门命中**：一律回 `CODE_RATE_LIMITED`。区分的话，"这个邮箱刚发过"
 *   就成了一个可查询的信号（同 §2.5 对用户枚举的处置）；`retryAfterMs` 只回时间、不回原因。
 *
 * ⚠️ **进程内内存计数**（同 §4.4 登录限流）：重启归零，多实例各算各的。
 *   ⇒ 挡得住"脚本在线刷"，挡不住"卡着重启窗口刷"或"多实例分摊刷"。
 *   **已知局限，本批不修**（要修得上外部存储，属 M2 之后的活，见 §4.5 末条）。
 */
import {
  AUTH_CODE_MAX_PER_HOUR,
  AUTH_CODE_MAX_PER_IP_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_WINDOW_MS,
} from '@sb/shared';

/** 键 → 发送时刻数组（ms，升序）。两个桶分开：邮箱桶按邮箱、IP 桶按 IP。 */
const byEmail = new Map<string, number[]>();
const byIp = new Map<string, number[]>();

/** 该次准入是否放行。不放行时给 `retryAfterMs`（**只回时间，不回是哪道闸门**）。 */
export type SendAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * 惰性清理：剔除窗口外的旧记录。**不另起定时器**——本仓的过期回收一律走"顺手清"
 * （同 `verifySession` 删过期会话行、`sweepExpired` 收房间），少一个后台任务是少一类故障。
 */
function recent(map: Map<string, number[]>, key: string, now: number): number[] {
  const arr = (map.get(key) ?? []).filter((t) => now - t < AUTH_CODE_WINDOW_MS);
  if (arr.length === 0) map.delete(key);
  else map.set(key, arr);
  return arr;
}

/**
 * **邮箱桶**的解禁时刻：两道闸一起判（最小间隔 + 每小时封数）。
 * ★ 返回可能有多道命中，取**最晚**——取最早会放行一个仍被另一道挡住的请求，
 *   用户看到的是"刚说可以了又不行了"。
 */
function emailBlockedUntil(sends: number[], now: number): number | null {
  const marks: number[] = [];
  const last = sends.length > 0 ? Math.max(...sends) : null;
  if (last !== null && now - last < AUTH_CODE_RESEND_INTERVAL_MS) {
    marks.push(last + AUTH_CODE_RESEND_INTERVAL_MS);
  }
  if (sends.length >= AUTH_CODE_MAX_PER_HOUR) marks.push(Math.min(...sends) + AUTH_CODE_WINDOW_MS);
  return marks.length === 0 ? null : Math.max(...marks);
}

/**
 * **IP 桶**的解禁时刻：**只判每小时封数，刻意不判最小间隔**。
 *
 * ★★ 这是本模块最容易写错的一处：最小间隔是「同**邮箱**」的规则（防同一个人连点），
 *   套到 IP 桶上会变成「同一出口 IP 上所有用户合计每分钟只能发 1 封」——
 *   共享出口（校园网 / 公司网 / 运营商 NAT）与**反代未配 `trust proxy` 时的全站单 IP**
 *   都会被这条静默掐死：100 个用户抢每分钟 1 个名额，症状是「点了发送没反应」。
 *   契约 §4.5 写明间隔是"同邮箱"，此处照办、**不擅自加严**。
 */
function ipBlockedUntil(sends: number[]): number | null {
  if (sends.length < AUTH_CODE_MAX_PER_IP_HOUR) return null;
  return Math.min(...sends) + AUTH_CODE_WINDOW_MS;
}

/**
 * 申请一次发码额度。**全过才记账**——被拒的请求不会延长封锁（否则越刷越封，正常用户
 * 一小时内永远等不到窗口滑出）。
 *
 * ★ `ip` 传空串也照样走 IP 桶（落在同一个键上）——**宁可误伤，不要放行**：
 *   放行意味着三道闸门只剩两道，而"IP 拿不到"恰恰是最需要限流的场景。
 *   ⚠️ 反过来说：`req.ip` 在**反代后且未配 `trust proxy`** 时恒为反代自身地址
 *   ⇒ 全站共用一个 IP 桶 ⇒ 20 封/小时**静默退化成全站上限**。这是部署问题不是本模块的问题，
 *   处置见 `auth/code-flow.ts#clientIp` 与 SPEC §7 的 M3 注意事项。
 */
export function admitSend(email: string, ip: string, now: number = Date.now()): SendAdmission {
  const emailSends = recent(byEmail, email, now);
  const ipSends = recent(byIp, ip, now);
  const until = Math.max(emailBlockedUntil(emailSends, now) ?? 0, ipBlockedUntil(ipSends) ?? 0);
  if (until > 0) return { ok: false, retryAfterMs: Math.max(0, until - now) };

  emailSends.push(now);
  ipSends.push(now);
  byEmail.set(email, emailSends);
  byIp.set(ip, ipSends);
  return { ok: true };
}

/** 清空全部计数（**仅测试用**：隔离库之间切换时避免残留封锁态，同 `resetRateLimits`）。 */
export function resetCodeLimits(): void {
  byEmail.clear();
  byIp.clear();
}
