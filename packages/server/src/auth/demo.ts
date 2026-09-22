/**
 * auth/demo — 公用体验账号域逻辑（契约 docs/AUTH-SPEC.md §2.10）。
 *
 * 定位：第四条登录通道——**零凭证**，点一下就进（产出与前几条完全相同的会话，路由层
 * 复用同一个 `createSession` + cookie，会话与归属逻辑零分支）。开关 `SB_DEMO_LOGIN=1`
 * 只在生产配置；本地/未配置时 `demoLoginEnabled()` 恒 false，端点 404、前端不画入口。
 *
 * ★★ 三条容易做错、后果最重的点：
 *   ① **查号只按固定 `DEMO_USER_ID`**——所有访客必须汇到**同一行**；退化成每次新建
 *     就是「每个访客一个空账号」，公用池的意义（前人的演示内容可见）静默消失。
 *   ② **密码登录对它必须永不可用**——`password_hash` 写两次 randomUUID 的 scrypt 哈希
 *     （与 GitHub 建号同手法），列是 NOT NULL 而口令不可知。
 *   ③ **零凭证端点必须按 IP 限流**——它就是公开的会话发放机，不限流等于把平台
 *     免费 AI 额度挂到公域流量上烧（决策 2026-09-22：沿用现有配额，不另设日预算）。
 *
 * ⚠️ 公用池 = 访客彼此可见（老板拍板「共享池原样 + 页面明示」），防误伤靠前端文案，
 *   不靠数据层；体验账号与普通账号在数据模型上**没有任何特殊化**。
 * ★ 惰性建号（刻意不走迁移）：本地安装包版永远不该有这行，且开关未开时零足迹。
 */
import { randomUUID } from 'node:crypto';
import {
  DEMO_LOGIN_MAX_PER_IP_HOUR,
  DEMO_LOGIN_WINDOW_MS,
  DEMO_USER_EMAIL,
  DEMO_USER_ID,
  DEMO_USER_NICKNAME,
  type AuthError,
  type AuthUser,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { hashPassword } from './password.js';
import { rowToAuthUser, type UserRow } from './user-row.js';

/** 体验入口是否开放（调用时读，与 `githubConfigured()` 同口径——测试可控、改 env 重启即变）。 */
export function demoLoginEnabled(): boolean {
  return process.env.SB_DEMO_LOGIN === '1';
}

/**
 * IP → 本窗口内的进入时刻（ms）。进程内计数（同 `rate-limit.ts` 的已知边界：
 * 重启清零、不跨实例——单机部署成立，多实例是 SPEC §6 已知缺口的同一篇文章）。
 */
const attempts = new Map<string, number[]>();

function tooMany(ip: string, now: number): boolean {
  const kept = (attempts.get(ip) ?? []).filter((t) => now - t < DEMO_LOGIN_WINDOW_MS);
  if (kept.length === 0) attempts.delete(ip);
  else attempts.set(ip, kept);
  return kept.length >= DEMO_LOGIN_MAX_PER_IP_HOUR;
}

/** 清空限流计数（**仅测试用**，同 `resetRateLimits` 的存在理由）。 */
export function resetDemoLoginLimits(): void {
  attempts.clear();
}

function findDemoRow(): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE id = ?').get(DEMO_USER_ID) as UserRow | undefined) ?? null;
}

/**
 * 确保体验账号存在（幂等），返回库行。
 * ★ 并发窗口由 `users.email` 的 UNIQUE 兜底：撞了就回读既有行按**同一账号**处理
 *   （与 `github.ts` 的 `loginViaGithub` 竞态分支同一手法）。
 */
async function ensureDemoUser(): Promise<UserRow> {
  const existing = findDemoRow();
  if (existing) return existing;
  const passwordHash = await hashPassword(`${randomUUID()}${randomUUID()}`);
  try {
    getDb()
      .prepare('INSERT INTO users (id, email, password_hash, nickname) VALUES (?, ?, ?, ?)')
      .run(DEMO_USER_ID, DEMO_USER_EMAIL, passwordHash, DEMO_USER_NICKNAME);
  } catch (e) {
    if (!(e instanceof Error && /UNIQUE/i.test(e.message))) throw e;
  }
  const row = findDemoRow();
  if (!row) throw new Error('USER_ROW_MISSING');
  return row;
}

/**
 * 体验登录：限流 → 建/取固定账号 → 返回契约用户（路由层据此发会话）。
 * 失败抛 `TOO_MANY_ATTEMPTS`（429 与既有文案复用），由薄路由映射。
 */
export async function demoLogin(ip: string): Promise<AuthUser> {
  const now = Date.now();
  if (tooMany(ip, now)) throw new Error('TOO_MANY_ATTEMPTS' satisfies AuthError);
  const kept = attempts.get(ip) ?? [];
  kept.push(now);
  attempts.set(ip, kept);
  return rowToAuthUser(await ensureDemoUser());
}
