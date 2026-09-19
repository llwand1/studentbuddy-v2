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

**断线恢复（客户端 sse-client 实现，2026-09-13 两半全接通）**：
1. `onerror` → 关闭连接 → 指数退避（1s→2s→4s…封顶 15s）重建连接（携带最新 since）；
2. 重连成功后 `GET /api/sessions/:id/live` 拉事件快照对齐（此前只有服务端半边，前端从未调用）；
   快照与重连回放的重叠帧由 **seq 单调去重在事件入口处拦死**（`ev.seq <= since` 直接丢弃）——
   客户端此前只前移 since 不拦旧帧，重叠时同一 token 帧会进回调两次（文字翻倍），v13 起在入口拦死。

**回答呈现形态（2026-09-13 对话体验升级）**：SSE 事件契约不变（无新事件类型），形态由 provider 的
`stream_mode` 决定——`'stream'`（原生 AI）逐字 token 全过程；`'once'`（池中 AI）适配器发非流式请求、
完整答案作为一个 token 帧整块下发，「流什么就存什么」铁律照旧成立（落库口径零改动），前端首 token
前的空窗即「思考中」等待态（`Thinking` 组件：轮播短语 + 已用时）。

**发送门控（修 v1 F1 竞态）**：`ready !== 'open'`（connecting/reconnecting）或生成中时，composer 禁发并显示状态提示——**绝不静默吞消息**。

## 2. 事件语义

| type | 载荷 | 语义 |
|------|------|------|
| `token` | content | 助手文本增量（前端按序追加） |
| `reasoning` | content | 推理过程增量。**2026-09-12 修订（v11）**：已随后续消息落库（`messages.reasoning` 列）并在重开会话时回放——原「仅流式呈现不落库」的说法作废；该列存原文，历史由 `web/features/chat/history-fold.ts` 折回那条回答 |
| `block` | blockId/payload/done | 结构化内容块（演进③；M2 起启用，payload 见 shared/content-blocks）。**2026-09-06 登记 `kind:'verdict'`**：深度理解判定块（DEEP-UNDERSTANDING-SPEC §9.1），payload=`Verdict`（shared/domain，v1.1 含 `met`），`blockId='evo-<termId>-<ts>'`；由 flow 端 `[VERDICT]` 流式闸门吞掉正文后发射——判定块不上屏、不落 messages，「屏上文本==库内文本」铁律不破 |
| `step` | tool/status/detail/args?/result? | 工具执行进度：`running`（detail=入参摘要）→ `done`（detail=结果概览）/ `error`（detail=失败原因，不静默）；前端渲染为过程卡片。**2026-09-09 增强**：终态事件附 `args`（工具入参原文 JSON 串）与 `result`（结果摘要截 ~400 字），前端点击卡片展开查看输入/输出；终态由 tool-exec 调度器统一发射（每张卡片有且只有一个终态）。生成完成后 steps 不再清空（与 reasoning 同策略），清空点在下一轮 send/regenerate 与切会话。**2026-09-18 v1.3 扩展（已登记，P1 落地）**：终态帧新增 `toolCallId`（同名并行调用按 id 配对，替代「name+running 倒扫」）、`durationMs`（**服务端实测**执行耗时，随消息落库、历史回放同值——计时不用前端掐表也不蹭 AG-UI 时间戳，依据逐条见 `TOOL-ECOSYSTEM-SPEC.md` §4.7）、`errorText`（error 终态人读错误，与 `result` 互斥）；`preliminary`（长工具中间输出）先行登记、P4 启用 |
| `tasks` | items | **2026-09-09 登记（标准 CoT 任务清单）**：模型经 `update_tasks` 工具（不在 tools.ts 注册表，flow.ts exec 注入接入）。**2026-09-12 修订**：items 恒为**服务端合并后的完整清单** `TaskItem[]`（三态 `pending`/`in_progress`/`done`，≤10 条，类型单一事实源＝`shared/src/task-list.ts`）；模型入参有两种模式（`tasks` 全量覆盖 / `updates` 按 1 基序号增量），**合并永远在服务端做**，事件侧只有「全量下发」一种语义——前端仍整表替换、不做本地合并；前端渲染为打勾进度面板（n/m 计数，`in_progress` 当前条目高亮转环），全部完成后默认收起、done 后保留可回看 |
| `choice-asked` | sessionId / request | **2026-09-14 登记（方案选择框，契约 `docs/ASK-CHOICE-SPEC.md`）**：AI 调 `ask_choice` 工具请求学习者拍板，UI 在输入框上方弹浮层。`request` 为 `AskChoiceRecord`（唯一事实源 `shared/choice.ts`）。前端按 `request.id` 幂等——断线重连会回放同一帧，覆盖而非二次入队。归 `sessionId` 频道，**不经** `pk:` 前缀隔离 |
| `choice-replied` | sessionId / requestId / reply | 答复已落库（本端点的答复、别的客户端的答复都走这条路——服务端是唯一事实源）。前端切已选态但**不出队**：首 token 常有延迟，卡片凭空消失会让人以为没点成功 |
| `choice-cancelled` | sessionId / requestId / reason | 提问作废（逃生口：停止生成 / 删会话 / 进程重启清理，见 SPEC §5）。前端切作废态如实告知，不静默消失 |
| `chat-error` | message | 本轮失败（用户中止为「已停止」） |
| `done` | usage? / thinkingMs? | 本轮收口；usage.source=provider/estimated。**2026-09-19 P1 扩展**：`thinkingMs`＝服务端实测的**本轮思考耗时**（起点＝首个 reasoning 分片发出，终点＝首个正文分片发出，无正文则收口时刻；未出过思考分片则不带该字段）。落库先于本帧发布 ⇒ done 携带的是**已入库的同一事实**（`messages.thinking_ms`），前端收口直接用、不本地掐表（口径依据 `TOOL-ECOSYSTEM-SPEC.md` §4.7，反面教材＝LobeChat 断线重连丢起点） |
| `round-start` | startedAt | **2026-09-19 登记（P0.5 热修，B-009）**：`flow.ts` 在 `startNewRound` 后发布的首帧，`startedAt`＝服务端 `Date.now()`。前端「思考中」已用时的**唯一基准**——组件挂载时刻 ≠ 轮开始时刻，切会话/重挂靠回放本帧续表、不从头起（服务只绑 127.0.0.1，同机时钟直减成立）。已知边界：缓冲 60s TTL 回收后无帧可回放，计时退回重挂时刻起算（与回放超时同口径）；督促/PK 频道**不发**该帧 |
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

### 2.2 督促频道事件（复习督促小窗，契约 `docs/COACH-SPEC.md` / `docs/MEMORY-TREND-SPEC.md` §4.4）

**频道键：** `coach:<owner>`（`shared/coach.ts` 的 `coachChannel()`，前端订阅用同一函数、不手抄前缀）。
★ 与聊天 `sessionId`、PK 的 `pk:` **三向严格隔离**——三者共用同一套 sse-bus，**只有前缀能防串台**（v1 教训）。
本组事件沿用 `sessionId` 字段名承载频道键：督促是**另一条链路**，不属任何会话（`routes/coach.ts` 文件头）。

| type | 载荷 | 语义 |
|------|------|------|
| `token` / `done` / `chat-error` | 同 §2 | 督促对话的流式帧（同一 sse-bus，缓冲按频道键独立；督促**一轮结束后可以再开一轮**，故 `acceptSeq` 的「`seq===1` 即换轮」在这条链路上是必需项——B-007） |
| `coach-card` | sessionId / card | **2026-09-18 登记（记忆联动 P4）**：服务端**定时后台生成**一张趋势卡后主动推给前端，前端据此在胶囊旁冒一个小气泡（「你的近期学习趋势生成了！」）。`card` ＝ `CoachTrendCard`（唯一事实源 `shared/coach.ts`：`windowDays` / `labels` / `values` / `topDomains` / `topTerms` / `summary` / `summarySource`）。★ **只对 `trend` 卡发**——`nudge` 的红点语义已经在胶囊上，两者叠加会让胶囊同时"报数 + 报消息"，用户分不清哪个更急（契约 §4.4 末条）。★ 生成失败/不足时**不发**该事件（安静 ≠ 报错：全 0 的图是负价值） |

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
| GET | `/api/choices?sessionId=` | **2026-09-14 新增（方案选择框）**：挂起中的提问清单，前端加载会话/重连后捞回浮层卡片用（无挂起 → `[]`；缺 `sessionId` → 400）。存在的理由：挂起态在后端是内存 Promise、SSE 缓冲 60s 无订阅即回收，重开页面后回放流可能已空，只有查库才恢复得出来 |
| POST | `/api/choices/:id/reply` | `{ optionId?, custom? }` 至少给一个。**404** 提问不存在／**409** 已被答复或作废（并发双端点击的第二只手，不覆盖首答）／**400** 参数不合法（选项不属于本条 / `custom` 超 1000 字 / 本条未开放自由输入）。状态码由 `chat/choice.ts` 给出，路由只透传 |

### 3.1 此前漏登的端点（2026-09-02 对账补登，非本批新增）

> 本节表头原为「REST 端点（M1）」，只登了 M1 的接口；M2/M3 与预览/活动的路由一直未登记，属 §0.11 漂移，按代码实况补如下（语义以源码为准，此处只做索引）。

| 前缀 | 路由文件 | 端点 |
|------|----------|------|
| `/api/quiz` | `routes/quiz.ts` | `POST /generate`（`{topic?,material?,sessionId?}`，`topic` 与 `material` 至少给一个否则 400；**`material` 缺省时回退用该会话已载入的资料**）、`GET /bank`、`GET /bank/:id`、`DELETE /bank/:id`、`POST /stats/record`、`GET /analyze/:id`（**响应形状 `WeakAnalysis` 见 `docs/QUIZ-WEAK-SPEC.md` §2**——本表只做索引，形状以契约为准） |
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
| POST | `/api/pk/rooms/:id/start` | `{ userId }` 仅房主（`players[0]`）。双方已进房 → `active`、`endsAt = 服务端 now + 8 分钟`。非房主 403／对手未到 409／重复开局 409；PVE 房 AI 座位已占、房主可直接开。成功后启动 1s ticker（超时/怠慢/结算/AI 出题统一时间驱动，无 active 房自停） |
| POST | `/api/pk/rooms/:id/quiz` | `{ userId, prompt }` → `{ state }`。先落 CD 并广播（前端立刻见倒计时）→ AI 生成 → 成功建题出题人 +1；CD 内 429 不扣分；生成失败 502 且 **CD 已回滚＝免费重试**。PVE 时题发给 AI 并触发其答题 |
| POST | `/api/pk/rooms/:id/answer` | `{ userId, questionId, choice }` → `{ correct, delta, score }` 即时判分（+2/−1）；已答/超时 409、别人的题 403、选项越界 400 |
| GET | `/api/pk/rooms/:id/state` | 房间快照（断线重连对齐用）；不存在或已被 TTL 回收 → 404 |
| GET | `/api/pk/stream?roomId=&userId=&since=` | 房间 SSE 频道，语义见 §2.1 |

- **错误体统一**：域层抛错误码，薄路由映射状态码与文案，响应为 `{ error, code }`（如 `code: 'ROOM_FULL'`）。
  域错误码 → 状态：`ROOM_NOT_FOUND` 404／`ROOM_FULL`·`ROOM_NOT_WAITING`·`ROOM_NOT_READY` 409／`NOT_ROOM_OWNER` 403／
  `ROOM_CODE_EXHAUSTED` 500。映射表只此一处（`routes/pk.ts`），域层不碰 HTTP。
- **P0 存储是全内存**（契约 §4）：无落库、无 schema 改动，进程重启即丢局；房间 TTL 惰性回收
  （waiting 30 分钟 / finished 10 分钟 / active 取「对局时钟 + 保留期」）。

**已注册工具（单轨 function-calling，`chat/tools.ts`）**：`search_web`（多路 provider 聚合语义见 `search/index.ts`——Exa/Tavily/智谱按 key 并行，三家全无 key → Bing 免 key 兜底（cn.bing.com，RSS 主 + HTML 兜底））、`tidy_terms` / `manage_terms`（词条库）、`ask_choice`（**方案选择框**，契约 `docs/ASK-CHOICE-SPEC.md`）。★ `ask_choice` 是**长等待工具**：它在 `flow.ts` 的 `runToolCalls` 里登记进 `noTimeout`，豁免 30s 默认工具超时——它等的是「人点一下」，挂 timer 会把等待本身掐死（见 `chat/tool-exec.ts` 的 `noTimeout` 注释）。

**安全语义**：写操作（POST/PUT/DELETE）强制 Origin 校验（无 Origin / 恶意 Origin → 403）；请求体上限 2MB；服务仅绑 127.0.0.1。

**适配器契约（多段 `system`）**：`chat/flow.ts` 依次 push 基础提示词 / 忆域词条段 / 文档模式资料段——`system` 可以有多条且语义不同。适配器**必须合并全部** system 后下发：`llm/anthropic.ts` 曾用 `find()` 只取第一条，导致 Anthropic 型服务商上词条与资料静默失效（**B-001**，2026-09-02 修，回归锁在 `llm/anthropic.test.ts` 断言出站 `body.system` 同时含两段）。新增 Provider 必须补同一条出站体断言。

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-19 | **P1 计时呈现批**：`done` 帧扩展 `thinkingMs`（服务端实测本轮思考耗时，落库先于发布 ⇒ 线上值与库内值同源，见 §2 该行）；`step` 帧 2026-09-18 登记的 `toolCallId`/`durationMs`/`errorText` 三字段**由登记转已落码**（tool-exec 调度器统一发射，flow/grill 两消费面自动透传；`preliminary` 仍留 P4）。落库面：`messages` 加 `thinking_ms`（assistant 行）与 `duration_ms`（tool 行）两列（迁移 v32，`ADD COLUMN` 型）——§4.7 判据「刷新/切会话后耗时数字不变」的事实源从流帧换成库行 |
| 2026-09-19 | **P0.5 热修批（B-009）**：§2 登记 `round-start` 帧（轮起点=服务端时刻，每轮缓冲第一帧、随回放恢复计时基准）。实现同批落地：`flow.ts` 发布 + 前端 `useChatStream`/`Thinking` 改吃该基准（切会话清基准，本地 `Date.now()` 仅兜底）。回归锁：`sse-bus.test.ts` +1（回放首帧必是 round-start）、`flow.test.ts` +2（成功轮/失败轮均发帧）。P1 的落库耗时（TOOL-ECOSYSTEM-SPEC §4.7）踩这份基准做，不重复施工 |
| 2026-09-18 | **工具生态 v1.3 契约登记（P0-b，未动实现）**：`step` 帧新增 `toolCallId`/`durationMs`/`errorText`/`preliminary`（`shared/sse-events.ts` 同步）；计时口径定档「服务端测差值+落库」；单工具超时改 per-tool 按 kind 分档（read/write 30s / network·external 60s / 内部调 LLM 的工具 120s，原「network 15s」草案作废，`ask_choice` 豁免照旧）；文件工具 `read_file`/`write_file` 申请式沙箱立项（`path_grants` 持久授权）。细则与证据全部在 `docs/TOOL-ECOSYSTEM-SPEC.md` v1.3（§4.2/§4.7/§5.2/§10） |
| 2026-09-18 | **督促趋势卡**（契约 `docs/MEMORY-TREND-SPEC.md` §4）：新增 SSE 事件 `coach-card`（归 `coach:<owner>` 频道，与 `sessionId`/`pk:` 三向隔离）+ 新增 §2.2 督促频道事件小节（此前 `token`/`done`/`chat-error` 三条共用事件一直未在本文件登记，本次一并补登）。载荷 `card` ＝ `CoachTrendCard`（结构化数据，**不是 SVG 字符串**：窗口改天数/换主题/导出数据表都不该让模型重画一遍）。服务端由 `learning/trend.ts` 定时生成（每 6 小时检查、每天最多一张、窗口内提及 < 3 次不出卡），模型只写一句摘要且**失败仍出卡**（`summarySource:'fallback'`） |
| 2026-09-14 | **方案选择框**（契约 `docs/ASK-CHOICE-SPEC.md`）：新增 3 个 SSE 事件（`choice-asked` / `choice-replied` / `choice-cancelled`，归 `sessionId` 频道）+ 2 个端点（`GET /api/choices`、`POST /api/choices/:id/reply`）+ `ask_choice` 工具（**长等待**：在 `flow.ts` 的 `runToolCalls` 里登记 `noTimeout`，豁免 30s 默认工具超时）；迁移 v14 建 `ask_choices` 表；已注册工具清单同步更新 |
| 2026-08-23 | M1 首版（SSE/会话/发送/中止/服务商+角色绑定） |
| 2026-08-27 | `step` 事件随单轨工具循环上线（search_web）；新增 `/api/settings/search-keys`（GET/PUT）与 `/api/settings/search/test`；订阅回放语义收紧——已完结的一轮只补 `done`，修重复气泡 |
| 2026-08-27（复审） | 屏上==库内扩到收尾语（上限提示、中断标记均走 token）；失败轮补发终止 `done`；搜索 `providers` 只报真出结果的一家、缓存键含 provider 组合、自检跳缓存；PUT 先校验后写 + 单值 300 字上限；前端 `done` 判重（历史尾条同字不再追加）——真机 reload 复验单气泡 |
| 2026-09-02 | 新增文档模式三端点 `GET/POST/DELETE /api/doc`（只回元信息、正文不落盘、会话绑定）；补登 §3.1 此前漏登的 quiz/terms/preview/activity 路由；加**多段 system 必须全量合并**的适配器契约（B-001 教训） |
| 2026-09-06 | 深度理解 v1.1 契约登记（WBS 任务 1）：`BlockKind` 增 `'verdict'`（payload=Verdict 含 `met`）；`DomainEvent` 增 `evolution_levelup`（server/events/bus.ts）；shared/domain.ts 落 `Verdict`/`EvolutionTermState`/`EvolutionState`/`EvolutionEventRow` 四类型 |
| 2026-09-13 | **对话体验升级**：断线恢复第 2 步（/live 快照）接通 + seq 去重入口拦死；呈现形态语义登记（stream/once，见上）；新增 `POST /api/chat/resend`（编辑重发：更新最后一条提问内容并作废其后产物后重跑，与 regenerate 同 rowid 划界）；`GET /api/providers/:id/models` 暴露适配器 `listModels`；停止生成 signal 透传进工具内部（search 真掐断） |
| 2026-09-12 | **PK 频道登记**（契约 `docs/PK-SPEC.md` P0-1）：`pk-state`/`pk-question`/`pk-verdict`/`pk-end` 四事件进 `shared/sse-events.ts`——字段用 `roomId`（不是 `sessionId`），频道键 `pk:<roomId>`，与聊天空间严格隔离；新增 §2.1（频道语义）与 §3.2（登录+房间端点含错误码映射）。P0-1 实际只发 `pk-state`，后三个按契约先登记、待 P0-2 启用 |
