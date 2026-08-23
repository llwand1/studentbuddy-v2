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
| `step` | tool/status/detail | 工具执行步骤（单轨工具注册表，M2 起） |
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

**安全语义**：写操作（POST/PUT/DELETE）强制 Origin 校验（无 Origin / 恶意 Origin → 403）；请求体上限 2MB；服务仅绑 127.0.0.1。

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-23 | M1 首版（SSE/会话/发送/中止/服务商+角色绑定） |
