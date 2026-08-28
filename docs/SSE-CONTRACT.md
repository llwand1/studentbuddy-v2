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
| `reasoning` | content | 推理过程增量（M1 仅流式呈现不落库） |
| `block` | blockId/payload/done | 结构化内容块（演进③；M2 起启用，payload 见 shared/content-blocks） |
| `step` | tool/status/detail | 工具执行进度：`running`（detail=入参摘要）→ `done`（detail=结果概览）/ `error`（detail=失败原因，不静默）；前端渲染为进度芯片，`done` 时清空 |
| `chat-error` | message | 本轮失败（用户中止为「已停止」） |
| `done` | usage? | 本轮收口；usage.source=provider/estimated |
| `ping` | — | 心跳 |

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

**已注册工具（单轨 function-calling，`chat/tools.ts`）**：`search_web` 一个；多路 provider 聚合语义见 `search/index.ts`（Exa/Tavily/智谱按 key 并行，三家全无 key → DuckDuckGo 免 key 兜底）。

**安全语义**：写操作（POST/PUT/DELETE）强制 Origin 校验（无 Origin / 恶意 Origin → 403）；请求体上限 2MB；服务仅绑 127.0.0.1。

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-23 | M1 首版（SSE/会话/发送/中止/服务商+角色绑定） |
| 2026-08-27 | `step` 事件随单轨工具循环上线（search_web）；新增 `/api/settings/search-keys`（GET/PUT）与 `/api/settings/search/test`；订阅回放语义收紧——已完结的一轮只补 `done`，修重复气泡 |
| 2026-08-27（复审） | 屏上==库内扩到收尾语（上限提示、中断标记均走 token）；失败轮补发终止 `done`；搜索 `providers` 只报真出结果的一家、缓存键含 provider 组合、自检跳缓存；PUT 先校验后写 + 单值 300 字上限；前端 `done` 判重（历史尾条同字不再追加）——真机 reload 复验单气泡 |
