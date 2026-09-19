/**
 * entry — 启动渲染分支的唯一判据（2026-09-20 本地/线上形态分叉批，契约 AUTH-SPEC §2.9）。
 *
 * ★ 分叉口径（2026-09-20 老板拍板）：
 * · 已登录 → 应用壳（cloud 与 local 一致——本地也允许登录，只是**不强制**）；
 * · 未登录 + `local` 本地单人形态 → **免登录直接进应用壳**（后端 `ownerIdOf → null`
 *   的单人模式语义早已有之，本批补的是前端不再拿落地页拦截）；
 * · 未登录 + `cloud` 线上形态 → 落地页（介绍 → 注册/登录，产品门面）。
 * ★ 抽成纯函数而不写在 main.tsx 里：四个组合各是一条产品口径，配回归锁——
 *   将来加「本地专属功能」的入口判断时，这里是被引用的事实源，不是重新发明。
 */
import type { AuthUser, DeployForm } from '@sb/shared';

export type EntryView = 'app' | 'landing';

export function entryFor(user: AuthUser | null, form: DeployForm): EntryView {
  if (user) return 'app';
  return form === 'local' ? 'app' : 'landing';
}
