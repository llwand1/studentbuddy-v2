/**
 * auth/code-flow — 验证码两个端点的用例编排（契约 docs/AUTH-SPEC.md §2.5）。
 *
 * 分层的理由：`auth/codes.ts` 只管表与 crypto、`mail/` 只管发信，**两者都不该知道对方的策略**；
 * 「邮箱没注册时发不发信」这类判断是**用例级**的，收在这一层。
 * 本文件同样不碰 HTTP（错误一律抛 `AuthError` 码，由 `routes/auth.ts` 映射状态码）。
 *
 * ★★ 本文件最要害的一条：**`send-code` 的响应与「邮箱是否已注册」必须按 purpose 分两套，
 *    且两个方向都是刻意的**（§2.5 表）——
 *      · `login`：注册与否**一律回同一个 200**。分开就等于对外提供一个
 *        「这个邮箱注册了吗」的查询接口（用户枚举）。
 *      · `register`：已注册**刻意回 409**。用户填错邮箱要当场知道；
 *        且「注册时已存在」不构成隐私——对方本来就能通过 `register` 的 409 感知到。
 *    判据不是"一致就好"，而是「**这个信息会不会让攻击者拿到他本来拿不到的东西**」。
 *    这张表**抽成纯函数 `decideSend`**：它有三个分支、其中两条今天还走不到，
 *    留在编排里就是死代码（改错了没人报红），抽出来才能逐格钉死。
 *
 * ⚠️ **一条已知的旁路（诚实记账，不在本批修）**：`login` 态「已注册」要走一次发信网络往返，
 *    「未注册」直接返回 ⇒ **响应时间可区分两者**（秒表即可枚举）。
 *    不修的理由：① 该信息**本来就能从 `register` 的 409 直接拿到**（契约自己承认这一点）；
 *    ② 修它要么牺牲「发信失败能如实告知用户」（改成 fire-and-forget），要么加人为延迟（脆弱）。
 *    若将来 `register` 的泄露策略收紧，**这条必须同批修**——两者是同一道防线的两半。
 *
 * ⚠️ **另一条已知限制**：限流按邮箱计数 ⇒ 知道受害者邮箱的人可以**替他刷满每小时的发码配额**，
 *    让他这一小时内无法用验证码登录（且连发 5 封骚扰邮件）。
 *    不修的理由：这是"按邮箱限流"这个选择的内生代价，而**密码登录不受影响**
 *    （§4.6 缓解第 5 条：双通道并存不可退让，正是为这类场景准备的）；
 *    真要修得上"按 IP × 邮箱"的第三维限流，收益与复杂度不成比例。
 */
import {
  AUTH_CODE_TTL_MS,
  normalizeEmail,
  normalizePurpose,
  type AuthCodePurpose,
  type AuthError,
  type AuthUser,
} from '@sb/shared';
import { admitSend } from './code-limit.js';
import { consumeCode, issueCode } from './codes.js';
import { findUserByEmail } from './users.js';
import { buildCodeMail, getMailSender } from '../mail/send.js';

/**
 * **已接线（存在消费端点）的用途白名单**。
 *
 * ★ 为什么需要这道闸门（两层理由，第二层更硬）：
 *   ① `AUTH-SPEC §2.5` 目前只有 `login-by-code` **一个**消费端点 ⇒ `register` / `reset`
 *      发出去的码**没有任何地方能校验**，用户收得到信却用不上，而每封都从 Resend 的
 *      3000 封/月里扣（§4.6 成本账）。
 *   ② ★★ **`register` 态会给「未注册的邮箱」发信**——这正是注册流程需要的，但它同时意味着
 *      **任何人都能拿我们的发信通道给任意陌生邮箱发邮件**（垃圾邮件/钓鱼的现成跳板，
 *      也是让发信域名被拉黑最快的方式）。`login` 态只给**已注册**邮箱发信，滥用面小得多。
 *      ⇒ 在 register 的完整链路（注册端点 + 邮箱验证）落地之前，**不开这个口子**。
 * ★ 用 `PURPOSE_INVALID`（400）而不是新造一个码：从调用方视角，"这个用途现在不能用"
 *   与"这个用途不存在"是同一件事，多一个码只会多一个前端分支。
 * ★ 端点落地时把常量加一项即可，**表结构、`purpose` 列、限流、发信全都不用改**。
 */
const WIRED_PURPOSES: readonly AuthCodePurpose[] = ['login'];

/**
 * 该用途**今天**有没有消费端点。★ 与 `decideSend` 刻意分成两件事：
 *   前者是「本批做到哪」，后者是「契约 §2.5 怎么规定」——**把两者混在一个函数里，
 *   策略表的 `register`/`reset` 两格就永远走不到，成为改错了没人报红的死分支**。
 */
export function isPurposeWired(purpose: AuthCodePurpose): boolean {
  return WIRED_PURPOSES.includes(purpose);
}

/** `send-code` 对某个 (用途, 是否已注册) 该做什么。 */
export type SendDecision =
  /** 发码 + 发信 */
  | 'send'
  /** 什么都不做，但**回与 `send` 逐字相同的响应**（不泄露账号是否存在） */
  | 'silent'
  /** 回 409 `EMAIL_TAKEN`（**刻意泄露**：用户填错邮箱要当场知道） */
  | 'taken';

/**
 * §2.5 那张表的**唯一实现**。纯函数、零 IO——因为它是本批最容易被"顺手改统一"的一处，
 * 而改错的症状是**一个静默的用户枚举漏洞**（不会有任何运行时错误）。
 *
 * | 用途 | 已注册 | 未注册 |
 * |---|---|---|
 * | `login` | `send` | `silent`（**同响应**，否则等于提供"这个邮箱注册了吗"的查询接口） |
 * | `register` | `taken` | `send` |
 * | `reset` | `send` | `silent`（与 login 同口径：找回密码也不该泄露账号是否存在） |
 */
export function decideSend(purpose: AuthCodePurpose, registered: boolean): SendDecision {
  if (purpose === 'register') return registered ? 'taken' : 'send';
  return registered ? 'send' : 'silent';
}

/** 校验入参并归一。★ 两个端点共用，避免各写一遍导致「一处 trim、一处不 trim」。 */
function parseTarget(rawEmail: unknown, rawPurpose: unknown): { email: string; purpose: AuthCodePurpose } {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('EMAIL_INVALID' satisfies AuthError);
  const purpose = normalizePurpose(rawPurpose);
  if (!purpose) throw new Error('PURPOSE_INVALID' satisfies AuthError);
  return { email, purpose };
}

/**
 * `POST /api/auth/send-code` 的用例。
 *
 * 顺序**不可换**：两道校验（格式/用途 → 是否接线）→ 限流 → 策略 → 发信。
 * ★ 校验闸在限流**之前**：脏请求（邮箱非法、用途未接线）不该占用户的名额。
 * ★ 限流记账在**注册与否之前**，这一点是刻意的：若只对"已注册"记账，则
 *   「第 6 次收到 429」本身就成了一条枚举信号（未注册的永远不 429）。
 * ★ 发信失败抛 `MAIL_SEND_FAILED`，**不让用户干等**（ADR-5：失败必须可读、可重试）。
 *   代价是"限流额度已被消耗"——失败不该给额外尝试机会，这个方向是安全的。
 */
export async function sendCode(
  rawEmail: unknown,
  rawPurpose: unknown,
  ip: string,
  now: number = Date.now(),
): Promise<{ expiresInMs: number }> {
  const { email, purpose } = parseTarget(rawEmail, rawPurpose);
  if (!isPurposeWired(purpose)) throw new Error('PURPOSE_INVALID' satisfies AuthError);

  const admission = admitSend(email, ip, now);
  if (!admission.ok) throw new Error('CODE_RATE_LIMITED' satisfies AuthError);

  const decision = decideSend(purpose, findUserByEmail(email) !== null);
  if (decision === 'taken') throw new Error('EMAIL_TAKEN' satisfies AuthError);
  // ★ `silent`：**不发信，但回一个与 `send` 逐字相同的响应**（含 `expiresInMs`）。
  //   回一个"看起来发了"的响应是刻意的——真实情况只有攻击者看不到的那一侧不同。
  if (decision === 'silent') return { expiresInMs: AUTH_CODE_TTL_MS };

  const { code } = issueCode(email, purpose, now);
  try {
    await getMailSender().send(buildCodeMail(email, code, purpose));
  } catch (e) {
    // 只记通道名与错误消息，**不记邮件正文**（里面有验证码）
    console.error('[sb-mail] 发信失败:', e instanceof Error ? e.message : e);
    throw new Error('MAIL_SEND_FAILED' satisfies AuthError);
  }
  return { expiresInMs: AUTH_CODE_TTL_MS };
}

/**
 * `POST /api/auth/login-by-code` 的用例：核销码 → 取账号。**会话由路由建**（见 `routes/auth.ts`）。
 *
 * ★ **不自动建号**（契约 §2.5）：`send-code` 在 login 态不限注册与否，自动建号会让
 *   任何人用任意邮箱凭空创建账号，且用户打错一位就多出一个空账号。
 *   账号不存在 → `CREDENTIALS_INVALID`（与密码登录同一个码，不透露"这个邮箱没注册"）。
 * ★ 码的消费**先于**账号查找：码是一次性凭据，验证通过就该失效。
 *   为"账号不存在"保留码，等于给枚举账号留了一个可重复试探的口子。
 */
export function loginByCode(rawEmail: unknown, rawCode: unknown, now: number = Date.now()): AuthUser {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('EMAIL_INVALID' satisfies AuthError);
  consumeCode(email, 'login', rawCode, now); // 失败抛 CODE_INVALID / CODE_EXPIRED
  const user = findUserByEmail(email);
  if (!user) throw new Error('CREDENTIALS_INVALID' satisfies AuthError);
  return user;
}
