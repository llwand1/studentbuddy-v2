# SSE / HTTP 接口契约（v2）

> 本文档定义 studentbuddy v2 前后端之间的**稳定接口契约**。
> 原则（继承 v1）：**任何新增前后端交互都先在 `packages/shared` 登记类型、在此登记语义，再实现**。
> 事件类型唯一事实源：`packages/shared/src/sse-events.ts`；本文档描述行为语义。

---

## 1. SSE 实时通道

**端点：** `GET /api/chat/stream?sessionId=<sid>&since=<n>`

- `Content-Type: text/event-stream`；每条消息 `data: <JSON>\n\n`。
- **按 sessionId 隔离**：服务端只推送该会话事件（无通配订阅——v1 串台教训）。
- **seq 单调去重**：每个入缓冲事件带按会话独立递增的 `seq`；断线后客户端携带已收最大 `seq` 作 `since` 重连，服务端只回放 `seq > since` 的事件（不重复消费 token）。
- **新一轮对话**（`POST /api/chat/send` 后）服务端缓冲清空、seq 从 1 重新计数；客户端同时重置 since=0。
- **回放只服务"进行中的一轮"**：缓冲里已出现 `done` 时，新订阅仅补该 `done`（让在看的连接收口），**不重放 token/step**——已落库的正文由 `GET /sessions/:id/messages` 权威提供，全量回放会让前端把同一答案二次上屏（2026-08-27 真机复现）。
- **流什么就存什么（逐字成立）**：服务端补进最终文本的每一段（轮间分隔、上限提示、中断标记）都同步作为 `token` 下发，故 `assistant.content` === 该轮 token 拼接；失败/中止同样收口（补 `done`，半截正文带标记落库，工具轮仍不落）。前端 `done` 据此判重：历史尾条与流式文本同字时不再追加（防 `/messages` 晚于落库返回时双份气泡）。
- **心跳**：每 15s 一条 `{ "type": "ping" }`（不占 seq、不进缓冲）；destroyed 连接自动移除。

**断线恢复（客户端 sse-client 实现）**：
1. `onerror` → 关闭连接 → 指数退避（1s→2s→4s…封顶 15s）重建连接（携带最新 since）；
2. 重连成功后如需完整状态，`GET /api/sessions/:id/live` 拉事件快照对齐。

**发送门控（修 v1 F1 竞态）**：`ready !== 'open'`（connecting/reconnecting）或生成中时，composer 禁发并显示状态提示——**绝不静默吞消息**。

## 2. 事件语义

| type | 载荷 | 语义 |
|------|------|------|
| `token` | content | 助手文本增量（前端按序追加） |
| `reasoning` | content | 推理过程增量。**2026-09-12 修订（v11）**：已随后续消息落库（`messages.reasoning` 列）并在重开会话时回放——原「仅流式呈现不落库」的说法作废；该列存原文，历史由 `web/features/chat/history-fold.ts` 折回那条回答 |
| `block` | blockId/payload/done | 结构化内容块（演进③；M2 起启用，payload 见 shared/content-blocks）。**2026-09-06 登记 `kind:'verdict'`**：认知进化判定块（COGNITIVE-EVOLUTION-SPEC §9.1），payload=`Verdict`（shared/domain，v1.1 含 `met`），`blockId='evo-<termId>-<ts>'`；由 flow 端 `[VERDICT]` 流式闸门吞掉正文后发射——判定块不上屏、不落 messages，「屏上文本==库内文本」铁律不破 |
| `step` | tool/status/detail/args?/result? | 工具执行进度：`running`（detail=入参摘要）→ `done`（detail=结果概览）/ `error`（detail=失败原因，不静默）；前端渲染为过程卡片。**2026-09-09 增强**：终态事件附 `args`（工具入参原文 JSON 串）与 `result`（结果摘要截 ~400 字），前端点击卡片展开查看输入/输出；终态由 tool-exec 调度器统一发射（每张卡片有且只有一个终态）。生成完成后 steps 不再清空（与 reasoning 同策略），清空点在下一轮 send/regenerate 与切会话 |
| `tasks` | items | **2026-09-09 登记（标准 CoT 任务清单）**：模型经 `update_tasks` 工具（不在 tools.ts 注册表，flow.ts exec 注入接入）。**2026-09-12 修订**：items 恒为**服务端合并后的完整清单** `TaskItem[]`（三态 `pending`/`in_progress`/`done`，≤10 条，类型单一事实源＝`shared/src/task-list.ts`）；模型入参有两种模式（`tasks` 全量覆盖 / `updates` 按 1 基序号增量），**合并永远在服务端做**，事件侧只有「全量下发」一种语义——前端仍整表替换、不做本地合并；前端渲染为打勾进度面板（n/m 计数，`in_progress` 当前条目高亮转环），全部完成后默认收起、done 后保留可回看 |
| `chat-error` | message | 本轮失败（用户中止为「已停止」） |
| `done` | usage? | 本轮收口；usage.source=provider/estimated |
| `ping` | — | 心跳 |

### 2.1 PK 频道事件（AI 出题双人对战，契约 `docs/PK-SPEC.md` §2.2）

**频道键：** `pk:<roomId>`（`shared/pk.ts` 的 `pkChannel()`，前端订阅用同一函数、不手抄前缀）。
★ 与上面的 `sessionId` **不是同一个命名空间**——两者共用 sse-bus 实现，**只有前缀能防串台**（v1 教训）。
故本组事件用 `roomId` 字段而非 `sessionId`：字段名不同，才不会有人把房间号当会话 ID 传进聊天通道。

| type | 载荷 | 语义 |
|------|------|------|
| `pk-state` | roomId / state | 房间状态变化（建房 / 入房 / 开局 / 结束）。**P0-1 已实现**：建房、入房、start 各主动广播一次 |
| `pk-question` | roomId / question | 新题到达（载荷本就无 answer）。**待 P0-2** |
| `pk-verdict` | roomId / questionId / correct / delta / score | 某题判分结果（含超时判罚）。**待 P0-2** |
| `pk-end` | roomId / winner? / state | 结算。**待 P0-2** |

- seq 单调去重 / 15s 心跳 / 断链回收与聊天通道**同机制**（同一 sse-bus），但缓冲按频道键独立。
- **订阅前服务端先验房间是否存在**，否则 404——好过让前端挂一条永远安静的长连接。
- **载荷永不含正确答案**（契约 §1 硬约束）：判分权只在服务端，`PkQuestion` 类型层面就没有 `answer` 字段。

## 3. REST 端点（M1）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | `{ hasProviders, version }` |
| GET | `/api/health` | `{ ok }` |
| GET/POST | `/api/sessions` | 会话列表 / 新建（软删除：DELETE `/:id`） |
| GET | `/api/sessions/:id/messages` | 历史消息（含 tool 角色原文） |
| GET | `/api/sessions/:id/live` | 事件缓冲快照（重连对齐） |
| POST | `/api/chat/send` | `{ sessionId, text }`；异步执行，流走 SSE |
| POST | `/api/chat/abort` | 中止该会话生成（AbortSignal 桥接至底层 fetch） |
| GET/POST/PUT/DELETE | `/api/providers` | 服务商 CRUD（api_key 密文入库，**永不出现在响应**） |
| GET | `/api/providers/roles` | 五角色定义 + 当前绑定 |
| PUT | `/api/providers/roles/:role` | `{ providerId, model }` 角色绑定（演进①） |
| GET | `/api/settings/search-keys` | `{ configured: { exa, tavily, zhipu } }` — **只回布尔**，明文与密文都不出响应 |
| PUT | `/api/settings/search-keys` | `{ exa?, tavily?, zhipu? }` 存 key（AES-GCM 密文入库）；空串=删除；非 string 字段忽略；单值上限 300 字符——**先全量校验再落库**，任一超限 → 400 且一字不写（无半写） |
| POST | `/api/settings/search/test` | `{ query? }` 真发一次连通性自检（跳过 24h 缓存，保证"真发"）→ `{ ok, count, providers, failed }`（query 截 80 字，providers 只列真出结果的来源，响应不含密钥） |
| GET | `/api/doc?sessionId=` | 文档模式：读该会话当前资料元信息 → `{ doc: { name, chars, truncated } | null }`。**永不回原文**（正文只在 POST 时过一次网络，前端刷新重绘不需要 60k 文本）；缺 `sessionId` → 400 |
| POST | `/api/doc` | `{ sessionId, name?, text }` 载入/整篇替换该会话的资料 → `{ doc: DocMeta }`。`text` 空/纯空白 → 400；会话不存在 → 404。**不落盘**（进 `sessions.doc_text`，故无 multer/上传目录/路径穿越面）；**扩展名不在此校验**（粘贴文本本无文件名，txt/md 约束留在 UI 的 `accept`） |
| DELETE | `/api/doc?sessionId=` | 清除该会话资料（两列置 NULL，不碰标题与消息）→ `{ ok: true }`；会话不存在 → 404 |

### 3.1 此前漏登的端点（2026-09-02 对账补登，非本批新增）

> 本节表头原为「REST 端点（M1）」，只登了 M1 的接口；M2/M3 与预览/活动的路由一直未登记，属 §0.11 漂移，按代码实况补如下（语义以源码为准，此处只做索引）。

| 前缀 | 路由文件 | 端点 |
|------|----------|------|
| `/api/quiz` | `routes/quiz.ts` | `POST /generate`（`{topic?,material?,sessionId?}`，`topic` 与 `material` 至少给一个否则 400；**`material` 缺省时回退用该会话已载入的资料**）、`GET /bank`、`GET /bank/:id`、`DELETE /bank/:id`、`POST /stats/record`、`GET /analyze/:id` |
| `/api/terms` | `routes/terms.ts` | `GET /`、`GET /domains`、`POST /`、`POST /extract`（`{text?,sessionId?}`，`text` 缺省时同样回退会话资料）、`PUT /:id`、`DELETE /:id` |
| `/api/preview` | `routes/preview.ts` | `POST /`（暂存 html 换 id）、`GET /:id`（带 `CSP: sandbox` 出页，无 `allow-same-origin`） |
| `/api/activity` | `routes/activity.ts` | `GET /today`、`GET /week`、`GET /summary` |

### 3.2 PK 端点（P0-1，契约 `docs/PK-SPEC.md`）

> 前缀 `/api/pk`（`routes/pk.ts`）。写操作同样过 Origin 闸门；**所有端点只认服务端账号**——
> `userId` 必须命中 `pk_users`，否则 401。房内显示名从库里取，**不信客户端自报**（防冒名）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/pk/auth/login` | `{ nickname, userId? }` → `PkIdentity`。**P0 模拟实现**（`openid = mock_<userId>`）；携已有 userId = 找回账号并可改名，不命中则新建。P1 换微信公众号网页授权后**响应结构不变、前端零改动** |
| GET | `/api/pk/auth/me?userId=` | 本地登录态校验（前端启动时过一遍）；账号不存在 → 404，前端据此清 localStorage |
| POST | `/api/pk/rooms` | `{ userId }` → `{ roomId, roomCode, state }`（201）。**幂等**：已在某 waiting 房则返回原房而不新建。房号 6 位数字 |
| POST | `/api/pk/rooms/join` | `{ roomCode, userId }` → `{ roomId, state }`。房不存在 404／满员 409／已开局 409；**重复入同一间房幂等**；入房成功会把自己从其它 waiting 房摘掉 |
| POST | `/api/pk/rooms/:id/start` | `{ userId }` 仅房主（`players[0]`）。双方已进房 → `active`、`endsAt = 服务端 now + 8 分钟`。非房主 403／对手未到 409／重复开局 409 |
| GET | `/api/pk/rooms/:id/state` | 房间快照（断线重连对齐用）；不存在或已被 TTL 回收 → 404 |
| GET | `/api/pk/stream?roomId=&userId=&since=` | 房间 SSE 频道，语义见 §2.1 |

- **错误体统一**：域层抛错误码，薄路由映射状态码与文案，响应为 `{ error, code }`（如 `code: 'ROOM_FULL'`）。
  域错误码 → 状态：`ROOM_NOT_FOUND` 404／`ROOM_FULL`·`ROOM_NOT_WAITING`·`ROOM_NOT_READY` 409／`NOT_ROOM_OWNER` 403／
  `ROOM_CODE_EXHAUSTED` 500。映射表只此一处（`routes/pk.ts`），域层不碰 HTTP。
- **P0 存储是全内存**（契约 §4）：无落库、无 schema 改动，进程重启即丢局；房间 TTL 惰性回收
  （waiting 30 分钟 / finished 10 分钟 / active 取「对局时钟 + 保留期」）。

**已注册工具（单轨 function-calling，`chat/tools.ts`）**：`search_web` 一个；多路 provider 聚合语义见 `search/index.ts`（Exa/Tavily/智谱按 key 并行，三家全无 key → DuckDuckGo 免 key 兜底）。

**安全语义**：写操作（POST/PUT/DELETE）强制 Origin 校验（无 Origin / 恶意 Origin → 403）；请求体上限 2MB；服务仅绑 127.0.0.1。

**适配器契约（多段 `system`）**：`chat/flow.ts` 依次 push 基础提示词 / 忆域词条段 / 文档模式资料段——`system` 可以有多条且语义不同。适配器**必须合并全部** system 后下发：`llm/anthropic.ts` 曾用 `find()` 只取第一条，导致 Anthropic 型服务商上词条与资料静默失效（**B-001**，2026-09-02 修，回归锁在 `llm/anthropic.test.ts` 断言出站 `body.system` 同时含两段）。新增 Provider 必须补同一条出站体断言。

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-23 | M1 首版（SSE/会话/发送/中止/服务商+角色绑定） |
| 2026-08-27 | `step` 事件随单轨工具循环上线（search_web）；新增 `/api/settings/search-keys`（GET/PUT）与 `/api/settings/search/test`；订阅回放语义收紧——已完结的一轮只补 `done`，修重复气泡 |
| 2026-08-27（复审） | 屏上==库内扩到收尾语（上限提示、中断标记均走 token）；失败轮补发终止 `done`；搜索 `providers` 只报真出结果的一家、缓存键含 provider 组合、自检跳缓存；PUT 先校验后写 + 单值 300 字上限；前端 `done` 判重（历史尾条同字不再追加）——真机 reload 复验单气泡 |
| 2026-09-02 | 新增文档模式三端点 `GET/POST/DELETE /api/doc`（只回元信息、正文不落盘、会话绑定）；补登 §3.1 此前漏登的 quiz/terms/preview/activity 路由；加**多段 system 必须全量合并**的适配器契约（B-001 教训） |
| 2026-09-06 | 认知进化 v1.1 契约登记（WBS 任务 1）：`BlockKind` 增 `'verdict'`（payload=Verdict 含 `met`）；`DomainEvent` 增 `evolution_levelup`（server/events/bus.ts）；shared/domain.ts 落 `Verdict`/`EvolutionTermState`/`EvolutionState`/`EvolutionEventRow` 四类型 |
| 2026-09-12 | **PK 频道登记**（契约 `docs/PK-SPEC.md` P0-1）：`pk-state`/`pk-question`/`pk-verdict`/`pk-end` 四事件进 `shared/sse-events.ts`——字段用 `roomId`（不是 `sessionId`），频道键 `pk:<roomId>`，与聊天空间严格隔离；新增 §2.1（频道语义）与 §3.2（登录+房间端点含错误码映射）。P0-1 实际只发 `pk-state`，后三个按契约先登记、待 P0-2 启用 |
