# RETENTION-SPEC — 留存的度量口径（2026-09-30）

> 「已上线」≠「有留存」。这份契约不制造用户，它只保证：**当有人来的时候，我们能诚实地知道他有没有再来。**
> 读数纪律沿用 `docs/metrics-product.md` §0：小样本不出百分比、旧读数不回改、数字不许手抄。

## §1 为什么以前算不出留存

- `messages` 只记录「说过话的人」。「打开了但没说话」与「根本没来」在库里长得一模一样。
- `event_log` 自建立起为空（v36 审计 0 行），没有任何「谁在什么时候来过」的事件流。
- 体验号 `shared-demo@studentbuddy.invalid` 被 `prod-pulse` 巡检每几分钟登录一次——不排除它，留存恒为 100%。

⇒ metrics-product §3 把「遥测心跳」登记为 L3 挂起的唯一机制性原因。本契约补的就是这一笔。

## §2 心跳：`user_activity_day`（v52）

| 项 | 决定 | 理由 |
|---|---|---|
| 粒度 | 每用户每**天**一行：`(user_id, day)` 主键，`first_seen_at` 只记首次 | 留存只需要「来没来」，不需要「干了什么」；不记 IP / UA / 路径 |
| 触发 | 登录用户任一 `/api/*` 请求（中间件 `growth/activity.ts`，挂在 `attachUser` 之后） | 打开应用必然打接口；不改前端、不加埋点 |
| 去重 | 进程内 `Map<userId, day>` + `INSERT OR IGNORE` | 每用户每天最多一次写盘；多实例各写一次也只留一行 |
| 排除 | `isProbeRequest`（`X-SB-Probe` 头 / `studentbuddy-probe/*` UA）不记 | 巡检不是用户 |
| 失败 | 吞异常，永不影响业务请求 | 心跳是旁路观测 |
| `day` | `localDayKey`（服务器本地日），与 `growth_action_day` 同口径 | 两张表可对照 |

**可证伪性**（metrics-product §3 的要求）：有已知流量时读数必须非零——`activity.test.ts` 用一个登录用户打三次接口，断言恰好一行。

## §3 报表：`tools/retention-report.mjs`

```bash
node tools/retention-report.mjs --db /path/studentbuddy.db [--days 30] [--exclude-email 我自己@…] [--json]
node tools/retention-report.mjs --selftest     # 内存库 + 已知答案，证明口径算得对
```

口径（改口径先改这里，再改脚本的 `--selftest` 答案）：

- **活跃日** = 「打开」（心跳有行）∪「用过」（当天发过 `user` 消息，或做过复习）。两者分开列，能区分「来了不用」与「没人来」。
- **纳入用户** = `users` 去掉体验号、`*.invalid` 邮箱、`--exclude-email` 点名者（项目所有者自己）。
- **D1** = 注册日 +1 那一天活跃；**W1..W4** = 注册后第 1–7 / 8–14 / 15–21 / 22–28 天内任一天活跃（分桶留存，对小样本比「第 N 天当天」稳）。
  分母只算**注册已满 N 天**的用户——没满的没资格被判流失。
- **激活漏斗**：注册 → 发过 ≥1 条消息 → 注册日之后还发过 → 做过 ≥1 次复习。
- **活跃**：WAU（近 7 天）、MAU（近 28 天）、近 7 天日均 DAU、粘性 DAU/MAU。
- 分母 < 30 的百分比一律带 ⚠️；对外只报绝对数。
- 只读打开（`readonly: true`），输出不含任何邮箱 / id，零网络。

## §4 这份契约**不**承诺什么

- 不承诺用户会来。6 个真实用户上跑出的任何百分比都不是结论，只是方向。
- 不追踪匿名访客（未登录不记）：本地单机形态没有账号也不需要留存；访客量级另有 `/api/growth/counters`（单位是 ip_day「次」，不是「人」）。
- 不做跨设备归并、不做会话时长：那是另一个量级的遥测，现在的用户量撑不起它的解释力。

## §5 何时可以解除 metrics-product §1 的 L3 ❌

心跳上线满 **4 周** 且纳入用户 ≥ **30**：用 `retention-report.mjs` 出第一笔读数，追加到 metrics-product §2 尾部（不回改旧行）。
两条件任一不满足，L3 继续 ❌——报表能跑不等于有资格发数字。
