# 方案选择框 · 契约（ASK-CHOICE-SPEC）

> 版本：v1.2 ｜ 状态：**已落地 + 下一档已做**（契约 / 后端 / 前端 / 提示词一次做完；2026-09-16 追加 **grill-me 模式**＝§7「触发率」那一档的兑现；2026-09-17 追加 **多轮拍板 + ABCD 选项形态**＝§10） ｜ 建立：2026-09-14 ｜ 升版：2026-09-17
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

## 6. 触发机制（模型为什么会调 / 为什么不调）

> **本功能是「AI 主动调用」，所以「做完了」和「会用」是两件事。**
> 上线后实测：工具已注册、两个适配器都带 `tools`、超时已豁免——但模型几乎不调。

**根因**：`tool_choice='auto'` 下模型有完全自由，而助手的出厂倾向是**直接把答案讲完**；
系统提示里「遇到岔路时用 ask_choice」属于**原则性描述**，模型没法把它映射到具体句子，于是退化成永不调用。
工程链路没问题，问题在**触发条件太软**。

**三层触发（逐层加码，缺一层触发率就塌）**

| 层 | 位置 | 作用 |
|---|---|---|
| ① 原则 | `chat/system-prompt.ts` | 把原则写成**可匹配的 4 类场景**（二选一／深度篇幅分歧／计划类／表达犹豫）+ 时序要求 |
| ② 工具描述 | `chat/choice-tool.ts` | 正面表述 + 一个具体示例；**否定条款只留必要的** |
| ③ 硬提醒 | `chat/choice-nudge.ts` | 用户消息命中选择/规划词表 → 首轮注入「**必须先调 ask_choice**」，**首轮结束即摘** |

> ①②改的是模型「想不想调」，③改的是模型「看到的输入」。
> 只靠①②在 `auto` 模式下不够——模型的默认路径仍是直接作答，③才是真正把它推过门槛的那一下。

**③ 的设计红线（改词表前必读）**

- **宁可漏，不可误**：误弹一次（用户只想听讲解却被迫选）比漏弹十次更伤体验。
  故只收**几乎必然是选择/规划**的强信号，并用排除表拦掉求讲解／排错／追问态。
- **首轮结束必须摘掉**（`flow.ts` 里 `turn === 0` 后 splice）：留着会误导后续轮
  （用户说「把第二个方案展开讲讲」时又问一次），问第二次比不问更糟。
- **漏弹同样要盯**：`还是`（"按概念还是按题型"）是最强二选一结构，不收就漏掉大半真实岔路。
  两种偏误都要有用例钉住——见 `src/chat/choice.test.ts` 的 `触发增强 choiceNudge` 组。
- 词表会随实测反复调，故做成**纯函数零 IO**，改完 `npx vitest run src/chat/choice.test.ts` 即验。

> 调词表的判据是**老板目检**：发一句「先学 A 还是 B」「帮我定个复习计划」看是否弹框；
> 再发一句「什么是动态规划」确认**不弹**。目前**未做触发率量化**（无真机回归）。

## 7. 边界与本版未做（诚实记账）

| 项 | 现状 | 说明 |
|---|---|---|
| 答复留痕 | **不做** | 不往 `messages` 表补「用户选择：X」。原因：`messages` 既是对外历史、又是 LLM 上下文，插一条 user 消息会落在 `assistant(tool_calls)` 与它的 `tool` 结果之间，破坏 OpenAI 的消息配对约束。当前靠「工具回灌 + 浮层反馈 + AI 回答正文自然提及」三处承担。若日后要留痕，正确位置是**收口之后**（`persistRounds` 之后）追加，不是答复当刻 |
| 多选 `multi` | 字段已留、UI 未接 | 与 orchestrator 同口径：存储与契约按可多选设计，v1 恒 `false` |
| 卡片的会话归属 | 仅聊天页 | 契约与后端是通用的（任何工具都可调 `ask_choice`），但浮层目前只挂在 `ChatView` 的 composer 上；出题页 / 题库页要用时，复用 `ChoiceCard` + 一个容器即可 |
| 同会话并发提问 | 队列化 | 前端按数组存、只显示队首；后端每条独立，互不干扰 |
| 会话锁占用 | **已知代价** | 不设超时 ⇒ 用户走开不点，本轮一直占着 `flow.ts` 的同会话串行锁，下次回来须先「停止生成」。这是老板明确选择的取舍（与 orchestrator 一致） |
| 触发率 | **已兑现（v1.1，2026-09-16）** | 三层触发（§6）只提高倾向、不保证——弱指令跟随能力的模型仍可能不调，**这正是老板真机实测的结果**（「我实际使用完全遇不到」）。兑现方式＝**grill-me 模式**：本档原本预写的两条路取第一条 **`tool_choice` 对 `ask_choice` 强绑**，并升级成**用户的显式开关**（每轮必出、可跳过）——「要不要问」不再是模型的概率判断。**用户侧主动按钮仍不做**（有了「每轮必出」的开关，再放一个手动按钮是重复入口）。实现见 `chat/grill.ts`，契约细则见 §9 |
| **grill-me 模式**（v1.1 新增） | 已落地 | 打开后每一轮**必定**出现选择框：`pre`（开场问方向，答复**回灌**模型 ⇒ 挂起等待）＋ `post`（收尾问下一步，答复**不回灌** ⇒ 绝不挂起，点选后由前端作为**新一轮提问**发出）。卡片从「输入框上方浮层」**下沉到消息流内嵌块**（它属于这一轮的内容，跟着这轮滚走），普通 `ask_choice` 仍走浮层。★ **两个不能改的设计**：① **`tool_choice` 只绑 turn 0**——turn 1 起必须放开，否则模型被锁死在提问上、正文永远出不来；② **收尾失败一律静默**——问不出「下一步」不该把已经上屏的回答标成出错。详见 §9 |

## 8. 验收判据（可复跑）

```bash
# 后端全量（含本功能新增用例）
cd packages/server && npx vitest run src/chat/choice.test.ts

# 门禁（AGENTS.md:22：server ≤400 行 / web 组件 ≤300 行）
wc -l packages/server/src/chat/*.ts packages/web/src/features/chat/*.tsx
```

真机判据：对 AI 说「帮我在几种复习方式里选一个」→ 输入框上方弹卡 → 点一项 → AI 在同一轮里
按该选择继续输出，且**没有**新起一轮。点「停止生成」时挂起的卡应切为作废态。

---

## 9. grill-me 模式（v1.1，2026-09-16）

> 溯源：老板（2026-09-16）「我实际使用完全遇不到，所以我觉得直接单独搞成一个模式算了，就叫 grill-me 模式，ai 直接每轮必出这个选择框，但是可以跳过」。
> 三项拍板：**两处都要**（开场问方向 + 收尾问下一步）／**列入工具生态**／**专属消息流 UI**。

### 9.1 一句话

**把「要不要弹卡」从模型的概率判断改成用户的显式开关**——打开后每一轮必定出现选择框，跳过＝不点或点卡上的「跳过」。

### 9.2 为什么必须开这个模式（根因，不是偏好）

`ask_choice` 的工程链路**早就全通**（工具已注册、两适配器都带 `tools`、三帧 SSE 完整、卡片与三条逃生口齐备、`noTimeout` 已豁免），但真机几乎见不到。根因**不在工程**：

1. 系统提示那句「遇到岔路时先问一句」是**原则性描述**，模型无法把它映射到具体句子；
2. `tool_choice='auto'` 下模型有完全自由，助手的出厂倾向是**直接把答案讲完**；
3. §6 的 `choice-nudge.ts` 词表增强**只提高倾向、不保证**，且它的排除表（`是什么/为什么/原理/怎么用/怎么解释/举个例子/代码/报错/这道/选择题`…）**恰好覆盖学习场景 90% 的真实提问**。

⇒ 结论：**靠提示词求不来「每轮必问」**，必须由工程强绑。

### 9.3 两段提问的语义**相反**（最容易写错的地方）

| 段 | 指令 | 答复去向 | 挂起？ |
|---|---|---|---|
| `pre`（开场） | `GRILL_PRE`：第一个动作必须是 `ask_choice` | **回灌**模型 → 模型据此决定这一轮讲什么 | **要**（`askChoice`，一直等到点选/作废） |
| `post`（收尾） | `GRILL_POST`：给出 2~4 个「下一步」选项，**不要总结刚讲过的内容** | **不回灌** → 前端把选中项作为**新一轮提问**发出 | **绝不**（`offerChoice`：只落库+广播） |

★ 收尾若挂起，会把这一轮钉在 busy 上直到用户点一下——**「可以跳过」就成了假承诺**（不点＝卡住）。

### 9.4 三条不可改的工程约束

1. **`tool_choice` 只绑 turn 0**。turn 1 起必须放开，否则模型被锁死在「调用 ask_choice」上，正文永远出不来。
2. **收尾失败一律静默**。问不出「下一步」不该把已经上屏的回答标成出错（`ok:false` 会）。
3. **`pre` 的卡必须带 `grillPhase='pre'`**。不打标记 ⇒ 前端认不出它是 grill 卡 ⇒ 掉回输入框上方浮层，与「专属消息流 UI」的拍板相违（`useGrillChoice` 的筛选条件就是这个字段）。

### 9.5 新增出口

| 出口 | 说明 |
|---|---|
| `POST /api/choices/:id/cancel` | **跳过**。原来的 `dismissChoice` 只收起前端卡，后端 `askChoice` 还在等——`pre` 那张卡**阻塞整轮**，不真取消工具就永久悬挂。作废后 `choiceToolHint` 告诉模型「学习者没选，请直接作答」，本轮照常出正文 |
| `ChatRequest.toolChoice` | 契约层口子（此前 `tool_choice` 被硬编码成 `'auto'`）。**内部统一口径** `{type:'function',name}`；出站各自转换：**OpenAI 要 `{type:'function',function:{name}}`**（v18.1 实证修正——简写原样透传真机 500 "Invalid tool choice"），**anthropic 要转 `{type:'tool',name}`**（原样透传 400） |
| `AskChoiceRecord.grillPhase` | `'pre' \| 'post'`，**只在内存与 SSE 下发里活**：`ask_choices` 表刻意**不加列**、不加迁移。代价＝刷新后从 `listPendingChoices` 捞回的卡降级为普通卡（点选不自动开新一轮）；这个降级可接受（刷新时那张卡本身也已不在原语境里），且已被 `chat/grill.test.ts` 钉成断言 |

### 9.6 真机判据（待老板实机双签）

1. 输入框「+」菜单打开「追问模式」→ **框外出现状态 pill**（收在折叠菜单里不提示＝用户以为没生效）；
2. 随便问一句 → **先弹方向卡**（不吐正文）→ 点一项 → 模型按该方向作答；
3. 答案给完 → **再弹「下一步」卡** → 点一项 → **开启新一轮提问**；
4. 第 2 步的卡**不点**、改点卡上「跳过」→ **本轮照常出正文**（不能卡在 busy）；
5. 关掉开关 → 回到既有行为（只在高置信岔路时才弹）。


---

## 10. 多轮拍板 + ABCD 选项形态（v1.2，2026-09-17）

> 溯源：老板（2026-09-17）「不要每次都只有一个选择题，是可以有多轮的；要加一个自定义选项——类似 ABC 由 AI 给，D 可以让用户用输入框自定义」。

### 10.1 多轮拍板

| 层 | 改动 | 位置 |
|---|---|---|
| 后端 | **零改动**：工具循环（`flow.ts` 的 `MAX_TOOL_TURNS`）本来就支持同轮多次 `ask_choice`——waiter 唤醒后模型可再调 | `chat/flow.ts` |
| 前端 | **真根因在此**：`choice-asked` 入队前把已结算（answered/cancelled）的卡请出队列。此前已答卡永不出队、浮层只显示队首，第二问 / grill post 卡被压在后面看不见——「多轮」在体验上直接消失 | `useChoiceQueue.ts` 的 `applyEvent` |
| 提示词 | 系统提示与工具描述均明确：**每次只聚焦一个分歧点，拿到答复后若出现新岔路（方向→深度→形式）就再次调用**，不把多个分歧塞进一个选择框 | `chat/system-prompt.ts` + `chat/choice-tool.ts` |

### 10.2 ABCD 选项形态

- AI 给的每个选项带字母方框（A/B/C…按序号自动编，`String.fromCharCode(65+i)`）：方框里平时显示字母，悬停该选项时字母让位给勾、方框变蓝。
- 自定义出口（`allowCustom`，shared 归一层**默认开**）自动排为下一个字母（选项满 4 个时为 E）：虚线方框 + 笔图标，点开后**输入框内联在本盒子里**，不再另起一行。
- 回传语义不变：走自定义仍是 `custom` 字段、`optionId` 归 `null`（§2 的互斥口径原样）。

### 10.3 验收

`npx vitest run packages/server/src/chat/choice.test.ts packages/server/src/chat/grill.test.ts`（31 用例，2026-09-17 全绿）；行数门禁：`ChoiceCard.tsx` 193/300。

### 10.4 追加修复：grill-me 首用即 500（v18.1，2026-09-17）

真机报错：`Invalid tool_choice, tool_choice={'name':'ask_choice','type':'function'}. Please ensure tool_choice follows the OpenAI spec`。

- **根因**：`openai.ts` 两处出站点把内部口径 `{type:'function',name}` **原样透传**——当时误把它当 OpenAI 规范，实际 OpenAI 规范是 `{type:'function',function:{name}}`（§9.5 的口径说明本就写错了）。Anthropic 侧因有转换反而没事。教训：**没在真机跑过的出站格式不算验证过**，单测钉的也是错口径。
- **修复**：`openai.ts` 新增 `toOpenAIToolChoice` 转换函数，流式 / 非流式两处出站点统一走它；`tool-choice.test.ts` 的 OpenAI 断言改为规范口径并更新文件头说明。
- **验证**：`tool-choice.test.ts` 6 用例全绿 + server `tsc` 零错。

### 10.5 追加修复：真机上选择框一直是「纯文字」（v18.2，2026-09-17）

- **根因**：`ChoiceCard.tsx` 从未 `import './choice.css'`——全仓没有任何文件引入它，构建产物 CSS 里零 choice 类，真机上整卡**从上线起就是零样式裸 DOM**（v18.1 之前老板看到的「太粗糙」、之后的「变回纯文字」都是它）。同族 `AskStyleCard.tsx` 有 `import './ask-style.css'`，本组件漏了同款行。
- **修复**：补 `import './choice.css'`；重建 `packages/web/dist`（含全部 choice 选择器）。
- **流程教训**：改前端后必须 `npm run build`（老板真机走 server 静态服务的 dist，不走 vite dev）；「demo 页里好看」不等于「真机生效」，收尾要 grep 产物 CSS 验证类名真的进包。

### 10.6 追加修复：点了 grill 收尾卡，模型不动（v18.3，2026-09-17）

- **现象**：收尾「下一步」卡弹出后点选，模型不继续、也不弹下一轮的方向卡——点了像没点。
- **根因（时序竞态）**：收尾卡在 `chat_done`/`done` 帧**之前**弹出（旧注释明确写了这个刻意位置），而前端 `busy` 要等 `done` 帧才解除。卡片已可点、点了却被 `useSendActions` 的 busy 门禁拒绝，且 `useGrillChoice.replyGrill` 里 `void send(...)` 把 `{ok:false}` 整个吞掉——**双重静默**，用户视角就是零响应。
- **修复（两层）**：
  ① 服务端 `flow.ts`：收尾调用移到 `done` 帧之后（SSE 是会话级持久订阅，与 POST /chat/send 分离，done 后发帧照样送达且有断线回放兜底）——卡片弹出时 busy 必已解除，竞态从源头消失；
  ② 前端 `useGrillChoice`：post 点选的 send 结果不再吞错，失败经 `onSendError` 上报 `ChatView.setSendError`（防御其它竞态，如断连期点选）。
- **语义不变**：post 答复仍不回灌，点选后由前端把选项文本作为新一轮提问发出；新一轮照旧以方向卡开场（grill-me「每轮必问」语义）。
- **验证**：chat+llm 227 用例全绿；web/server `tsc` 零错；dist 已重建。
