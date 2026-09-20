/**
 * usePkIdentity — 启动时恢复 PK 登录态（B1 §14.1：身份换根到统一账号会话）。
 *
 * 改造前：localStorage 存 userId → `GET /auth/me?userId=` 自证校验（改个参数就能冒充别人）。
 * 改造后：**直接问服务端** `GET /api/pk/auth/me`（无参数）——「我是谁」由 httpOnly cookie
 * 会话裁定，JS 读不到也伪造不了；401 = 未登录（cloud 形态），local 形态服务端回兜底身份。
 *
 * 从 `PkApp` 抽出（P0-8 批，2026-09-14）：PkApp 加了投降与历史后到 **296/300 行**
 * （AGENTS「web 组件 ≤300 行」红线只余 4 行），而登录态恢复自带三态
 * （undefined 恢复中 / null 未登录 / PkIdentity 已登录）与一次异步校验，
 * 是这里最独立的一块 —— 与本仓 `useChoiceQueue` / `useSendActions` 同一手法的抽取。
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { PkIdentity } from '@sb/shared';

/** `undefined` = 正在恢复登录态；`null` = 未登录；`PkIdentity` = 已登录（含 local 兜底身份） */
export type PkIdentityState = PkIdentity | null | undefined;

export function usePkIdentity(): [PkIdentityState, (me: PkIdentity | null) => void] {
  const [identity, setIdentity] = useState<PkIdentityState>(undefined);

  useEffect(() => {
    let alive = true;
    api.pk
      .me()
      .then((me) => alive && setIdentity(me))
      .catch(() => {
        // 401（未登录）或网络失败：都如实落「未登录」，前端交给 PkLobby 引导去登录
        if (alive) setIdentity(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return [identity, setIdentity];
}
