/**
 * pk/auth — PK 身份适配（契约 docs/PK-SPEC.md §14.1，B1 2026-09-20）。
 *
 * ★ 本文件**已不再管账号**。改造前它是 PK 自建的一套账号体系（`pk_users` 表 + 昵称登录 +
 *   `openid = mock_<id>`），身份由**客户端自证**（前端存 localStorage 的 userId、逐端点回传）。
 *   单机 demo 无害，一上公网就是「改一个参数就能冒充别人」（§14.1 原话）。
 *   B1 起 PK 身份并入统一账号（`AUTH-SPEC`）——「我是谁」由服务端 httpOnly cookie 会话说了算，
 *   `req.authUser` 由 `attachUser` 在 `/api` 上无条件挂载（`index.ts:101`）。
 * ★ 所以这里只剩**两个纯函数**：`AuthUser → PkIdentity` 的折算、以及 local 形态的兜底身份。
 *   任何「校验昵称 / 建号 / 查库」的逻辑都属于 `auth/`，不该在这里长回来。
 *
 * ★ `pk_users` 表**保留不删**（§14.1）：存量 `pk_matches.user_id` 指向它，删表会让历史战绩
 *   变成悬空引用。本文件已不再读写它。
 * ⚠️ 历史战绩的归属断层（诚实记账，同 §14.1）：`pk_matches` 里的老行其 `user_id` 是
 *   `pk_users.id`，而新身份是 `users.id` ⇒ **同一自然人在库里是两个 id**，
 *   老战绩在新账号下查不到（等于归档）。本批**不做自动认领**（隐式认领在并发下归属不确定、
 *   且无法撤销）；要保留走显式认领脚本（照 `_probe/claim-legacy.mjs` 的手法）。
 */
import type { Request } from 'express';
import { PK_LOCAL_IDENTITY, type AuthUser, type PkIdentity } from '@sb/shared';
import { deployForm } from '../auth/form.js';
import type { AuthedRequest } from '../auth/middleware.js';

/** `AuthUser`（统一账号）→ `PkIdentity`（PK 侧身份）。字段少且语义直白，不再套一层抽象。 */
export function toPkIdentity(user: AuthUser): PkIdentity {
  return { userId: user.id, nickname: user.nickname };
}

/**
 * 取本次请求的 PK 身份：**会话优先，local 形态兜底**。
 *
 * 判定顺序（不可换）：
 * ① 有有效会话 → 用它（线上唯一的正常路径）；
 * ② 无会话且形态为 `local` → `PK_LOCAL_IDENTITY`（本地免登录，与 `ownerIdOf → null` 同一取向）；
 * ③ 其余 → `null`，由调用方转 401。
 *
 * ★ 为什么不直接用 `requireAuth`：那个中间件要求「恒定有会话」，会把本地免登录形态一起挡掉
 *   （`AUTH-SPEC §2.9` 明写本地未登录该能进应用壳）。cloud 形态下 `requireAuth` 其实已在路由
 *   之前拦过一道（`/api/pk` 不在豁免清单里），这里的 ③ 是**第二道**——两道都留着是刻意的：
 *   路由单测常绕过全局中间件直接打路由，只靠第一道＝测不出来。
 */
export function pkIdentityOf(req: Request): PkIdentity | null {
  const user = (req as AuthedRequest).authUser;
  if (user) return toPkIdentity(user);
  return deployForm() === 'local' ? PK_LOCAL_IDENTITY : null;
}
