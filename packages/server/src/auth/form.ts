/**
 * auth/form — 部署形态单一事实源（2026-09-20 本地/线上形态分叉批，契约 AUTH-SPEC §2.9）。
 *
 * ★ 为什么单列一个模块：`SB_REQUIRE_AUTH` 原先只在 `index.ts` 启动时读一次算出
 *   `REQUIRE_AUTH` 常量，路由层想知道形态就得反向 import index（循环依赖）或自己
 *   再读一遍 env（**两个事实源**——env 改了、启动时和响应时的答案可以不一致）。
 *   收在这里：index.ts 的强制鉴权闸门与 `/api/auth/providers` 的 form 字段都认这个值。
 *
 * ★ 取值语义（与 `auth/ownership.ts` 的归属模型严格对齐）：
 * · 关（缺省）→ `local` 本地单人形态：服务绑 127.0.0.1，未登录 = 单人模式，
 *   `ownerIdOf → null` 不过滤/无主行，**免登录可用是后端既有语义，不是本批新造的**。
 * · 开 → `cloud` 线上多用户形态：强制登录，每条请求必有 user ⇒ 必过滤。
 *
 * ★ 后续「本地有、线上没有」的功能以 `deployForm()` 返回值为唯一分叉点——
 *   不要再各自读 `SB_REQUIRE_AUTH`（读两次必然漂一次）。
 */

/** 启动时读定（与 index.ts 的强制鉴权闸门同源同刻——形态是部署事实，进程内不变）。 */
export const REQUIRE_AUTH = process.env.SB_REQUIRE_AUTH === '1';

export type DeployForm = 'local' | 'cloud';

export function deployForm(): DeployForm {
  return REQUIRE_AUTH ? 'cloud' : 'local';
}
