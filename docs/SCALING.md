# SCALING — 单机 Express + SQLite 的容量边界与扩容路径（2026-09-30）

> 回答一个被问了很多次的问题：**「Express + better-sqlite3 单进程，怎么水平扩展？多实例下 SSE 怎么办？」**
> 答案分三层：① 先量出单进程到底能扛多少（§3，有数字、可复测）；② 把「多实例会坏什么」列成清单（§2）；
> ③ 按触发条件写清每一步该做什么、**为什么现在不做**（§5）。没有第 ①②③ 就谈架构，是拿别人的架构图当自己的。

## §0 结论先行

- 这个应用是 **I/O 密集**的：一次对话的 CPU 时间是毫秒级，墙钟时间是十秒级（在等上游 LLM 出字）。Node 单进程天然适合「很多连接、每个连接很闲」。
- 本机实测（§3）：**100 个用户同一瞬间发起流式对话 + 500 条空闲 SSE 连接**，全部成功，首 token p95 ≈ 1s，整轮时长只比上游节奏膨胀 1.4×；**300 个同时发起**仍零失败，但 p95 明显变差（2.7×）。
- **真正的上限不是 Node，而是上游配额策略**：免费通道全站并发封顶 `SB_UPSTREAM_SITE_MAX_CONCURRENT=8`（TENANCY-SPEC §8.1.3.1）。Node 还有两个数量级余量的时候，这条策略先到顶。
- 所以**当前不做多实例**是一个有数字支撑的决定，不是没想过。触发条件见 §5。

## §1 负载画像：钱花在哪

| 环节 | 每次对话的开销 | 瓶颈类型 |
|---|---|---|
| 组上下文（读 messages / memory / 词条） | 若干条 SQLite 读，亚毫秒级 | CPU（可忽略） |
| 上游 LLM 流式 | 5–30 s 等待，每帧几十字节 | **网络 I/O 等待** |
| SSE 下发 + 缓冲 | 每帧一次 `res.write` + 数组 push | CPU（微秒级） |
| 落库（assistant 消息、事件流水） | 单写者 WAL，几条 INSERT | 磁盘 I/O（毫秒级） |

SQLite 在 WAL 模式下**读不阻塞写、写不阻塞读**，只有写写互斥；本应用写入量（每轮几行）离 SQLite 的写吞吐（每秒数千事务）差三个数量级。

## §2 进程内状态清单：多实例时会坏什么

这是本文件最有用的一张表——**每一项都是「加第二个实例前必须决定怎么办」的东西**。

| 模块 | 进程内状态 | 第二个实例出现后 | 处理 |
|---|---|---|---|
| `chat/sse-bus.ts` | `clients`（连接集合）、`buffers`（每会话回放缓冲） | 用户的 SSE 挂在 A、`send` 打到 B ⇒ B 的 `publish` 没人收，**整轮不上屏** | **粘性会话**（同一 cookie 恒定路由到同一实例）；跨实例广播需 pub/sub（§5 L2） |
| `chat/flow.ts` | `locks`（每会话串行锁） | 同一会话两条消息分到两个实例 ⇒ 并发写同一会话 | 粘性会话即可（锁的粒度是会话，会话跟着用户走） |
| `chat/tools/confirm.ts` `chat/choice.ts` `learning/continent-expand.ts` | 等待用户点击的 `waiters` / `offers` | 确认请求打到另一实例 ⇒ 找不到 pending，工具挂起直到超时 | 粘性会话 |
| `routes/chat.ts` `routes/coach.ts` | `aborters`（正在生成的会话 → AbortController） | 「停止生成」打到另一实例 ⇒ 停不下来；`/chat/active` 只报本实例 | 粘性会话；`/active` 在 L2 需汇总 |
| `llm/upstream-gate.ts` | 两层并发闸门 `innerGates` / `outerGates` | **容量 × 实例数**（DEPLOY.md §11 已登记） | 可接受到 L1；L2 移到 Redis 计数 |
| `auth/rate-limit.ts` `register-limit.ts` `code-limit.ts` `routes/growth.ts` | 按 IP / 邮箱的滑窗限流 | 阈值 × 实例数 | 可接受（阈值本就保守）；L2 一并外置 |
| `pk/room.ts` | `rooms` / `codes`（对战房间全内存，PK-SPEC §4 已声明） | **同一房间的两名玩家可能在不同实例** ⇒ 互相看不见 | 粘性会话**救不了**（按用户粘、不按房间粘）⇒ PK 是 L2 的第一个动因 |
| `growth/activity.ts` | `seen`（每用户当日去重） | 每实例各写一次 | **无害**：`INSERT OR IGNORE` 幂等，库里仍一行 |
| `events/bus.ts` `jobs/worker.ts` | 进程内事件订阅 / 任务处理器 | 事件只在产生它的实例被消费 | 无害：订阅者都是「记账」型（obs / learning_event / term_graph），账在库里 |

一句话：**除了 PK，其余全部靠「粘性会话」就能正确**；PK 需要跨实例消息总线。

## §3 单进程实测（可复测）

```bash
npm run build && node tools/loadtest/sse-load.mjs --users 100 --idle 500 --token-delay-ms 40 --reply-chars 1200
```

探针做的事（零真实网络、零 key）：起假上游（按 `--token-delay-ms` 逐帧出字）+ 隔离 server，注册 N 个用户（各自 BYOK 挂假上游，
避开外层配额闸门，量的是 Node 不是策略），**同一瞬间**各发一条消息，收齐 `done`；另挂 `--idle` 条空闲 SSE 量内存。

**2026-09-30 读数**（2 vCPU Intel Xeon 2.6GHz 沙箱、Node 22、探针与 server 同机 ⇒ 数字偏保守）：

| 场景 | 首 token p50 / p95 | 整轮 p50 / p95（上游理论 4000ms） | 成功 | RSS 峰值 |
|---|---|---|---|---|
| 100 并发生成 + 500 空闲 | 848 / 995 ms | 5583 / 5643 ms（**1.41×**） | 100/100 | 220 MB |
| 300 并发生成 + 1000 空闲 | 1329 / **5986** ms | 7510 / 10704 ms（**2.68×**） | 300/300 | 276 MB |

- 每条空闲 SSE 连接 ≈ **90–160 KB** RSS ⇒ 1 GB 内存约能挂 5000 条空闲连接，远在用户量之前先撞上文件描述符上限（`ulimit -n`，systemd `LimitNOFILE`）。
- 「同一瞬间 300 人发消息」是极端形态（真实流量是泊松到达）；即便如此也是**变慢、不失败**。
- 线上真正生效的封顶是 `SB_UPSTREAM_SITE_MAX_CONCURRENT=8`：免费通道第 9 个人进队列、第 29 个人被明确拒绝（`SB_UPSTREAM_SITE_QUEUE_MAX=20`）。**放开这个数之前，任何多实例工作都是零收益。**

## §4 运维可观测：`/api/health`

```json
{ "ok": true, "version": "0.2.151",
  "instance": { "id": "3f9a1c2e", "startedAt": "…", "uptimeSec": 1234 },
  "sse": { "clients": 12, "sessions": 9 }, "rssMb": 121 }
```

- `instance.id` 每次启动随机：多实例部署时**连打两次 curl，id 不变才证明粘性会话生效**。
- `sse.*` / `rssMb` 只描述本进程——这正是 §2 那张表的运行时形态。
- 库打不开回 **503**：`deploy.sh` 的 `curl -sf` 与 watchdog 会把它当「没起来」，进程活着但库坏了本来就该算没起来。
- 全是聚合数，零个体信息，端点仍在鉴权豁免清单里。

## §5 扩容路径与触发条件

| 阶梯 | 做什么 | 触发条件（先量再动） | 代价 |
|---|---|---|---|
| **L0（现在）** 单进程 + systemd + Caddy | 竖向：更大的机器、`LimitNOFILE`、放开 `SB_UPSTREAM_SITE_MAX_CONCURRENT` | — | 零 |
| **L1** 同机多进程 + 粘性会话 | Caddy `reverse_proxy` 多个 upstream + `lb_policy cookie`；SQLite 仍单文件（WAL 支持多进程）；**PK 关闭或固定路由到一个实例** | `/api/health` 的 `rssMb` 或事件循环延迟持续偏高，且 §3 复测 p95 膨胀 >2× 出现在**真实**并发下 | 限流阈值 × 进程数；PK 降级 |
| **L2** 跨机多实例 | `sse-bus.publish` 改经 Redis pub/sub 扇出（`subscribe` 仍本地）；闸门/限流/PK 房间移到 Redis；SQLite → Postgres（迁移链已是纯 SQL 语句表，`migrations-list-v*.ts`） | 单机竖向到顶（或需要跨可用区容灾），**并且**上游配额已放开到单机撑不住 | 引入两个有状态外部件；本地单机形态（无账号、无 Redis）必须继续可用 ⇒ 总线需双实现 |

**为什么现在不先把 sse-bus 抽成「可插拔总线接口」**：只有一个实现时抽接口，接口会长成第一个实现的形状，第二个实现（Redis）来的时候照样要改。
§2 的清单比一个空接口更有用——它把「要改哪些地方」写死了，改的时候不会漏。

## §6 复测纪律

- 改了 `sse-bus` / `flow` / 上游适配层，跑一次 §3 的命令，把读数追加到本文件（旧读数不回改，同 metrics-product §4）。
- 数字只对跑它的机器有效；标机器、标日期。
