# TENANCY-SPEC · 多租户数据隔离（M2）

> 版本：v1.10 | 状态：[活跃] | 更新：2026-09-21（**平台通道**次数**配额（v39）已落码（v0.2.98）**：§8.1.3 的「**额度不限**」被**三次拍板**推翻，新增 §8.1.3.3——**每用户每 5 小时 250 次上游调用**（计数单位＝**每次上游请求**，不是每轮对话：一轮实际产生 1~3 次，配额是成本控制手段、口径必须贴着成本走）；计数**落库 `platform_usage`（迁移 v39）**，**不能用进程内 `Map`**——次数是滚动窗口累计量，放进程内则每次部署都会把用户的额度洗回 250（本仓 09-20 一天重启 4 次）；★ **时序＝先断言后计数**（断言在拿并发槽**之前**，免额度用完的用户占着桶把正常用户挡在门外；计数在**两层并发槽都拿到之后**，被闸门拒绝的请求**不计费**）；★ **只对平台通道计量**（BYOK 与本地单人模式都不计数），且**分桶键是请求者**而非 provider 的 owner。同批平台凭据改从 **env** 注入（`SB_PLATFORM_API_KEY`／`SB_PLATFORM_BASE_URL`／`SB_PLATFORM_MODEL`）以实现「**默认零配置**」且「**不让用户看到**」——**数据库里平台行那把 key 永远是空的**，任何拖库／接口泄漏都拿不到它。★ **按 §0.4 回标不回改**：§8.1.3 与 §8.1.3.1 的原文**一字未动**，只在 §8.1.3 的表内加了一处 `[已被 2026-09-21 三次拍板推翻]` 标注。）。**前任 v1.9（2026-09-19）**：**M2d-3 已落码（v0.2.67）**：§8.2 的 `quiz_bank`/`quiz_stats`/`quiz_notes`/`flow_def`/`flow_run`/`flow_run_step`/`knowledge_node`/`knowledge_edge` 八张随**迁移 v33** 加列 `owner_id`（`NOT NULL DEFAULT ''`，老行回填无主、`_probe/claim-legacy.mjs` 已预置认领）。★ 主键全是全局 uuid ⇒ 加列即可（不重建）；★ 子表 `flow_step`/`flow_edge` 刻意不加列（恒经 def_id 触达，归属随 flow_def 传递）；★ **`knowledge_node`/`knowledge_edge` 的归属过滤即已上线旧洞的收口**（改前 A 的知识图谱 B 能看见）。★ 读写两侧同用 `ownerForWrite`（照抄 M2d-1/M2d-2 口径，不重新发明）。★ M2d 至此**全部完成**，下一批 = M2 收口 → M3 部署。**前任 v1.8（2026-09-18）****M2d-2 已落码（v0.2.63）**：§8.2 里 `term_library`（`UNIQUE(term,domain)` → `UNIQUE(owner_id,term,domain)`，**`id` 仍是全局唯一 PK**——`knowledge_node.ref_id` / `term_review_log.term_id` 都指向它）、`term_domain`（`name` 单列 PK → `PK(owner_id,name)`）、`term_mention_log`（口径 `NULL` → 空串）**三张随迁移 v31 重建**（新分片 `storage/migrations-list-v31.ts`），老行一律回填空串（无主）。★★ **本批最关键的一处开工实测**：`term_review.ts` 的 `SCOPE_JOIN` 原先**只按 `name` 连领域**，`term_domain` 归主后 A 的词条会读到 **B 的同名领域开关**（跨用户串台）⇒ 连接条件补 `owner_id`。★ **`general` 改每用户懒建 + 读路径补建**（老板拍板）：写入侧已有 `INSERT OR IGNORE` 自动登记，领域接口首次访问再补建一份自己的 `general` ⇒ 领域 Tab 恒有一格 `general`（观感不变），孤儿行的 `general` 留给本地单人模式。★ **拆文件（被 server ≤400 红线逼出，照仓规不压注释）**：`terms.ts` → `term-usage.ts`（`countUsage`）；`tidy.ts` → `tidy-plan.ts`（`parseTidyBlock`/`normalizeTidyPlan`/`renameDomainTx`）；`term-review.ts` → `term-review-scope.ts`（范围开关/清零/打卡）；`study-flow-run.ts` → `emitTermNodes` 移入 `knowledge-graph.ts`。★ 连带必改：`terms.ts` 两处 `ON CONFLICT(term,domain)` 的冲突目标同步改复合；`ToolCtx.ownerId` 由可选改**必填**（逼出 `chat/flow.ts` 一处漏传——此前工具里的词条增删改查全落无主行）。**M2d-2 至此全部完成**；此前 v1.7 已落 M2d-1（迁移 v30）与 M2c 全部（§8.1，迁移 v29）。**剩 M2d-3**（`quiz_*`/`flow_*`/`knowledge_*` 加列）→ M2 收口 → M3 部署）
> 前任 v1.5 | 更新：2026-09-18（**M2c 归属改造已落码过测（v0.2.60）**：§8.1.2 三张表随**迁移 v29** 落地 + `routeRole` 第三参 + 14 个消费点全量穿透；★ 同批**开工实测**逮到复合主键 `(owner_id, role)` 在 SQLite 下**不拦 `NULL`** ⇒ 平台行改由**部分唯一索引**去重（两个约束分工不同、都要有）。当时 §8.1.3.1 两层闸门仍未开工，**现已完成**，见上行）
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

★★ **补漏（2026-09-18 开工实测，本小节初稿漏了）**：复合主键 `(owner_id, role)` **在 SQLite 下兜不住平台行**——UNIQUE/PRIMARY KEY 一律把 NULL 视作**互不相同**，`(NULL, 'explain')` 可以插进去**任意多条**。实测（SQLite 3.49.2，本仓 `better-sqlite3`，探针 `_probe/sqlite-null-pk-probe.mjs`）：

| 插入 | 结果 |
|---|---|
| `(NULL, 'explain')` 第 1 条 / 第 2 条 | **两条都成功**（PK 未生效） |
| `('u1', 'explain')` 第 1 条 / 第 2 条 | 第 2 条被 `SQLITE_CONSTRAINT_PRIMARYKEY` 拦住（用户行 PK 正常） |
| 加 `UNIQUE INDEX … (role) WHERE owner_id IS NULL` 后再插 `(NULL,'explain')` | 被 `SQLITE_CONSTRAINT_UNIQUE` 拦住 ✅；且 `('u2','explain')` 不受影响 ✅ |

⇒ **必须再建一个部分唯一索引**：`CREATE UNIQUE INDEX idx_role_bindings_platform ON role_bindings(role) WHERE owner_id IS NULL`。

⚠️ 不建会怎样（不是理论风险，是必现）：`seedIfEmpty()` 用 `INSERT OR REPLACE`（`llm/router.ts:143`）写平台绑定，而 `OR REPLACE` 依赖"有冲突可换"——没有冲突它就**只是普通 INSERT** ⇒ 每调一次就多一条 `(NULL, role)`。`routeRole` 的 `SELECT … WHERE owner_id IS NULL AND role = ?` 于是取到哪条**取决于行序**，模型绑定变成抽签。

★ 两个约束**分工不同、都要有**：复合 PK 管**用户行**（同一用户同一角色只能一条），部分唯一索引管**平台行**（全站同一角色只能一条）。这与 §8.1.3.1「两层闸门职责不同、不能合并」是同一种判断。

★★ **`role_bindings` 的主键必须改，这是本片最容易漏的一处**：现主键是 `role` 单列 ⇒ 全库只有**一份** `explain → provider_X` 的绑定。若只给 `providers` 加 owner 而不管它，则**任何登录用户改一次绑定，全站所有用户的模型都跟着变**——从 8.1 描述的"能改别人的"升级成"**能改所有人的**"，**比不做更糟**。而 `ALTER TABLE` 改不了主键 ⇒ **照 §7.1 的 `user_memory` 先例重建表**（v13 的 `UNIQUE(kind, content)` 与此同型）。

★ **连带必改的写口（读码实测，2026-09-18）**：`PUT /api/providers/roles/:role` 的写库语句是 `INSERT … ON CONFLICT(role) DO UPDATE`（`routes.ts:186`）。主键改复合后 **`ON CONFLICT(role)` 会直接报错**（找不到匹配的唯一索引）⇒ 必须同步改成 `ON CONFLICT(owner_id, role)`，并写入当前用户的 `owner_id`。**只改迁移不改这里 = 运行时 500**，两者必须同批。


#### 8.1.3 免费通道的限流模型（2026-09-18 **二次拍板**：额度不限、限并发；⚠️ **其中「额度不限」已被 2026-09-21 三次拍板推翻，见 §8.1.3.3**）

老板原话：「**免费额度是无限的，但是限速，就是不能请求太多，最多同时运行两个对话**」。

⇒ ★★ **本小节推翻了同日的初稿**（初稿写「模型白名单 + 每用户配额 + 全局熔断」三条），改判如下：

| 维度 | 决策 | 说明 |
|---|---|---|
| 额度 | **不限**（不按 token 计量） | 不引入"送多少 token"的概念 ⇒ **`token_usage` 不做配额聚合**（它仍要加 `user_id`，那是归属与诊断用的，见 8.1.2）。★ **[已被 2026-09-21 三次拍板推翻]**：改为**每用户每 5 小时 250 次上游调用**（见 §8.1.3.3）。`token_usage` 仍不做配额聚合——次数配额用的是**独立的 `platform_usage` 表**，不是 token 账本 |
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

★★ **落码状态（2026-09-18 v0.2.61）：已实现**。落点 `llm/upstream-gate.ts`：

| 层 | 桶键 | 容量 | 队列 |
|---|---|---|---|
| 内层 | `(baseUrl, 请求者)` | `UPSTREAM_MAX_CONCURRENT = 2` | 不限（排队的全是自己的请求） |
| 外层 | `baseUrl` | `SB_UPSTREAM_SITE_MAX_CONCURRENT`，**缺省 8（占位值）** | `SB_UPSTREAM_SITE_QUEUE_MAX`，缺省 20；超出**直接拒**，文案 `当前免费通道繁忙，请稍后再试` |

★ **三条实现期定下的口径**（比本节原文更具体，**以这三条为准**）：

1. **`ownerId` 是"请求者"，不是"provider 的 owner"**。免费通道的 provider 其 `owner_id` 恒为 `NULL`，
   若内层按它分桶，**所有免费用户会挤进同一个容量 2 的桶**——那正是加 owner 维度之前的行为。
   落法：`routeRole` 的三档各自给出配额——① 自己的 provider ⇒ `{ ownerId: 请求者, platform: false }`；
   ② 平台绑定 ③ 平台兜底 ⇒ `{ ownerId: 请求者, platform: true }`。
2. **外层只约束平台通道**（`platform === true`）。★ 原文第 266 行「BYOK 自带 key ⇒ 不同 `baseUrl`
   ⇒ 天然落到另一个桶」**只在两家服务商不同时成立**——用户自带 OpenAI key 时 `baseUrl` 与平台
   provider **完全相同**，桶是同一个。故本层**按"只让外层管平台通道"实现**，把 §8.1.3.2 的**意图**
   落在代码里，而不是落在那个不总成立的假设上。BYOK 仍受**内层**约束（每用户 2）。
3. **获取顺序：内层先、外层后**。反过来会让一个用户的超额请求**占着全站名额**等自己的内层位
   （他一个人就能把别人挡在门外）。⇒ 内层先拿，超额请求停在自己的桶里。★ 相应地，外层拿不到时
   **必须把已拿到的内层槽还回去**，否则该用户的内层槽永久泄漏。

★ **配额怎么传到闸门**（§8.1.4 的延伸，不是 ALS）：`routeRole` 把 `{ ownerId, platform }` 用
`bindQuota()` **绑在它返回的 `adapter` 上**，于是 15 个 `target.adapter.chat(...)` 调用点
**零改动、且结构上不可能漏传**——拿不到 `routeRole` 的返回值就没有 `apiKey`/`baseUrl`，也就发不出请求。
★ 与 ALS 的关键差别：**这里没有"缺省"这个状态**。`ChatRequest.quota` 若真缺省，按
「未登录的**平台**通道」计（失败安全侧：宁可多限一个匿名请求，也不放跑一笔平台开销）。

##### 8.1.3.2 与 BYOK 通道的关系

★ **两层闸门只约束免费通道**。BYOK 用户自带 key ⇒ 不同 `baseUrl` ⇒ 天然落到**另一个桶**，不受平台闸门影响。

⚠️ **上面那句的机制不总成立（2026-09-18 落码时修正）**：用户自带 **OpenAI** key 时，其 `baseUrl` 与平台 provider **完全相同**（`https://api.openai.com/v1`）⇒ 桶是同一个，"天然另一个桶"落空。故实现改为**按"只让外层管平台通道"来落实本节的意图**（`platform === false` 的请求不进全站桶），而不是依赖那个假设。**结论不变，机制改了**——见 §8.1.3.1 的落码口径第 2 条。

★ 这一条同时解释了**为什么不能把闸门做成"全局单桶"**——那会把付费用户一起限住，等于"因为免费用户多，付费用户也被卡"。

##### 8.1.3.3 ★ 平台通道的**次数**配额（2026-09-21 **三次拍板**：加一条「每用户每 5 小时 250 次」）

⚠️ **本小节推翻 §8.1.3 的「额度不限」**。按 §0.4 纪律，**原文一字不改**（见上表与 §8.1.3.1），本小节记录新拍板与它为什么变。

老板原话（2026-09-21）：「**api 哪里就改成默认零配置**，但是有限额，那就是**每 5 小时限定 250 次 ai 调用**，然后**直接使用我的 key 的额度**，但是**不让用户看到**。如果默认模型额度不够或者用户想自己配置模型，那就**按常规通道去配置模型**」。

⇒ 拆成三件事：

| 维度 | 决策 | 与二次拍板的关系 |
|---|---|---|
| 开箱路径 | **默认零配置**——平台通道的 `apiKey`／`baseUrl`／`model` 从 **env** 读（`SB_PLATFORM_API_KEY`／`SB_PLATFORM_BASE_URL`／`SB_PLATFORM_MODEL`），**数据库里平台行那把 key 永远是空的** | **新增**。这是「不让用户看到」的落点：`getProviders()` 本来就不返回 `api_key`，把 key 留在 env ⇒ 任何拖库／接口泄漏都拿不到它 |
| 额度 | **有上限**：**每用户每 5 小时 250 次**（滚动窗口） | ★ **推翻「额度不限」** |
| 保底通道 | 超限 ⇒ **引到既有 BYOK 通道**（自建 provider ＋ 角色绑定，M2c 已建好，本批不改它） | **不变**，但语义从「双通道并存」升级成「**免费有上限、超了就得自带**」 |

★ **v39.1（2026-09-21）双入口随机**（老板拍板「两个都要，随机分配」）：`SB_PLATFORM_API_KEY`／`SB_PLATFORM_BASE_URL` 支持**逗号分隔多路**，按位配对（`key[i] ↔ base[i]`）后**每次调用随机挑一路**；两列表长度不等按 `min` 配对——**宁少一路，不错配**（key 与地址错配＝必然打向不属于这把 key 的入口）。`SB_PLATFORM_MODEL` 仍单值，多路共享同一个模型名。

★ **计数单位是「每次上游请求」，不是「每轮对话」**：一轮对话实际会产生 1~3 次上游调用（主链回复 ＋ `extractTerms` 抽词 ＋ `compactIfNeeded` 压缩）。若按"每轮对话"计数，用户看到的剩余次数很经用，但**平台的实际成本是 2~3 倍**——配额是成本控制手段，口径就必须贴着成本走。⇒ 250 次 ≈ **80~120 轮对话**。

★ **作用域是「每个用户各 250 次」，不是全站合计**：全站合计会让几个活跃用户互相挤占（先来的把额度吃光、后来的直接不可用）。代价是**总成本随用户数线性增长**——这一点与二次拍板时 `§8.1.3` 那段「上界不随用户数收敛」是**同一个风险**，当时靠外层并发闸门兜，现在**多了一层按用户封顶**。

★ **滚动窗口，不是「到点一次性重置」**：每笔消耗各自在满 5 小时后滑出窗口。故前端文案必须写「**最早一笔将在 X 后可再调用**」，**不能**写「X 后额度重置」——写成后者会让用户以为到点就能拿回全部 250 次。

★ **必须落库（迁移 v39 `platform_usage`），不能像并发闸门那样用进程内 `Map`**：并发闸门是**瞬时状态**，进程重启归零是**正确**的（重启后确实没有在飞请求了）；而次数配额是**滚动窗口内的累计量**——放进程内，**每次部署／重启都会把用户的额度洗回 250**，而本仓部署很频繁（2026-09-20 一天内重启 4 次）⇒ 配额形同虚设。

★ **三处「写错就是静默事故」**（都已立锁，见 `llm/platform-quota.test.ts`）：

1. **计数分桶键必须是请求者**（`quota.ownerId`），**不是** provider 的 owner——平台 provider 的 `owner_id` 恒为 `NULL`，用它分桶会让**所有免费用户共享同一份额度**（同 §8.1.3.1 第 3 条内层分桶那个坑的姊妹版）。
2. **只对平台通道计量**：`platform === false`（BYOK）**不计数**（用户自己付钱）；`platform === true && ownerId === null`（本地单人模式）**同样不计数**。
3. **时序＝先断言、后计数**：断言（`assertPlatformQuota`）在**拿并发槽之前**——额度用完的请求不该占着并发桶，否则会把正常用户挡在门外；计数（`recordPlatformUsage`）在**两层并发槽都拿到之后**——被闸门拒绝的请求**不计费**（用户没得到服务，凭什么扣次数）。★ 已知代价（刻意取舍）：同一用户并发 2 路时两路可能都通过断言、各记一笔，**最多超出 1~2 次**；为它加一把跨请求锁，收益（少扣 1 次）远小于代价（多一个死锁面）。

★ **实现接缝**：计数挂在 `llm/upstream-gate.ts#acquireUpstream`——那是「一笔上游请求确实要发出去了」的**唯一**时刻（两个适配器 `openai.ts`／`anthropic.ts` 的 `chat()` 都经过它）。挂在别处（路由层、flow 层）会漏掉后台任务，而 `extractTerms` 与 `compactIfNeeded` **恰恰是最容易被漏掉、且真花平台钱**的两笔。

⚠️ **已知边界（诚实记账）**：`platform_usage` 表随用户量增长（每用户每小时最多约 50 行、5 小时窗口内至多 250 行）；`recordPlatformUsage` 每次顺带清**本用户**已滑出窗口的旧行，故稳态下每用户行数有界，但**不做全表清理**——全表 `DELETE` 在用户量上来后会变成一把大锁。

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

> ★ **本表已按「是否跨用户撞键」重排并拆批**（2026-09-18 M2d-1 定案）。**判据不是习惯，是约束本身**：
> 一张表若它的 `PRIMARY KEY` / `UNIQUE` **包含一个全局取值列**（`key` / `name` / `day` / `(term, domain)`），
> 那它天然只允许「全站一条」⇒ 多用户必然互撞 ⇒ **必须重建**；主键是 uuid 的 ⇒ **加列即可**。

| 批 | 表 | 现有约束 | 改法 | 状态 |
|---|---|---|---|---|
| **M2d-1** | `app_settings` | `key` 单列 PK | ★ **重建** → `PK(owner_id, key)` | ✅ **已交付**（v0.2.62，迁移 v30） |
| **M2d-1** | `daily_activity` | `PK(day, type)` | ★ **重建** → `PK(owner_id, day, type)` | ✅ **已交付**（v0.2.62，迁移 v30） |
| **M2d-1** | `daily_summaries` | `day` 单列 PK | ★ **重建** → `PK(owner_id, day)` | ✅ **已交付**（v0.2.62，迁移 v30） |
| **M2d-1** | `user_stats` | `key` 单列 PK（存 `xp`） | ★ **重建** → `PK(owner_id, key)` | ✅ **已交付**（v0.2.62，迁移 v30） |
| **M2d-2** | `term_library` | `UNIQUE(term, domain)` | ★ **重建** → `UNIQUE(owner_id, term, domain)` | ✅ **已交付**（v0.2.63，迁移 v31） |
| **M2d-2** | `term_domain` | `name` 单列 PK | ★ **重建** → `PK(owner_id, name)` | ✅ **已交付**（v0.2.63，迁移 v31） |
| **M2d-2** | `term_mention_log` | `owner_id` **已存在**（v26） | ⚠️ **口径已对齐**：v31 把 `owner_id` 由可空改 `NOT NULL DEFAULT ''`；`mentionTrend` 的聚合改 `ownerForWrite`（原先未登录会**跨用户求和**） | ✅ **已交付**（v0.2.63，迁移 v31） |
| **M2d-3** | `quiz_bank` / `quiz_stats` / `quiz_notes` | 均以全局唯一 uuid 为主键 | **加列即可**（迁移 v33） | ✅ **已交付**（v0.2.67，2026-09-19） |
| **M2d-3** | `flow_def` / `flow_run`(+step) | id PK / 随会话 | **加列即可**（迁移 v33；`flow_step`/`flow_edge` 刻意不加列——恒经 `def_id` 触达，归属随 `flow_def` 传递，同 `messages` 不加 user_id 口径） | ✅ **已交付**（v0.2.67，2026-09-19） |
| **M2d-3** | `knowledge_node` / `knowledge_edge` | id PK | **加列即可**（迁移 v33）——★ 本行同时是**已上线旧洞的收口**：改前这两张表无任何归属过滤，A 的知识图谱 B 能看见（M2d-1 普查发现） | ✅ **已交付**（v0.2.67，2026-09-19） |
| ✅ 已做 | `token_usage` | — | 随 M2c（§8.1.2） | ✅ 已交付（v0.2.60，迁移 v29） |

★★ **M2d-1 定下的两条可复用口径**（M2d-2 / M2d-3 **照抄，不要重新发明**）：

1. **归属值取 `''`（无主 = 谁都看不见），不是 `NULL`**——与 §8.1 的 `providers`/`role_bindings`
   **刻意相反**：那里的 `NULL` = **平台通道 = 所有人可见**（免费额度是给全体用户用的）。
   同一个「没有主人」的处境，两组表的**可见性相反** ⇒ 取值必须不同。★ 若图省事统一，
   某个通用 `ownerFilter` 会把「孤儿不可见」**静默变成「全站可见」**（反向泄露）。
2. **单值/聚合读用 `ownerForWrite`，成批行读用 `ownerFilter`**——M2d 这组表的读形状是
   `SELECT value … .get()` 与 `SUM(count)`：若按 `ownerFilter` 的「`null` 就不加条件」处理，
   库里多行时 `.get()` 会返回**任意一行** ⇒ 未登录请求读到**某个用户**的设置/总结/XP（**静默串台**）。
   ★ **同型推演已在 M2d-2 兑现**：`term_library` 的 `countTerms` / `domainStats` 也是聚合读，v0.2.63 一律按 `ownerForWrite` 处理（不是重新发明——照抄本判据）。

★ **为什么 M2d-1 与 M2d-2 要分开交付**（不是"表数量少"）：v30 这四张表只有 **6 个源文件**，
而 `term_*` 是 **12 个源文件 + ~80 个 SQL 点**——**同类风险、不同爆炸半径**。分开才能让
「**没有漏掉某个查询点**」这个结论**真的能被验证**（本批要防的正是跨用户泄露，验证质量比批次整齐更重要）。
★ 该中间态**已于 v0.2.63 结束**：`term_*` 的代码与表结构一并归主（迁移 v31），登录用户不再能看见别人的词条。★ 当时判定「中间态安全」的理由是：`term_*` 一个字都没动，登录用户仍能看见别人的词条
——那是**改动前就有的状态**，不是 M2d-1 新造的洞（`SB_REQUIRE_AUTH` 未开）。

★ **`app_settings` 已落地（每用户一份）**（2026-09-18 老板原话「**变成每用户**」；v0.2.62 实现）。改前是 `key TEXT PRIMARY KEY, value TEXT` ——**全局一份**（出题配比 / 配图 / 回答方式偏好 / 搜索 key），而设置页那几个 PUT 是**全局写口** ⇒ **用户 A 改出题配比会改掉所有人的**（同 `role_bindings` 的隐患）。已改：主键 **`(owner_id, key)`**（`ALTER TABLE` 改不了主键 ⇒ 照 §7.1 的 `user_memory` 先例**重建表**）。★ 连带必改（**只改迁移不改这些 = 运行时 500**）：4 处 `ON CONFLICT(key)` 的冲突目标必须同步改成 `(owner_id, key)`，落点 `learning/quiz.ts` / `learning/quiz-image.ts` / `search/index.ts` / `storage/answer-style.ts`。★ 归属语义：`owner_id = ''` 为**无主**（本地单人模式的既有行），登录用户查不到。

---

## 9. 验收判据（★ 可实测）

1. **迁移**：v22 后 `sessions` 有 `user_id` 列 + `idx_sessions_user` 索引；v1~v22 连续无缺号。
2. **跨用户不可见**（e2e）：用户 A 建会话 → 用户 B 的 `GET /api/sessions` **不含**该会话；
   B 直接 `GET /api/sessions/:id/messages` → **404**。
3. **孤儿不可见**：无 owner 的老会话，对任何已登录用户都不出现在列表里，直接访问 → 404。
4. **`/chat/active` 隔离**：A 正在生成时，B 的 `/chat/active` 返回空数组。
5. **鉴权关闭时旧行为不变**：无登录态请求仍能列全量会话（不回归本地单人模式）。
6. **真机冒烟**：隔离实例 + 两个账号，逐条跑上述断言。
