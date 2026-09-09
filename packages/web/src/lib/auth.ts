/**
 * auth — 本地登录态（契约 docs/PK-SPEC.md P0-1：拥有账号 + 记录本地数据）。
 *
 * 服务端 pk_users 表管账号，这里只管「这台设备记住谁」：localStorage 存
 * { userId, nickname }；启动时 App 拿 userId 过一遍 GET /api/pk/auth/me 校验，
 * 账号不存在（换库/清数据）即静默清除，回到未登录态。
 */
import type { PkIdentity } from '@sb/shared';

const KEY = 'sb_pk_auth';

export function loadLocalAuth(): { userId: string; nickname: string } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { userId?: unknown; nickname?: unknown };
    if (typeof v.userId !== 'string' || !v.userId) return null;
    return { userId: v.userId, nickname: typeof v.nickname === 'string' ? v.nickname : '' };
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}

/** 登录成功后落盘（含改名），下次启动免重登 */
export function saveLocalAuth(identity: PkIdentity): void {
  localStorage.setItem(KEY, JSON.stringify({ userId: identity.userId, nickname: identity.nickname }));
}

export function clearLocalAuth(): void {
  localStorage.removeItem(KEY);
}
