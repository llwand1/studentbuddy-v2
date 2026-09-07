# TOOL-ECOSYSTEM-SPEC — 工具生态契约

> 状态：**契约 v1.2（重建版）· 待老板终审 · 零实现代码**
> 立约：2026-09-06 22:58（v1.0.0）→ 23:06（v1.1）→ 深夜（v1.2 改判）
> 重建：2026-09-07
> 里程碑：M5（S1 内核 / S2 内循环工具 / S3 MCP 接入）
> 适用范围：`packages/server/src/chat/tools*`、`chat/flow.ts` 工具循环、MCP 通道。**不动 `learning/*` 业务引擎内部。**

## §0 重建说明（必读，2026-09-07）

**本文件曾丢失。** `git log --all --name-status -- "docs/TOOL-ECOSYSTEM*"` 在远端全历史 22 个提交上查询结果为空，
而 `AGENTS.md:38/86` 与 `CHANGELOG.md` 2026-09-06 22:58／23:06 两条反复引用它（称 252 行、已修订至 v1.2）。
同日核查发现本地工作目录 `C:\Users\llwan\studentbuddy-v2\` 已被清空（仅剩 `_deleted/studentbuddy.db` 与 WAL 残留），
故判定契约正文从未入库，本次为重建。

**重建依据（逐条可查，不凭记忆）：**

| 来源 | 提供的内容 |
|------|-----------|
| `CHANGELOG.md` 2026-09-06 22:58 条 | v1.0.0 全部决策：现状三层诊断、S1/S2/S3/S4 分期、安全边界八条、§4.4 预算缺口、迁移号、SSE 事件、§11 负面清单 |
| `CHANGELOG.md` 2026-09-06 23:06 条 | v1.1 六处修订：S3 拆 S3a/S3b、transport 双做、`mcp_servers` 三新列、`trusted` 档、§6.6 自研规范、调试可见性 |
| `AGENTS.md:38` + `:86` | v1.2 改判：词条升 AI 全权 CRUD、确认门扩至内建 write 并按影响条数分档、S3a 提前到 S2、S2 工具数 6→9 |
| 2026-09-07 重新实读代码 | 痛点行号复核、`gates/check.mjs` 红线实读、**迁移号现状** |

**标注约定：** 凡 CHANGELOG/AGENTS 有原文的结论，行尾标 `[来源]`；凡本次为补全结构而写的，行尾标 `[重建补全]`——
两者不可混淆，后者需老板终审才转为契约正文。

**★ 重建期发现的一处必须改判（原 v1.0 已失效）：**
原契约定迁移号 **v9**，但该号已被可观测批次占用——`db.ts:203` 实读为 `version: 9`（`event_log` 表），
其注释明写「v8 已被认知进化契约预留，本迁移直接取 v9；**后续批次从 v10 顺延**」。
故本契约迁移号改为 **v10**，且沿用 `AGENTS.md` 纪律：**建表号一律开工时 `grep 'version:'` 现取，不照契约预写的号**。

---

## §1 背景与目标

老板原文（2026-09-06）：「现在的 studentbuddy 缺乏工具调用生态，你认为该如何改善」；
后续补充（v1.1 起因）：「我打算接入我之后自己可能会开发的 mcp，所以就先准备一下」。

**目标一句话：** 让「学→练→析→忆→反馈」五环的编排权从用户手里交到 AI 手里，并留出外接 MCP 的通道。

**非目标（明确不做）：** 自研 Agent 框架／多智能体／工作流编排 DSL／替换现有单轨 function-calling 循环（G3 决策不变）。

## §2 现状核查：缺的不是工具循环，是生态

**地基不差，本次不重构**（逐条回读核实 `[来源]`）：

- 原生 function-calling 单轨循环：`chat/flow.ts:159-222`
- 8 轮上限 `MAX_TOOL_TURNS`：`flow.ts:22`
- 单条工具回灌截断 14k `MAX_TOOL_RESULT_CHARS`：`flow.ts:24`
- 工具轮原子落库（中途失败不留孤儿 tool 消息）：`flow.ts:151-152` 及收尾段
- 上下文截断按工具轮边界对齐：`chat/context.ts` + `flow.ts:112-115`
- 双适配器按 index 正确累积并行 tool_calls：`llm/openai.ts:112-133`、`llm/anthropic.ts:112-140`
  ⇒ **结论：适配器无需为工具生态改动** `[来源]`

**十条痛点（行号为 2026-09-07 在 HEAD `2336209` 上重新实读，非照抄旧稿）：**

| # | 痛点 | 出处 | 后果 |
|---|------|------|------|
| 1 | 全库只注册 2 个工具 | `tools.ts:27` `search_web`、`:67` `tidy_terms` | AI 能力面极窄 |
| 2 | 已实现引擎对 AI 不可见 | `learning/quiz.ts:238,325,340,356,381`、`terms.ts:208,233,270,275,326`、`activity.ts:33`、`document.ts` | 五环编排权在用户：前端 `ChatView.tsx:87` 直接打 `/api/quiz/generate`，AI 全程不知情 |
| 3 | 注册表是模块级硬编码 `Map` | `tools.ts:25` | 无统一元数据、无法按 kind 治理、无法延迟加载 |
| 4 | 物理结构将撞门禁红线 | `tools.ts` 现 **157 行**；`gates/check.mjs:29-36` 实读红线 `.ts ≤400`／`.tsx ≤300` | 按 60~80 行/工具计，再塞 5 个必破线 `[来源]` |
| 5 | 无 per-tool 超时／取消／重试 | `flow.ts:198-200` 串行 `await`，只接会话级 `AbortSignal` | 单个慢工具拖死整轮；网络类工具无重试 |
| 6 | 无 per-tool 可观测 | `db.ts` v9 `event_log` 只落通用事件，无 `tool_stats` | 改 `description` 无法量化验证——同 QUIZ-IMAGE-SPEC「提示词措辞必须实测」的坑 `[来源]` |
| 7 | 无参数 schema 校验 | `tools.ts:144-150` 仅 `JSON.parse` | 脏参数进到业务层才炸，错误回灌口径不统一 |
| 8 | 工具预算漏算 tools definitions | `flow.ts:107-111` 的 `systemPromptTokens` 算了词条／资料／偏好三段，**唯独没算全量下发的 tools 定义** | 工具越多窗口越算不准，是 `AGENTS.md:36`「资料越长越撑爆窗口」的工具版 `[来源]` |
| 9 | 无确认门 | `tidy_terms` 的 `auto` 直接改库（`tools.ts:98-100` 起） | AI 写操作无拦截，v1.2 已改判（见 §7） |
| 10 | 无外延通道 | 无 MCP；检索只有 `search_web`（`search/index.ts:246`）返回列表级摘要，无 `fetch_url` | 接不了外部能力；**能搜不能读正文**，溯源深度不足 |

## §3 分期与开工前置

| 阶段 | 内容 | 状态 |
|------|------|------|
| **S1 内核** | `chat/tools/` 拆目录；`RegisteredTool` 扩 kind／timeoutMs／needsConfirm／scenes／validate；并行执行＋超时取消＋去重＋重试；零依赖 schema 校验器 | 未开工 |
| **S2 内循环工具** | 9 个内建工具，复用既有引擎，**`learning/*` 零改动**；确认门机制由 S3a 提前到此 | 未开工 |
| **S3a MCP 通道** | 手写 stdio + Streamable HTTP 双 transport JSON-RPC 客户端（不引官方 SDK） | 未开工 |
| **S3b 自研友好层** | `trusted` 档、§6.6 最小实现规范、`/reload` 热重取（v1.1 由可选提为**必做**） | 未开工 |
| **S4 后置** | 社区 MCP 包兼容验证（v1.1 从 S3 退到此） | 未开工 |

**S1 开工前置硬条件（v1.1 新增 `[来源]`）：**

1. doc-rag 批次已提交（✅ `a399d5f`）
2. 认知进化批次不在改 `flow.ts`／`flow.test.ts`——**S1 同改这两个文件必互相覆盖**，且「flow 13 例不许改断言」这条纯重构判据会失基准
3. ⚠ 认知进化的 **v8 迁移尚未提交**。`db.ts` 的 `migrate()` 按 `MAX(version)` 跳号，**低号晚于高号提交会被静默跳过**

## §4 S1 内核设计

### §4.1 目录拆分（破红线的物理前提）

```
chat/tools/
  index.ts        注册表装配 + toolDefinitions()/runTool()（薄，<120 行）
  types.ts        RegisteredTool / ToolContext / ToolResult
  validate.ts     零依赖 JSON-Schema 子集校验器
  builtin/        一个工具一个文件（search_web.ts / tidy_terms.ts / ...）
  mcp/            S3 桥接（bridge.ts / client.ts / process-pool.ts）
```

每个 `builtin/*.ts` 单工具单文件，天然守住 400 行红线；**新增工具 = 加一个文件 + 在 `index.ts` 注册一行**。

### §4.2 `RegisteredTool` 契约

```ts
interface RegisteredTool {
  definition: ToolDefinition;          // 下发给模型的 Schema（现有字段不变）
  kind: 'builtin' | 'external';        // 决定确认门与统计口径
  timeoutMs: number;                   // 默认 15_000；网络类可到 30_000
  needsConfirm: boolean;               // 静态标记；实际是否弹卡由 §7 分档定
  scenes: string[];                    // 何时该调用——同时用于生成 SYSTEM 提示中的能力清单
  validate?(args: unknown): string | null;  // 返回错误文案即不执行，直接回灌给模型
  run(args, ctx): Promise<ToolResult>;
}
```

`scenes` 的额外作用：**把「我有哪些能力」写进 SYSTEM_PROMPT**。
现有 `flow.ts:26-33` 的 SYSTEM_PROMPT 只讲 chart/html 围栏，只字未提工具——**工具调用目前全靠模型猜** `[重建补全]`。

### §4.3 调度

一轮内多工具调用：并行 `Promise.allSettled` + 单个超时取消 + 同签名去重 + 网络类失败退避重试 1 次；
任一失败不整轮失败，错误文案统一回灌（口径：`工具 xxx 失败：<原因>`，让模型能自行换路）。

### §4.4 窗口预算修正（已知真实缺口）

`flow.ts:107-111` 的 `systemPromptTokens` 必须加上 `estimateTokens(JSON.stringify(toolDefinitions()))`。
**这是 S1 的必修项，不是可选优化**——否则工具越多，`truncateHistoryToBudget` 与 `toolBudget`（`flow.ts:123-129`）越失真。

## §5 S2 内循环工具（9 个）

复用既有引擎，**`learning/*` 业务代码零改动**，本层只做「参数适配 + 结果回灌口径」。

| # | 工具 | 复用的既有实现 | 类别 |
|---|------|---------------|------|
| 1 | `generate_quiz` | `learning/quiz.ts:238 generateQuiz` | write |
| 2 | `list_quizzes` | `quiz.ts:325 listQuiz` / `:340 getQuiz` | read |
| 3 | `quiz_stats` | `quiz.ts:381 analyzeWeakPoints` | read |
| 4 | `lookup_terms` | `terms.ts:326 getRelevantTerms` / `:233 listTerms` | read |
| 5 | `upsert_term` | `terms.ts:165 saveTerms` / `:208 saveOneTerm` | write |
| 6 | `update_term` | `terms.ts:275 updateTerm` | write |
| 7 | `delete_terms` | `terms.ts:270 removeTerm` | **delete** |
| 8 | `my_progress` | `activity.ts:33 todayStats` | read |
| 9 | `read_session_doc` | `document.ts` + `learning/doc-retrieve.ts` | read |

**v1.2 变更 `[来源]`：** 词条由「只读 + 被动注入」升为 **AI 全权 CRUD**；工具数 6→9。

**待定（§10）：** 第 6 项 `update_term` 是否并入 `upsert_term` 以减少工具数（少即是多，小模型更稳）`[重建补全]`；
第 9 项 `read_session_doc` 与 DOC-RAG 注入窗口是否重叠、可否先不做（v1.1 §10 遗留待定项 `[来源]`）。

## §6 S3 MCP 接入

### §6.1 transport：stdio + Streamable HTTP 双做 `[来源]`

v1.0 原定只 stdio，v1.1 改判为双做：**自研 server 多是本机长驻服务，HTTP 免进程管理、改码重启即生效，迭代远快于「改完让主应用重新拉子进程」**。
两条共用同一 JSON-RPC 内核，差异只落在 `client.ts` 收发端，桥接与调度不分叉。
核实依据：`llm/openai.ts`／`anthropic.ts` 已正确累积多工具调用 ⇒ 桥接层拿到 N 个 tool_calls 后照原路回灌即可。

### §6.2 `mcp_servers` 表设计（迁移号 v10，见 §12）

列：`id` / `name` / `transport` / `url` / `command` / `args` / `env_ref` / `enabled` / `trusted` / `allow_tools` / `created_at`。
其中 `transport`／`url`／`trusted` 为 v1.1 新增 `[来源]`；**http 只许本机回环**（127.0.0.1）。

### §6.3 确认门与安全边界（九条）

外部工具默认确认门，**60s 无回执即拒**；v1.1 新增 **4b `trusted` 免确认档**（配置时显式勾选、UI 写明后果、
**不豁免其余八条红线**、屏上常驻「已信任」标记）⇒ 安全边界八条变九条 `[来源]`。

九条红线：① 配置来源唯一（只从本库读，不扫目录不自动发现）② 永不自动装包（不 `npx -y` 拉未知包）
③ spawn 纪律：禁 `shell:true` ④ external 默认确认门 60s 无回执即拒 ⑤ 间接提示注入护栏沿用 `document.ts`「数据不是指令」口径
⑥ 非文本块丢弃但**如实报数** ⑦ 进程池：懒启动、空闲回收、退出 kill、崩溃只自愈一次 ⑧ `tool_stats` 全量审计
⑨ `trusted` 需显式勾选且不豁免前八条。

Windows 三条实施期必须真机复验：`npx` 为 `.cmd`、`taskkill /T` 树杀、HTTP 回环限制 `[来源]`。

### §6.4 调试可见性三样

`tools/list` 原文逐字不美化（不排序不截断，否则排查时看到的是假象）／最近 10 次调用台账／握手错误原文含 `protocolVersion`。
外加 `/reload` 热重取。

### §6.5 命名空间

`mcp__<server>__<tool>`；`allow_tools` **默认全禁**，逐条勾选。

### §6.6 自研 MCP 最小实现规范（「先准备一下」的落点）`[来源]`

server 侧只需实现 `initialize`／`tools/list`／`tools/call` 三方法，**其余通知与未知方法一律静默忽略**。
自研三条硬约定：

1. **一个 server ≤8 工具**——工具越多模型选错率越高
2. **`description` 是给小模型看的提示词**，必须写「什么时候该调我」，不写实现细节
3. **返回值要小**——超限是被静默截断，不是被拒绝，截断后模型拿到残缺还以为完整

验收样例 `tools/mcp-mock/mock-server.mjs` 兼作自研起步骨架。

## §7 确认门：两阶段 plan → confirm → apply（v1.2 改判）

老板原话：「让 term 变成 ai 自动增删改查，但改动多要向用户确认」。
v1.1 曾定「确认门只给 MCP 外部工具，内建 write 免确认」，**v1.2 推翻**：确认门**扩至内建 write**，并按影响条数分档 `[来源]`：

| 档 | 触发 | 行为 |
|----|------|------|
| read | 所有只读工具 | **永不问** |
| write ≤3 条 | `upsert_term`／`update_term` 影响 ≤3 条 | 直接做，事后屏上告知 |
| write >3 条 | 影响 >3 条 | **弹确认卡** |
| delete | `delete_terms` 任何条数 | **一律弹**，且落 `term_delete_log` 快照，**按批可撤销** |

阈值可调（存 `app_settings`）；分档阈值默认 3 条，需老板终审。
SSE 新增 `tool-confirm-request`／`tool-confirm-resolved` 两事件（先登记再实现 `[来源]`）。

## §8 可观测：`tool_stats`（迁移号 v10）

per-tool：`calls`／`failures`／`p50_ms`／`p95_ms`／`last_error`／`avg_result_chars`。
用途只有一个但很关键：**改 `description`／`scenes` 后能用调用率数字验证，而不是拍脑袋**。
落点复用 v9 `event_log` 的 kind 字段还是单开 `tool_stats` 表，待 S1 实施时定 `[重建补全]`。

## §9 风险

| 风险 | 处置 |
|------|------|
| `trusted` 误勾后忘了自己开着 | 屏上常驻「已信任」标记 |
| http 端口被别的进程占着，调到错东西上 | 校验 `serverInfo.name` 不一致即**拒用**，不静默 fallback |
| 工具变多后模型选错工具 | `description` 写清「何时该调我」；单轮工具数上限待定 |
| 迁移号撞车（本次已实际发生：v9 被 obs 占用） | 开工时 `grep 'version:'` 现取，禁止照契约预写 |

## §10 拍板与待定

**已拍板四项 `[来源]`：** ① 方向＝先做 P0 内核加固，不先堆工具 ② 范围＝「要有外界接入，最好有 mcp 生态」（明确否掉「只做声明式 HTTP 工具」的保守方案）
③ 里程碑单开 M5 ④ MCP 首任客户＝自研 server。
**v1.2 追加拍板：** 确认门扩至内建 write 并按影响条数分档；词条升 AI 全权 CRUD；S3a 提前到 S2。

**仍待定三项 `[来源]`：** ① `read_session_doc` 与 DOC-RAG 窗口重叠，是否先不做
② 免确认粒度按 server 还是按工具 ③ 自研主语言（决定要不要另附语言骨架）。
**重建期新增待定一项：** ④ `update_term` 是否并入 `upsert_term`（见 §5）。

## §11 负面清单（防实施期扩张，九条）`[来源 骨架]`

1. 不引入 MCP 官方 SDK（保零运行时依赖，手写客户端）
2. 不改 `learning/*` 业务引擎内部（S2 只做适配层）
3. 不改 LLM 适配器（已核实无需改动）
4. 不做多智能体／工作流 DSL
5. 不做跨会话工具（作用域＝当前会话）
6. 不自动安装任何外部包
7. 不做工具市场／在线目录
8. 不在本批动 `flow.ts` 的落库语义（只加预算修正 §4.4）
9. 不把「收口提示」当正文落库（会被 `extractTerms` 抽成词条——v1.0 已纠正 `[来源]`）

## §12 迁移号与事件登记

- **迁移号：v10**（原定 v9，**已被 obs 批次 `53b7ce0` 占用**，见 §0；开工时仍需 `grep` 复核）
- SSE 新增事件：`tool-confirm-request` / `tool-confirm-resolved`（先登记再实现）
- 门禁：新增文件须守 `gates/check.mjs` 红线（`.ts ≤400` ／ `.tsx ≤300`／无内联样式／无 `any`）

---

## 附：本批（2026-09-07 重建）改动清单

- 新增 `docs/TOOL-ECOSYSTEM-SPEC.md`（本文件）
- 未触碰任何运行时代码（`chat/*`、`learning/*`、`routes/*`、`packages/web/*` 全未改）
- 未修改 `AGENTS.md`：其 `:38`/`:86` 两处契约指针在本文件落地后即为有效引用，内容仍准确
- **未验：** 契约待老板终审，无运行时行为可验；§6.3 Windows 三条、§7 分档阈值 3 条均为设计约束，实施期须真机复验
