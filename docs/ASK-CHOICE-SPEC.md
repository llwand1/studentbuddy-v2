# 方案选择框 · 契约（ASK-CHOICE-SPEC）

> 版本：v1.0 ｜ 状态：**已落地**（契约 / 后端 / 前端 / 提示词一次做完） ｜ 建立：2026-09-14
> 溯源：老板指示（2026-09-14）「ai 的方案选择框功能在 studentbuddyv2 也要做一个，这个对之后的功能开发很重要」
> 血缘：与 `ai-orchestrator-v2` 的 `docs/ask-choice-plan.md` **同一套契约与拍板口径**——形态 A（AI 主动提问式）、不设超时、自由输入出口默认开。两边不各写一套。
> 取证声明：本文所有 `file:line` 均为 2026-09-14 实读源码所得，非文档自述转抄。

---

## 0. 一句话

AI 走到决策岔路时主动问一句、给出 2~4 个方案，学习者在**输入框上方**点一下，AI 在**同一轮里**接着把活干完——不新开会话、不重发提问。

## 1. 形态

| 项 | 取值 | 说明 |
|---|---|---|
| 触发方 | AI 调 `ask_choice` 工具 | 模型自主判断「该问」；不是用户点按钮触发的固定流程 |
| 等待语义 | **阻塞、不设超时** | 工具内挂起，用户不选就一直等（老板拍板，与 orchestrator 一致） |
| 落点 | **输入框上方浮层** | 不进消息流、不动 `messages` 表（老板拍板）。同 `AskStyleCard` 的处置：不加遮罩、不新增 modal 基元 |
| 结果 | 回灌模型，**同轮继续** | 工具返回一行文本（「用户选择：X」），模型据此接着输出 |

### 与 ai-orchestrator-v2 的关键差异（为什么这边更简单）

那边的工具跑在 opencode 内核进程、与编排层**跨进程**，只能靠「内部端点 + 长轮询」等答复
（`apps/orchestrator/src/core/choice.ts` + `/api/internal/ask` 轮询）。
本仓工具与用户答复在**同一个 Node 进程**内，一个 resolver Map 就够了
（`packages/server/src/chat/choice.ts` 的 `waiters`）——少两条端点、少一圈轮询延迟。
契约本身（字段 / 边界 / 文案口径）保持同源。

## 2. 数据契约

单一事实源：`packages/shared/src/choice.ts`（server 与 web 都从这里取，禁止两侧双写）。

| 类型 | 用途 |
|---|---|
| `ChoiceOption { id, label, description? }` | 一个候选方案；`id` 由服务端按 `o1/o2/o3…` 生成，**模型传入的 id 一律忽略** |
| `AskChoiceRequest` | 提问（`id / sessionId / question / options / allowCustom / multi / ts`） |
| `AskChoiceReply` | 答复（`requestId / optionId \| null / custom? / ts`；走自由输入时 `optionId` 归 `null`，两者互斥） |
| `AskChoiceRecord` | 落库完整记录（请求 + `status` + `reply` + `answeredAt` + `cancelReason?`） |
| `ChoiceStatus` | `pending \| answered \| cancelled` |

边界常量（校验在 shared 的纯函数里做，前端同源引用，避免两侧各写一套魔数）：
`CHOICE_MIN_OPTIONS=2` / `CHOICE_MAX_OPTIONS=4` / `QUESTION_MAX=500` / `LABEL_MAX=120` / `DESC_MAX=300` / `CUSTOM_MAX=1000`。

`normalizeChoiceInput` / `normalizeChoiceReply` 返回 `{ok:false,error}` 而**不抛异常**：
调用方（工具）要把错误当可回灌文本交给模型自纠，抛出会中断整轮工具循环。

## 3. SSE 事件（已在 `packages/shared/src/sse-events.ts` 登记）

| 事件 | 载荷 | 语义 |
|---|---|---|
| `choice-asked` | `{ sessionId, request: AskChoiceRecord }` | 弹卡；前端按 `request.id` 幂等（重连回放会重复到达，覆盖而非入队两次） |
| `choice-replied` | `{ sessionId, requestId, reply }` | 切已选态。**不立即出队**——首 token 常有延迟，卡片凭空消失会让人以为没点成功 |
| `choice-cancelled` | `{ sessionId, requestId, reason }` | 切作废态（逃生口触发） |

归 `sessionId` 频道（与聊天事件同频道），**不经** `pk:` 那套前缀隔离：选择的答案直接续进这一轮对话。

## 4. 数据流

```
模型出 ask_choice 工具调用
  → runChoiceTool (chat/choice-tool.ts)          ← 超时豁免名单里，不受 30s 限制
  → askChoice (chat/choice.ts)
       ├ 校验归一（shared 纯函数）
       ├ 落库 ask_choices（status=pending）
       ├ 登记 waiter（先登记再广播，避免用户极速点选时丢唤醒）
       ├ publish choice-asked ────────────────→ 前端弹浮层
       └ await waiter ……（一直等）
用户点选
  → POST /api/choices/:id/reply (routes/choice.ts)
  → answerChoice：条件更新 WHERE status='pending'（并发双端点击的第二只手 → changes=0 → 409）
       ├ publish choice-replied ──────────────→ 前端切已选态
       └ 唤醒 waiter ───────────────────────→ runChoiceTool 返回「用户选择：X」
  → 工具结果回灌模型 → 模型在同一轮里继续输出
```

## 5. 逃生口（三条，全部是「事后可恢复」而非事前拦截）

| # | 触发 | 实现位置 |
|---|---|---|
| ① | **停止生成** | `chat/flow.ts` 的 `catch` 分支 → `cancelChoicesBySession(sessionId, '用户已停止生成')` |
| ② | **删会话** | `routes.ts` 的 `DELETE /sessions/:id` → `cancelChoicesBySession(id, '会话已删除')` |
| ③ | **进程重启** | `index.ts` 启动时 `sweepStaleChoices()` —— 内存 Promise 已随进程消失，库里 pending 永远等不到答复，不清就会变成前端能捞到、却怎么点都没反应的死卡 |

> 为什么必须有 ①：挂起的 `ask_choice` **不在 `signal` 的掐断路径上**——它等的是「人点一下」。
> 用户既然点了停止，就再没人会点那张卡。

## 6. 边界与本版未做（诚实记账）

| 项 | 现状 | 说明 |
|---|---|---|
| 答复留痕 | **不做** | 不往 `messages` 表补「用户选择：X」。原因：`messages` 既是对外历史、又是 LLM 上下文，插一条 user 消息会落在 `assistant(tool_calls)` 与它的 `tool` 结果之间，破坏 OpenAI 的消息配对约束。当前靠「工具回灌 + 浮层反馈 + AI 回答正文自然提及」三处承担。若日后要留痕，正确位置是**收口之后**（`persistRounds` 之后）追加，不是答复当刻 |
| 多选 `multi` | 字段已留、UI 未接 | 与 orchestrator 同口径：存储与契约按可多选设计，v1 恒 `false` |
| 卡片的会话归属 | 仅聊天页 | 契约与后端是通用的（任何工具都可调 `ask_choice`），但浮层目前只挂在 `ChatView` 的 composer 上；出题页 / 题库页要用时，复用 `ChoiceCard` + 一个容器即可 |
| 同会话并发提问 | 队列化 | 前端按数组存、只显示队首；后端每条独立，互不干扰 |
| 会话锁占用 | **已知代价** | 不设超时 ⇒ 用户走开不点，本轮一直占着 `flow.ts` 的同会话串行锁，下次回来须先「停止生成」。这是老板明确选择的取舍（与 orchestrator 一致） |

## 7. 验收判据（可复跑）

```bash
# 后端全量（含本功能新增用例）
cd packages/server && npx vitest run src/chat/choice.test.ts

# 门禁（AGENTS.md:22：server ≤400 行 / web 组件 ≤300 行）
wc -l packages/server/src/chat/*.ts packages/web/src/features/chat/*.tsx
```

真机判据：对 AI 说「帮我在几种复习方式里选一个」→ 输入框上方弹卡 → 点一项 → AI 在同一轮里
按该选择继续输出，且**没有**新起一轮。点「停止生成」时挂起的卡应切为作废态。
