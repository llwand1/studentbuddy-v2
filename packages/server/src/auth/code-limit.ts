/**
 * auth/code-limit — 验证码**发送侧**三道限流（契约 docs/AUTH-SPEC.md §4.5）。
 *
 * | 闸门 | 阈值 | 作用域 | 挡什么 |
 * |---|---|---|---|
 * | 最小间隔 | `AUTH_CODE_RESEND_INTERVAL_MS`（60s） | **同 `用途:邮箱`** | 连点「重新发送」（每次都是一封真邮件） |
 * | 每小时封数 | `AUTH_CODE_MAX_PER_HOUR`（5） | **同邮箱（跨用途共用）** | 定向刷某个邮箱（邮件轰炸 + 烧额度） |
 * | 每小时封数 | `AUTH_CODE_MAX_PER_IP_HOUR`（20）／**`register` 用 `AUTH_CODE_MAX_PER_IP_REGISTER_HOUR`（5）** | **同 `用途:IP`** | 换邮箱刷（只按邮箱限流的话换个地址就绕过了） |
 *
 * ★★ **三个桶的作用域两两不同，都是刻意的**（M1.6，2026-09-18）——判据是**这道闸门到底在挡什么**：
 *   · **最小间隔按 `用途:邮箱`**：它挡的是「同一个动作连点」，而 `register` 与 `login` 是两个动作。
 *     共用键会掐死一条真实路径：「拿已注册邮箱点注册 → 409 → 切登录页点发送 → 429 等 60 秒」。
 *   · **每小时封数按邮箱、跨用途共用**：它挡的是「把某个邮箱的信箱炸了」，
 *     而邮件轰炸与该邮箱是为什么用途发的**无关** ⇒ 必须共用（拆开等于把骚扰上限从 5 提到 15）。
 *     ⚠️ 这一条与发信厂商免费额度**是一套账**（见 `AUTH_CODE_MAX_PER_HOUR`），拆开会让额度账失真。
 *   · **IP 桶按 `用途:IP`**：`register` 是唯一给未注册地址发信的用途，滥用面大一个量级；共用桶会让
 *     「register 被刷满」连带掐死同一出口 IP 上所有人的登录验证码。见 `IP_HOURLY_CAP`。
 *   ⚠️ 前两条**不能合并成一个数组推导**（M1.6 之前正是如此，因为当时只有一个已接线用途、
 *     这个耦合不可观测）。合并的症状是一个**静默的产品缺陷**，不会有任何测试报红。
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
  AUTH_CODE_MAX_PER_IP_REGISTER_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_WINDOW_MS,
  type AuthCodePurpose,
} from '@sb/shared';

/**
 * **IP 桶的每用途上限**。★ 为什么按用途分桶而不是共用一个桶（M1.6，契约 §2.7）：
 *   `register` 是**唯一给未注册地址发信**的用途，滥用面大一个量级，故它单独一条更严的线。
 *   若与 `login` 共用桶，则「有人拿 register 刷满」会**连带掐死同一出口 IP 上所有人的
 *   验证码登录**——共享出口（校园网 / 公司网 / 运营商 NAT）整片中招，而症状是
 *   「点了发送没反应」、服务端零错误日志。
 */
const IP_HOURLY_CAP: Record<AuthCodePurpose, number> = {
  login: AUTH_CODE_MAX_PER_IP_HOUR,
  register: AUTH_CODE_MAX_PER_IP_REGISTER_HOUR,
  // `reset` 与 `login` 同档：它只发给**已注册**邮箱（`decideSend` 对未注册走 `silent`），
  // 滥用面与 login 同级，不构成陌生地址跳板。
  reset: AUTH_CODE_MAX_PER_IP_HOUR,
};

/** 键 → 发送时刻数组（ms，升序）。两个桶分开：邮箱桶按邮箱、IP 桶按 `用途:IP`。 */
const byEmailHourly = new Map<string, number[]>();
const byIp = new Map<string, number[]>();

/**
 * 邮箱维度的**最小间隔**记录：键是 `用途:邮箱`，**按用途分开**（与 `byEmailHourly` 相反）。
 *
 * ★★ 为什么不跟 `byEmailHourly` 共用一个键（M1.6，2026-09-18）：
 *   最小间隔挡的是「**同一个动作**连点重新发送」，而 `register` 与 `login` 是**两个动作**。
 *   两者共用键的症状是一条真实的产品路径被掐死：
 *     「拿已注册邮箱点注册 → 409 `EMAIL_TAKEN`（填错邮箱，当场告知）
 *       → 切到登录页点发送验证码 → **429，等 60 秒**」
 *   —— 摩擦恰好落在用户刚受挫的那一刻，而正确行为是立刻放行。
 *   ⚠️ 这不是放开防轰炸：**每小时封数仍跨用途共用**（5 封/小时/邮箱），
 *     对单个邮箱的骚扰上限一字未变；变的只是这 5 封在小时内怎么分布
 *     （约 5 分钟摊开 → 约 1-2 分钟摊开），危害可忽略。
 */
const byEmailLastAt = new Map<string, number>();

/** IP 桶的键。★ 带用途前缀——见 `IP_HOURLY_CAP` 的注释（分桶是为了不让一个用途掐死另一个）。 */
function ipKey(purpose: AuthCodePurpose, ip: string): string {
  return `${purpose}:${ip}`;
}

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
 * **邮箱桶**的每小时封数解禁时刻（**跨用途共用**）。见 `byEmailLastAt` 的注释：
 * 防轰炸的那道闸必须共用，防连点的那道不该共用——两条规则作用域不同，故拆成两个函数。
 */
function emailHourlyUntil(sends: number[]): number {
  if (sends.length < AUTH_CODE_MAX_PER_HOUR) return 0;
  return Math.min(...sends) + AUTH_CODE_WINDOW_MS;
}

/**
 * **邮箱桶**的最小间隔解禁时刻（**按 `用途:邮箱`**）。
 * ★ 顺手清掉窗口外的陈旧条目——本仓的过期回收一律走"顺手清"（同 `recent`）。
 *   `byEmailLastAt` 的值是单个数而非数组，`recent` 用不上，故就地判一次。
 */
function emailIntervalUntil(key: string, now: number): number {
  const last = byEmailLastAt.get(key);
  if (last === undefined) return 0;
  if (now - last >= AUTH_CODE_WINDOW_MS) {
    byEmailLastAt.delete(key);
    return 0;
  }
  return now - last < AUTH_CODE_RESEND_INTERVAL_MS ? last + AUTH_CODE_RESEND_INTERVAL_MS : 0;
}

/**
 * **IP 桶**的解禁时刻：**只判每小时封数，刻意不判最小间隔**。
 *
 * ★★ 这是本模块最容易写错的一处：最小间隔是「同**邮箱**」的规则（防同一个人连点），
 *   套到 IP 桶上会变成「同一出口 IP 上所有用户合计每分钟只能发 1 封」——
 *   共享出口（校园网 / 公司网 / 运营商 NAT）与**反代未配 `trust proxy` 时的全站单 IP**
 *   都会被这条静默掐死：100 个用户抢每分钟 1 个名额，症状是「点了发送没反应」。
 *   契约 §4.5 写明间隔是"同邮箱"，此处照办、**不擅自加严**。
 * ★ `cap` 由用途决定（见 `IP_HOURLY_CAP`）——**阈值是参数、不是常量**，因为
 *   `register` 与 `login` 的滥用面不同档。
 */
function ipBlockedUntil(sends: number[], cap: number): number {
  if (sends.length < cap) return 0;
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
 *
 * ★ **`purpose` 是必传参数**（M1.6 起）：它同时决定 IP 桶的**键**与**阈值**。
 *   做成可选参数会留一个「忘传就悄悄用 login 的宽阈值」的口子，而这类口子的症状是
 *   **限流静默失效**（不会有任何测试报红）——同本模块头注对 `check()`/`record()` 的取舍。
 */
export function admitSend(
  email: string,
  ip: string,
  purpose: AuthCodePurpose,
  now: number = Date.now(),
): SendAdmission {
  const hourly = recent(byEmailHourly, email, now);
  const intervalKey = `${purpose}:${email}`;
  const key = ipKey(purpose, ip);
  const ipSends = recent(byIp, key, now);
  // ★ 三道闸取**最晚**的解禁时刻——取最早会放行一个仍被另一道挡住的请求，
  //   用户看到的是"刚说可以了又不行了"。
  const until = Math.max(
    emailIntervalUntil(intervalKey, now),
    emailHourlyUntil(hourly),
    ipBlockedUntil(ipSends, IP_HOURLY_CAP[purpose]),
  );
  if (until > 0) return { ok: false, retryAfterMs: Math.max(0, until - now) };

  hourly.push(now);
  byEmailHourly.set(email, hourly);
  byEmailLastAt.set(intervalKey, now);
  ipSends.push(now);
  byIp.set(key, ipSends);
  return { ok: true };
}

/** 清空全部计数（**仅测试用**：隔离库之间切换时避免残留封锁态，同 `resetRateLimits`）。 */
export function resetCodeLimits(): void {
  byEmailHourly.clear();
  byEmailLastAt.clear();
  byIp.clear();
}
