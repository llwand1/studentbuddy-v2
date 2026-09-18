# TENANCY-SPEC · 多租户数据隔离（M2）

> 版本：v1.4 | 状态：[活跃] | 更新：2026-09-18（M2c 开工：**§8.1.4 上下文传递拍板为显式 `ownerId` 穿透**（不引 ALS）+ 13 个消费点清单 + 后台路径 owner 语义 + **迁移 v29**；§8.1.2 补迁移编号与 `ON CONFLICT` 连带必改点；§8.1.3 免费通道额度不限、两层并发限速；`app_settings` 改每用户）
> 上游契约：`docs/AUTH-SPEC.md`（账号与会话）。本契约只解决「**登录之后，数据归谁**」。

---

## 0. 为什么必须先写这份契约

M1（账号）做完之后，账号体系能注册登录了，但**业务数据仍是一张全局大表**：
`sessions` / `messages` / `quiz_bank` / `term_library` / `user_memory` … **全部没有 owner 列**。

此刻上线会发生什么：`GET /api/sessions` 返回 `WHERE deleted_at IS NULL` 的**全部会话**——
**所有访客互相看到对方的聊天记录**。这不是"体验问题"，是**数据泄露**。

所以 M2 是"能不能上线"的**唯一开关**，且与登录方式正交：无论选邮箱、微信还是手机号，这份都得做。

### 0.1 本批范围与非范围（★ 先划清，避免误以为"加完 v22 就安全了"）

| | 内容 | 状态 |
|---|---|---|
| **本批（M2a）** | `sessions` 归属列 + 会话/聊天域全部端点接线 + 内存态（aborters/SSE）隔离 | 已落地 |
| **非本批** | `quiz_bank` / `quiz_notes` / `term_library` / `user_memory` / `daily_activity` / `flow_def` / `providers` / `token_usage` | **未接线 ⇒ 仍在互相看见**，见 §7 挂账 |

★ **"加列"与"接线"必须同批**。只加 `user_id` 列而查询不过滤，等于给一张漏水的桶贴标签——
既不减少泄露，还制造"已经做了隔离"的假象。故本批**只给本批真正接线的表加列**。

---

## 1. 归属模型：**会话是唯一锚点**（parent-owned）

```
users (AUTH-SPEC v21)
  └── sessions.user_id        ← ★ 归属唯一事实源
        ├── messages          ← 不设 user_id，随父会话
        ├── ask_choices       ← 同上
        └── flow_run          ← 同上
```

**为什么不给 `messages` 也加 `user_id`**：
那会造出**两个事实源**（`sessions.user_id` 与 `messages.user_id`），二者一旦漂移，
"到底谁拥有这条消息"就没有答案了——本仓在 `register` / `/me` 的 `createdAt` 上已经为
"两个事实源"付过一次学费（test-plan §4）。**子表随父表，是从模型上消灭漂移**。

代价：读子表必须先断言父会话归属。这条由 §4 的 `canAccessSession` 统一承担。

---

## 2. 迁移 v22：`sessions.user_id`

```sql
ALTER TABLE sessions ADD COLUMN user_id TEXT;   -- 可空：老行是孤儿
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

- **可空是刻意的**：老库里已有会话，它们的 owner 在迁移那一刻**不可知**（谁的？无人可问）。
  强行回填成某个具体用户 = 把别人的历史聊天判给他。故留 `NULL`。
- **索引必须加**：`WHERE user_id = ?` 是此后最高频的过滤条件，无索引则会话一多就全表扫。
- ★ 纯加法，`ALTER TABLE ADD COLUMN` **不幂等** ⇒ 回放迁移链的测试若 DROP 表重建则无碍，
  但若只回滚版本号重放，会报 `duplicate column name`（本仓 v18 踩过，见 `db.test.ts`）。

---

## 3. 老数据（孤儿行）策略

**规则：`user_id IS NULL` 的行，对任何已登录用户都不可见。**

- 登录用户的查询一律带 `WHERE user_id = ?`，`NULL` 天然不匹配 ⇒ **不会泄露给别人**。
- 副作用：老数据对**它的真正主人也看不见了**（认领前等于归档）。
- **认领路径**：`_probe/claim-legacy.mjs <email>` —— 显式把全部孤儿行判给指定账号。
  ★ **刻意不做"首个注册者自动认领"**：那是隐式魔法，并发注册时归属不确定，且无法撤销。

---

## 4. 归属解析：`ownerIdOf` 与「无登录态」的边界

| `SB_REQUIRE_AUTH` | 请求带有效会话？ | `ownerIdOf()` | 过滤行为 |
|---|---|---|---|
| `0`（默认） | 是 | `user.id` | **按 user 过滤** |
| `0`（默认） | 否 | `null` | **不过滤**（维持本地单人旧行为） |
| `1` | 否 | — | 中间件已 401，到不了路由 |
| `1` | 是 | `user.id` | 按 user 过滤 |

★ **为什么"无登录态就不过滤"**：本仓默认仍是本地单人模式（服务只绑 `127.0.0.1`），
强行过滤会让老板自己本地的历史数据全部消失。**安全边界由部署形态保证**——
一旦 `SB_REQUIRE_AUTH=1`（生产），每条请求必有 user ⇒ 每条查询必过滤。

这条要在部署 runbook 里钉死：**生产必须 `SB_REQUIRE_AUTH=1`**。

---

## 5. 路由接线规范（会话域 / 聊天域）

| 端点 | 改造 |
|---|---|
| `GET /api/sessions` | `WHERE deleted_at IS NULL AND user_id = ?`（owner 为 null 时不带该条件） |
| `POST /api/sessions` | 插入时写 `user_id` |
| `DELETE /api/sessions/:id` | 先断言归属，不归属 → **404**（不回 403，避免泄露"这个 id 存在"） |
| `PATCH /:id/pinned` | `WHERE ... AND user_id = ?` |
| `GET /:id/messages` | 先 `canAccessSession`，否则 404 |
| `GET /:id/live` | 同上 |
| `POST /api/chat/send` `/regenerate` `/resend` `/abort` | 先断言归属 |
| `GET /api/chat/active` | **只返回自己的会话 id**（aborters 带 owner 维度，见 §6） |
| `GET /api/chat/stream` | 先断言归属 |

★ **统一口径：不归属一律 404，不回 403**。403 等于告诉攻击者"这个 id 存在，只是不是你的"。

---

## 6. 内存态与 SSE 的隔离（★ 最易漏的一处）

`aborters: Map<sessionId, AbortController>` 是**进程内存**，不随 SQL 过滤消失：

- 老实现 `GET /chat/active` 直接 `[...aborters.keys()]` ⇒ **任何人都能看见别人"正在生成"的会话 id**。
  这本身是信息泄露，且暴露的 id 可被拿来撞 `/api/sessions/:id/messages`（虽然会被归属断言挡住，
  但**会话 id 属于敏感标识，不该扩散**）。
- 改造：`Map<sessionId, { controller, ownerId }>`，`/chat/active` 与 `/abort` 都按 owner 过滤。
- SSE 订阅（`sse-bus`）已是**按 sessionId 分隔、禁通配**（v1 串台教训），叠加归属断言即可，
  **不做跨用户全局频道**。

---

## 7. 长期画像归属（M2b，迁移 v24）

`user_memory` 与前几节不同：它**不是**"用户自己建的东西"，而是**全站唯一一处由模型自动写入的
跨会话个人数据**。这条差异决定了两件事——归属列必须是 `NOT NULL`，唯一键必须带 owner。

### 7.1 为什么必须**重建表**而不是 `ADD COLUMN`

v13 建表时写的是 `UNIQUE(kind, content)`，这是**全局**唯一键。多用户下两个人沉淀出同一句画像
（"喜欢先看例子"这种极常见）时，后写的人走 `ON CONFLICT(kind, content) DO UPDATE` 会**改写先写那一行**：

| 后果 | 说明 |
|---|---|
| B 的记忆**写不进去** | 写是成功的，但写完按 `user_id` 过滤，B 自己看不到——最隐蔽的一类 bug |
| A 的画像被**陌生人刷新** | `importance` 取 MAX、`updated_at` 被改，A 无从察觉 |
| B 的隐私**落进 A 的行里** | 内容是 B 的，行主是 A ⇒ A 打开记忆页直接看见 |

一条约束同时造成「串台 + 污染 + 泄露」，而 `ALTER TABLE` 改不了约束 ⇒ **只能重建**。

### 7.2 归属列的语义：`NOT NULL DEFAULT ''`

- `user_id = ''` ＝ **无主**（迁移前的遗留行 / 未登录的本地单人模式写入）。与 §3 的"孤儿行"同义。
- 为什么这里用 `''` 而不是 §2 的 `NULL`：唯一键要用**列**而不是 `COALESCE(user_id,'')` 表达式索引，
  因为 `ON CONFLICT` 的冲突目标必须匹配唯一索引的列，表达式索引会让它退化成"无冲突目标"而直接报错。
- ⇒ 两处的"孤儿"取值不同是**刻意的**，不是疏漏：`sessions` 无此约束故用 `NULL`，
  `user_memory` 有复合唯一键故用 `''`。两者对外行为一致（登录用户都查不到、`WHERE user_id = ?` 天然跳过）。

### 7.3 归属必须**显式传下来**，不能靠 `req`

记忆的写入只在压缩过程里发生（MEMORY-SPEC §5.1），而压缩是 **fire-and-forget**——它跑在
HTTP 响应之后，那时 `req` 早已结束。故：

```
routes/chat.ts  ownerIdOf(req)
  → handleMessage({ ownerId })
    → collectContextSegments({ ownerId })  → buildMemoryContext → injectMemoryBlock(ownerId)   // 读
    → compactIfNeeded(sessionId, ownerId)  → upsertMemoryItems(..., ownerId) / pruneMemoryItems(ownerId)   // 写
```

★ 全链路每一个 `ownerId` 参数都是**可选且默认 `null`**（＝本地单人模式，不过滤）。
可选而非必填是刻意的：既有 20+ 个调用点（含测试）不必改签名，而"漏传"的后果是**退回现状**，
不是串台——**让默认值是安全的那一侧**。

### 7.4 顺带补上的一个旁路（M2a 漏的）

`GET/DELETE /api/memory/summary/:sessionId` 只吃 `sessionId`、原先不判归属——
拿别人的会话 id 就能**读出他早前对话的浓缩**，甚至远程擦掉。
现已统一走 `canAccessSession`，不归属一律 404（与 §5 同口径）。

---

## 8. 挂账：仍未接线（下一批 M2c / M2d）

### 8.1 `providers` / `role_bindings` / LLM 路由 —— **必须整片做，不能拆**

§1 的原计划是把 `providers` 与 `user_memory` 合成 M2b 一批。实际读码后**把它拆出去了**，理由如下：

- `providers` 的归属**不止是"能不能改"**。真正要命的是**用**：`roleRole()`（`llm/router.ts`）
  取 provider 时不知道"这轮是谁在问"，故用户 A 配了 key，**B 聊天烧的是 A 的额度**。
- 而 `routeRole` 被 **14 个文件**调用（chat / learning / pk / routes 各域），全仓**没有**
  `AsyncLocalStorage` 或任何上下文传递机制 ⇒ 要让路由按 owner 取 provider，是一次横切改造。
- 同时 `role_bindings` 是**全局表**（`role → provider_id`），`PUT /roles/:role` 任何登录用户都能调。
  若只给 `providers` 加归属而不管它，**任何人可以把全站的模型指向自己的 provider**——
  比现在更糟：从"能改别人的"变成"能改所有人的"。

⇒ 结论：**`providers` + `role_bindings` + `routeRole` 是一整片**（本质是"LLM 成本与配置归谁"），
拆开做只会先造出新洞。它的正确定义是 **M2c**，且要先定"谁付模型钱"这个业务决策。

#### 8.1.1 ★ 业务决策已定（2026-09-18）：**双通道并存**

老板原话：「**模型的 api 可以让用户自带 api，但是我们自己也提供免费的额度**」。

⇒ 「谁付模型钱」**不是二选一，而是两条通道同时存在**，M2c 据此展开：

| 通道 | 谁付钱 | 归属要求 | 关键约束 |
|---|---|---|---|
| **BYOK（用户自带 key）** | 用户 | `providers.owner_id = user.id`；`role_bindings` 按用户隔离 | 用户的 key **只能被他自己用**——否则烧的是别人的钱 |
| **平台免费额度** | 平台（老板） | 平台 provider 的 `owner_id` 取**保留值**（非任何真实 user） | **必须配配额 + 熔断**，见 8.1.3 |

★★ **两条通道必须能在同一次 `routeRole` 调用里被区分**：做不到的话，「免费用户烧到付费用户的 key」与「付费用户被免费额度截断」会**同时发生**。这也是本片必须横切（而非只加列）的根本原因。

#### 8.1.2 三张表的改造（读码实测，2026-09-18）

| 表 | 现状（实测表结构） | 改造 |
|---|---|---|
| `providers` | `id / name / base_url / api_key / type / enabled / created_at` —— **无 owner 列**（v1 建表 `migrations-list-v1-9.ts:22-30`；v13 追加 `stream_mode`） | 加 `owner_id TEXT`（可空；`NULL` = 平台通道的保留值，语义同 §3 的孤儿行） |
| `role_bindings` | **`role TEXT PRIMARY KEY`**（单列主键，全局唯一；`migrations-list-v1-9.ts:32-36`） | ★ **必须改复合主键 `(owner_id, role)`** —— 见下方警告 |
| `token_usage` | `id / session_id / model / prompt_tokens / completion_tokens / source / created_at` —— **无 `user_id`** | 加 `user_id`（**归属与诊断用**）。★ **不是配额账本**——§8.1.3 已把免费通道改成「额度不限、只限并发」⇒ **不做配额聚合**。★ 它已带 `session_id`、而 `sessions.user_id` 已存在 ⇒ 过渡期可先 join 拿 owner，但最终仍应直接落列 |

★ **迁移编号 v29**（三张表同版；⚠️ 提交顺序的硬约束见 §8.1.4 末尾）。`role_bindings` 的重建**照 §7.1 的 `user_memory`（v24）六步先例**：建新表 → `INSERT … SELECT` 显式回填归属列 → `DROP` 旧表 → `RENAME` → 重建索引。★ 老库既有绑定的回填值取 **`NULL`**（= 平台通道），与 `providers` 的平台 provider 对齐——**不能用 `''`**：`routeRole` 的平台分支判据是 `owner_id IS NULL`，`''` 会落进「某个不存在的用户」的空档。

★★ **`role_bindings` 的主键必须改，这是本片最容易漏的一处**：现主键是 `role` 单列 ⇒ 全库只有**一份** `explain → provider_X` 的绑定。若只给 `providers` 加 owner 而不管它，则**任何登录用户改一次绑定，全站所有用户的模型都跟着变**——从 8.1 描述的"能改别人的"升级成"**能改所有人的**"，**比不做更糟**。而 `ALTER TABLE` 改不了主键 ⇒ **照 §7.1 的 `user_memory` 先例重建表**（v13 的 `UNIQUE(kind, content)` 与此同型）。

★ **连带必改的写口（读码实测，2026-09-18）**：`PUT /api/providers/roles/:role` 的写库语句是 `INSERT … ON CONFLICT(role) DO UPDATE`（`routes.ts:186`）。主键改复合后 **`ON CONFLICT(role)` 会直接报错**（找不到匹配的唯一索引）⇒ 必须同步改成 `ON CONFLICT(owner_id, role)`，并写入当前用户的 `owner_id`。**只改迁移不改这里 = 运行时 500**，两者必须同批。


#### 8.1.3 免费通道的限流模型（2026-09-18 **二次拍板**：额度不限、限并发）

老板原话：「**免费额度是无限的，但是限速，就是不能请求太多，最多同时运行两个对话**」。

⇒ ★★ **本小节推翻了同日的初稿**（初稿写「模型白名单 + 每用户配额 + 全局熔断」三条），改判如下：

| 维度 | 决策 | 说明 |
|---|---|---|
| 额度 | **不限**（不按 token 计量） | 不引入"送多少 token"的概念 ⇒ **`token_usage` 不做配额聚合**（它仍要加 `user_id`，那是归属与诊断用的，见 8.1.2） |
| 限流手段 | **并发**（不是频率、不是累计配额） | ★ 两层：**每用户 2 个** + **全站封顶** |
| 模型 | **不设白名单**（初稿「只免费便宜模型」**作废**） | 与"额度不限"配套——不计量 token 了，白名单就失去锚点 |

★ **为什么"限并发"能替代"配额"**：并发是**吞吐**上的硬闸——同时最多 N 个请求在飞 ⇒ 单位时间的请求数有上界 ⇒ 成本有上界。配额是**累计量**上的闸。两者治的不是同一个病：**配额防「单用户刷爆」，并发防「整体打挂上游」**。老板选并发，等于把防线放在"整体"这一侧。

⚠️ **但这个上界是"数学值"而不是"安全值"**（诚实记账）：上界 = 吞吐 × 单价。按容量 2、单次请求 30 秒估，一天最多 5760 次请求；若单次 3000 token、用便宜模型，约 **$50/天 ≈ $1500/月**。现实中不会有用户 7×24 满负荷，实际远低于此，但两点必须知道：① 该上界**不随用户数收敛**（因为内层是"每用户"）——**这正是要加"全站封顶"的原因**；② 上游响应越快吞吐越高（单次 3 秒 ⇒ 上界涨 10 倍）。

##### 8.1.3.1 两层闸门（2026-09-18 拍板）

```
用户请求 → [内层] 每用户 2 并发 → [外层] 全站封顶 N 并发 → 上游
```

★ **内层保体验、外层保成本与上游**：只做内层则成本敞口随用户数线性增长、上游可能被打挂；只做外层则用户之间互相排队（10 人同时用、8 人在等）。**两层职责不同，不能合并成一层。**

★ **与既有 `upstream-gate` 的关系（读码实测，2026-09-18）**：`llm/upstream-gate.ts` **已有一个容量 2 的信号量**（`UPSTREAM_MAX_CONCURRENT = 2`，2026-09-17 老板拍板原话「限制并发，但是应该两个对话同时运行还是可以的」），但它是**按 `baseUrl` 分桶、进程内、排队不拒绝**的**技术闸门**（保护上游不被打挂），**不是**本节的业务限速。本次要做的是给它**加 owner 维度**（内层）并**另加一个全站桶**（外层），而不是新建一套。三条边界必须一并处理：

1. **进程内**：实现是 `const gates = new Map()` ⇒ 多实例部署时容量会 **× 实例数**（每实例各算各的）。单实例部署下成立；**多实例需外部存储**（Redis 等），**本批不做，记为已知边界**。
2. **排队不拒绝**：现有实现把超限请求放进 waiter 队列（`main` 优先、`background` 让路）。★ **外层全站桶必须设队列上限或排队超时**——否则全站封顶时用户会**无限期转圈**，体验上是"卡死"，**比明确拒绝更糟**（应回「当前免费通道繁忙，请稍后再试」）。
3. **分桶键**：现按 `baseUrl` ⇒ 所有共用平台 key 的用户**天然共享容量 2**（即事实上的"全站 2"）。加 owner 维度后：**内层按 `(baseUrl, ownerId)`、外层按 `baseUrl`**。

⚠️ **全站封顶 N 的具体数值未定**（待老板给业务值）。★ 但**结构可以先落**（内层 2 已定、外层留 config）——这与初稿「参数没定不能写」的判断不同：外层是一个**纯数值常量**，留 config 即可，不像配额那样需要配套的业务语义（计量口径、重置周期、超限行为）。

##### 8.1.3.2 与 BYOK 通道的关系

★ **两层闸门只约束免费通道**。BYOK 用户自带 key ⇒ 不同 `baseUrl` ⇒ 天然落到**另一个桶**，不受平台闸门影响。

★ 这一条同时解释了**为什么不能把闸门做成"全局单桶"**——那会把付费用户一起限住，等于"因为免费用户多，付费用户也被卡"。

#### 8.1.4 ★ 上下文传递方案（2026-09-18 拍板：**显式 `ownerId` 穿透**，不引 AsyncLocalStorage）

**问题**：`routeRole()` 必须知道「这一轮是谁在问」。§8.1 初稿写「全仓没有 `AsyncLocalStorage` 或任何上下文传递机制」——**读码实测后该表述需修正**，方案据此改判。

**实测事实（2026-09-18；13 个生产消费文件 + `router.ts` 自身）**：

| # | 消费点 `文件:行号` | 角色 | 路径性质 | `ownerId` 现成可得？ |
|---|---|---|---|---|
| 1 | `chat/flow.ts:91` | `opts.role ?? 'explain'` | HTTP 链（`routes/chat.ts:76` 的 `trackRun`，**不 await**） | ✅ 已有 `opts.ownerId`（`chat/options.ts:30`） |
| 2 | `chat/compact.ts:292` | `summarizer` | **响应后 fire-and-forget**（`flow.ts:328` `void compactIfNeeded`） | ✅ 已收到 `ownerId` |
| 3 | `chat/vision.ts:71` | `vision` | HTTP 链 | ✅ |
| 4 | `pk/judge.ts:39` | `judge` | HTTP 链（4 个上游全在请求路径上） | ✅ |
| 5 | `pk/ai-bot.ts:91` | `solver` | **响应后 detached**（`match.ts:213` `void runAiAnswer`） | ❌ **未传** |
| 6 | `learning/coach.ts:291` | `coach` | HTTP（`routes/coach.ts:77` detached IIFE）**＋ 定时器**（`trend.ts:122`） | ⚠️ 请求侧可得；**定时器侧签名无参** |
| 7 | `learning/coach.ts:293` | `explain`（回退分支） | 同上 | 同上 |
| 8 | `learning/collect.ts:224` | `quiz-generator` | HTTP | ✅ |
| 9 | `learning/activity.ts:80` | `summarizer` | HTTP | ✅ |
| 10 | `learning/quiz-weak.ts:279` | `analyzer` | HTTP | ✅ |
| 11 | `learning/quiz.ts:257` | `quiz-generator` | HTTP ＋ **定时器**（`pk/ai-bot.ts:72` ← `match.ts:357` `void runAiQuiz` ← `tickMatches` 1s ticker） | ❌ 定时器侧**未传** |
| 12 | `learning/scenario.ts:173` | `quiz-generator` | HTTP（3 个上游） | ✅ |
| 13 | `learning/term-extract.ts:75` | `explain` | HTTP ＋ **响应后 fire-and-forget**（`flow.ts:320` `void extractTerms`） | ❌ **未传** |
| 14 | `learning/tidy.ts:204` | `explain` | HTTP（chat 工具循环内） | ✅ |
| — | `llm/router.ts:127` | `roleReady()` 内部自调用 | — | 需一并加参 |

★ **修正 §8.1 初稿的两处**：① 「14 个文件」的真实构成是 **13 个生产消费文件 + `router.ts` 自身**，而 **`routes/` 域没有任何文件直接调 `routeRole`**（只调 `roleReady`，3 处：`routes/quiz.ts:114`／`:170`、`routes/scenario.ts:63`）；② 「全仓没有上下文传递机制」**不准确**——**显式 `ownerId` 参数穿透已是既有惯例**，且有书面理由：`chat/options.ts:26-29` 自述「本链路是 fire-and-forget 的，压缩与记忆写入发生在 HTTP 响应之后，**那时已无 req 可取用的上下文**」；`chat/compact.ts:272/360`、`learning/coach.ts:322` 均照此把 `ownerId` 一路带下去。

**★ 拍板：沿既有惯例做显式穿透，`routeRole` 加第三参**：

```ts
routeRole(role: ModelRole, fallbackModel?: string, ownerId?: string | null)
```

四条理由：

1. **惯例一致**：`ownerId` 显式下传已是本仓做法（`ChatOptions.ownerId`／`compact.ts`／`coach.ts` 三处先例），ALS 会是**第二套机制**。
2. ★ **成本归属必须「看得见」**：M2c 的本质是「谁付模型钱」。显式参数让**每个调用点都必须回答「这是谁在问」**；ALS 把它藏进隐式上下文，漏设时**静默退化成平台通道**——而那正是本次要消灭的 bug（A 的 key 被 B 烧掉／平台额度被白嫖）。**同一个失败模式，一个写在代码里，一个不写。**
3. **ALS 在定时器路径上并不生效**：`pk/match.ts:376` 的 1s ticker 与 `learning/trend.ts:245` 的 6h ticker **都没有 HTTP 上下文**，ALS 里读出来是 `undefined` ⇒ 仍须显式传。即 ALS **只覆盖一半场景，却引入一整套隐式语义**。
4. **零新机制**：不引 `node:async_hooks`，不增测试基建（现有 `routeRole` 测试直接加参即可）。

**后台／脱离链路的 owner 语义（必须逐条定义，不留白）**：

| 路径 | `ownerId` 取什么 | 理由 |
|---|---|---|
| `trend.ts` 定时器 → `resolveCoachTarget()` | **该轮 tick 的 `ownerId`** | ★ `trend.ts:231` 本就 `for (const ownerId of trendOwners())` **逐 owner 跑**，ownerId **现成在手**，只是 `resolveCoachTarget()` 签名没收——**加个参数即可，零新逻辑** |
| `pk/match.ts` 1s ticker → `runAiQuiz` → `generateQuiz` | **`null`（平台通道）** | AI 对手是**平台扮演的角色**，不是任何用户的请求；且房间有两名玩家，**不存在唯一 owner**。⇒ 明确记为平台消耗（受 §8.1.3.1 两层闸门约束）。⚠️ 若将来要按房间分摊，需先在 `pk_matches` 上定义归属，**本批不做** |
| `chat/flow.ts:320` `void extractTerms(...)` | **补传 `opts.ownerId`** | 起点是用户请求、ownerId 现成；**当前漏传是 bug**（词条会写进无主库） |
| `chat/flow.ts:328` `void compactIfNeeded(...)` | **已传，保持** | — |
| `pk/match.ts:213` `void runAiAnswer(...)` | **补传**（取当前提交者） | 起点是 `submitQuiz()` 的 HTTP 请求 |
| `routes/coach.ts:77` detached IIFE | **补传** | 同上 |

★ **`null` 的语义与既有口径一致**：`auth/ownership.ts:26` 的 `ownerFilter(null)` 返回空过滤 ⇒「单人本地模式不做归属判定」；`routeRole(…, null)` 同理 ⇒ **走平台通道**（`providers.owner_id IS NULL`）。

**迁移编号：v29**（写在 `storage/migrations-list-v22.ts`）。⚠️ 并行会话在该文件尾部有**未提交的 v28**（`review_enabled`）⇒ **本批版本号必须从 v29 起**，且**提交必须晚于 v28 进 HEAD**——否则 `migrate()` 的 `if (m.version <= current) continue`（`storage/migrations.ts:22`）会让**已升到 v29 的库永久跳过 v28**（`review_enabled` 列永不落库）。**这是提交顺序的硬约束，不是偏好。**

### 8.2 其余表

| 表 | 泄露后果 | 备注 |
|---|---|---|
| `term_library` / `term_domain` | 中：互相看见词条库 | 含 `UNIQUE(term, domain)`，与 §7.1 同型，**多半也要重建表** |
| `quiz_bank` / `quiz_notes` / `quiz_stats` | 中：互相看见题目与笔记 | 有 `UNIQUE` 复合键，先核 |
| `daily_activity` | 中：学习轨迹 | 纯加法列即可 |
| `flow_def` / `flow_run` | 中：`flow_run` 随会话，`flow_def` 需独立归属 | — |
| `token_usage` | 中：配额与账单的事实源 | 与 8.1 的成本模型一起定；**M2c 一并做**（见 8.1.2） |

★ **`app_settings` 已拍板：每用户一份**（2026-09-18 老板原话「**变成每用户**」）。现状是 `key TEXT PRIMARY KEY, value TEXT` ——**全局一份**（出题配比 / 配图 / 回答方式偏好），而 `PUT /api/settings` 是个**全局写口** ⇒ **用户 A 改出题配比会改掉所有人的**（同 `role_bindings` 的隐患）。改法：主键改 **`(owner_id, key)`**，`ALTER TABLE` 改不了主键 ⇒ **照 §7.1 的 `user_memory` 先例重建表**。★ 归属语义沿用既有口径：`owner_id = ''` 为**无主**（本地单人模式的既有行），登录用户查不到、`WHERE owner_id = ?` 天然跳过。

---

## 9. 验收判据（★ 可实测）

1. **迁移**：v22 后 `sessions` 有 `user_id` 列 + `idx_sessions_user` 索引；v1~v22 连续无缺号。
2. **跨用户不可见**（e2e）：用户 A 建会话 → 用户 B 的 `GET /api/sessions` **不含**该会话；
   B 直接 `GET /api/sessions/:id/messages` → **404**。
3. **孤儿不可见**：无 owner 的老会话，对任何已登录用户都不出现在列表里，直接访问 → 404。
4. **`/chat/active` 隔离**：A 正在生成时，B 的 `/chat/active` 返回空数组。
5. **鉴权关闭时旧行为不变**：无登录态请求仍能列全量会话（不回归本地单人模式）。
6. **真机冒烟**：隔离实例 + 两个账号，逐条跑上述断言。
