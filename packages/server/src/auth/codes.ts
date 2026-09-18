/**
 * auth/codes — 邮箱验证码的签发与核销（契约 docs/AUTH-SPEC.md §1 `auth_codes` / §4.5）。
 *
 * 职责边界：**只碰表与 crypto，不碰 HTTP、不发邮件**（发信在 `mail/`、编排在 `auth/code-flow.ts`）。
 * 域层不碰 HTTP 是同 `auth/users.ts` 的手法：失败抛 `AuthError` 码，由薄路由映射状态码。
 *
 * ★★ 本文件最要紧的两条设计，都不是"顺手"能对的：
 *
 * ① **码只以明文存在一瞬间**。`issueCode` 是唯一产出明文的出口（返回给调用方去发信），
 *    库里此后只有 `SHA-256`。同 `auth/session.ts` 的 token 手法——**拖库拿不到可用的码**。
 *    ⚠️ 但必须清醒：6 位数字只有 10^6 空间，**哈希对"在线爆破"零作用**（攻击者不需要还原哈希，
 *    他只要猜一个数再走一次校验即可）。真正的防线是下面第 ② 条与发送侧限流。
 *
 * ② **作废与消费都是「原子认领」，不是「先查后写」**。校验成功时写
 *    `UPDATE … SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`，并**以 `changes`
 *    为唯一判据**——0 行改动即"这一条已被别人消费"，回 `CODE_INVALID`。
 *    先 `SELECT` 再 `UPDATE` 会在并发下让**同一个码被用两次**（两个请求都读到未消费、
 *    都写成功），而这是一次性的东西，双花就是双登。
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  AUTH_CODE_LEN,
  AUTH_CODE_MAX_ATTEMPTS,
  AUTH_CODE_TTL_MS,
  formatCode,
  normalizeCode,
  normalizeEmail,
  normalizePurpose,
  type AuthCodePurpose,
  type AuthError,
} from '@sb/shared';
import { getDb } from '../storage/db.js';

interface CodeRow {
  id: number;
  code_hash: string;
  expires_at: number;
  attempts: number;
}

/** 码 → 库内哈希。单独导出供测试断言「库里存的确实不是明文」。 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * 生成 6 位码。★ **`crypto.randomInt`，绝不用 `Math.random()`**——
 * 后者是可预测的 PRNG（V8 的 xorshift128+，拿到几个输出即可推出内部状态），
 * 攻击者收集几条自己的码就能算出**别人**的码。
 */
export function genCode(): string {
  return formatCode(randomInt(0, 10 ** AUTH_CODE_LEN));
}

/**
 * 作废同 `(email, purpose)` 下所有未消费的码。**发新码时必调**。
 * ★ 不这么做的话，用户连点两次「重新发送」会得到**两个都能用的码**——攻击面直接翻倍，
 *   且用户自己也不知道该用哪个（旧邮件还在收件箱里）。
 * ★ 用 `consumed_at` 标记而不是 `DELETE`：留着才能回答「这个邮箱发过几次码、何时被换掉」，
 *   而这类审计信息**删了就再也回不来**（同 v23 `term_review_log` 只追加的口径）。
 */
function invalidatePending(email: string, purpose: AuthCodePurpose, now: number): number {
  return getDb()
    .prepare(`UPDATE auth_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL`)
    .run(now, email, purpose).changes;
}

/** 取该邮箱该用途**最新一条未消费**的码行；没有回 `null`。 */
function latestPending(email: string, purpose: AuthCodePurpose): CodeRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, code_hash, expires_at, attempts FROM auth_codes
          WHERE email = ? AND purpose = ? AND consumed_at IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(email, purpose) as CodeRow | undefined) ?? null
  );
}

/**
 * 签发一条验证码：作废旧码 → 落新行 → 返回**明文**（唯一出口）。
 *
 * 抛 `EMAIL_INVALID` / `PURPOSE_INVALID`。
 * ★ 本函数**不做限流**——限流是"能不能发"的准入判断，属编排层（`auth/code-flow.ts`）。
 *   把两者混在一起，就会出现"限流没过但码已经作废了"的中间态（用户手里的旧码被白白作废）。
 */
export function issueCode(
  rawEmail: unknown,
  rawPurpose: unknown,
  now: number = Date.now(),
  ttlMs: number = AUTH_CODE_TTL_MS,
): { email: string; purpose: AuthCodePurpose; code: string; expiresInMs: number } {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('EMAIL_INVALID' satisfies AuthError);
  const purpose = normalizePurpose(rawPurpose);
  if (!purpose) throw new Error('PURPOSE_INVALID' satisfies AuthError);

  invalidatePending(email, purpose, now);
  const code = genCode();
  getDb()
    .prepare(`INSERT INTO auth_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, ?, ?)`)
    .run(email, hashCode(code), purpose, now + ttlMs);
  return { email, purpose, code, expiresInMs: ttlMs };
}

/**
 * 核销一条验证码。**成功即消费**（一次性）；失败抛 `AuthError`。
 *
 * 抛 `EMAIL_INVALID` / `PURPOSE_INVALID` / `CODE_INVALID` / `CODE_EXPIRED`。
 * ★ 调用方**必须在拿到 `user` 之后**才把码当作已用——本函数只管"码对不对"，
 *   不管"这个人存不存在"（登录态下账号不存在是 `CREDENTIALS_INVALID`，由编排层判）。
 *   ⚠️ 于是有一处**刻意的取舍**：`purpose: 'login'` 且账号不存在时，码**已被消费**，
 *   用户重试同一个码会得到 `CODE_INVALID`。这是对的——**码是一次性凭据，验证通过就该失效**；
 *   若为"账号不存在"保留码，等于给枚举账号留了一个可重复试探的口子。
 */
export function consumeCode(
  rawEmail: unknown,
  rawPurpose: unknown,
  rawCode: unknown,
  now: number = Date.now(),
): { email: string; purpose: AuthCodePurpose } {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('EMAIL_INVALID' satisfies AuthError);
  const purpose = normalizePurpose(rawPurpose);
  if (!purpose) throw new Error('PURPOSE_INVALID' satisfies AuthError);
  const code = normalizeCode(rawCode);
  // 格式不对直接拒，**不消耗尝试次数**：它不是"猜错了一次"，是"根本没在猜"
  // （否则一个手滑多打一位就能把用户的码打废）。
  if (!code) throw new Error('CODE_INVALID' satisfies AuthError);

  const row = latestPending(email, purpose);
  // 没有待消费的码：没发过 / 已用过 / 已被新码作废 —— 三种都回同一个码，
  // 分开会告诉调用方「这个邮箱刚发过码」或「这条码存在但已用」（同 CREDENTIALS_INVALID 的取向）。
  if (!row) throw new Error('CODE_INVALID' satisfies AuthError);
  if (row.expires_at <= now) throw new Error('CODE_EXPIRED' satisfies AuthError);
  // 尝试次数耗尽 ⇒ 该码已作废（**不靠过期兜底**）。这条必须排在比对之前：
  // 排在后面的话，攻击者每次试错都先跑一次比对，"耗尽"只是晚一点发生而已。
  if (row.attempts >= AUTH_CODE_MAX_ATTEMPTS) throw new Error('CODE_INVALID' satisfies AuthError);

  if (!matches(code, row.code_hash)) {
    getDb().prepare(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
    throw new Error('CODE_INVALID' satisfies AuthError);
  }

  // ★ 原子认领：`consumed_at IS NULL` 写进 WHERE，以 changes 判胜负。
  //   两个并发请求都通过上面所有检查时，只有一个能改到行，另一个回 CODE_INVALID。
  if (!claimCode(row.id, now)) throw new Error('CODE_INVALID' satisfies AuthError);
  return { email, purpose };
}

/**
 * **原子认领**一条码（消费它）。`true` = 本次调用抢到了，`false` = 已被消费过。
 *
 * ★ 单独导出而非内联，是为了**能被直接测**：这是"一次性"语义的唯一实现点，
 *   而它的正确性完全落在 `AND consumed_at IS NULL` 这一个条件上——内联在
 *   `consumeCode` 里时，那条分支在单进程同步流程中**永远走不到**（先查后改之间没有缝隙），
 *   于是"有人把 WHERE 条件删了"不会有任何测试报红。
 */
export function claimCode(id: number, now: number = Date.now()): boolean {
  return getDb().prepare(`UPDATE auth_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(now, id).changes === 1;
}

/**
 * 定长比较。★ 先比长度再 `timingSafeEqual`——长度不等时它会**抛异常**
 * （一个脏哈希行不该把端点打成 500）。长度本身不是秘密（恒为 32 字节十六进制）。
 */
function matches(code: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * 清理已过期且未被消费的码（启动时调一次，同 `purgeExpiredSessions` 的逃生口手法）。
 * ★ 只删"过期且未消费"的：**已消费的行留着**（审计），它们不是垃圾。
 */
export function purgeExpiredCodes(now: number = Date.now()): number {
  return getDb().prepare(`DELETE FROM auth_codes WHERE expires_at <= ? AND consumed_at IS NULL`).run(now).changes;
}
