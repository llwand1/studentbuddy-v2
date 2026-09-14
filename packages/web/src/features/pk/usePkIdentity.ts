/**
 * usePkIdentity — 启动时恢复 PK 登录态（localStorage → `GET /auth/me` 校验）。
 *
 * 从 `PkApp` 抽出（P0-8 批，2026-09-14）：PkApp 加了投降与历史后到 **296/300 行**
 * （AGENTS「web 组件 ≤300 行」红线只余 4 行），而登录态恢复自带三态
 * （undefined 恢复中 / null 未登录 / PkIdentity 已登录）与一次异步校验，
 * 是这里最独立的一块 —— 与本仓 `useChoiceQueue` / `useSendActions` 同一手法的抽取。
 *
 * ★ 行为零改动：判定顺序保持原样 —— 本地没记 userId 直接落 null（不发请求）；
 *   记了就过一遍 `/auth/me`，**账号已不存在则静默清除本地记录**（库被清过 / 换了数据目录
 *   都会走到这一步，不清就永远卡在「正在恢复登录态」）。
 */
import { useEffect, useState } from 'react';
import type { PkIdentity } from '@sb/shared';
import { api } from '../../lib/api';
import { clearLocalAuth, loadLocalAuth } from '../../lib/auth';

/** `undefined` = 正在恢复登录态；`null` = 未登录；`PkIdentity` = 已登录 */
export type PkIdentityState = PkIdentity | null | undefined;

export function usePkIdentity(): [PkIdentityState, (me: PkIdentity | null) => void] {
  const [identity, setIdentity] = useState<PkIdentityState>(undefined);

  useEffect(() => {
    const local = loadLocalAuth();
    if (!local) {
      setIdentity(null);
      return;
    }
    let alive = true;
    api.pk
      .me(local.userId)
      .then((me) => alive && setIdentity(me))
      .catch(() => {
        clearLocalAuth();
        if (alive) setIdentity(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return [identity, setIdentity];
}
