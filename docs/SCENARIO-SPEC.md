# SCENARIO-SPEC — 情景题（AI 生成 demo 的可回传交互题）

> 版本：v1.2 | 状态：M1~M4 已落地 + 配比档接入（v1.2，2026-09-17）
> ⚠️ **2026-09-26 题库整族下线对本契约的影响（正文规范未改，先读这条再读下面）**：
>   老板判决逐字「studentbuddy的题库功能也去删了,现在只要剩下内核和对战以及词条」（档 B「整族断线」，issue #32）。情景题**整链保留**——但它的宿主变了：
>   · §4「情景题落 `quiz_bank`（`source='scenario'`）」**照旧**，因为本批不碰表（表还在、写入方还在）；
>     ★ 但 `quiz_bank` 自此**只进不出**：连带清理 demo 的唯一调用点（`DELETE /api/quiz/bank/:id`）已删，
>     而 `GET /api/scenario/by-quiz/:quizId` 也一并删除 ⇒ **前台没有任何通道能列出或删掉旧情景套题**
>     （代价登记在 `test-plan.md` §6 的 P1 挂账；DROP `quiz_bank` 之前必须先给它找新家——issue #32 尾巴 ③）。
>   · §5「M1：题库页入口」「题库列表对 `source === 'scenario'` 打『情景』标记」——**那页已不存在**，
>     情景题现在只从对战（`#/pk`）与聊天题卡进入；§7 里程碑 M1 那行里的「题库页」按此读。
>   · §3 那句「删 demo 行不破坏题库 JSON」仍是事实（两表 1:1 的设计没变），只是没人能触发删了。
>
> 情景题 = **AI 生成一个可交互的 HTML demo，demo 内嵌评分点，用户在 demo 里操作，对错回传进统一题库统计**。
> 出题方式不固定（demo 爱怎么玩怎么玩），但有一条硬规定：**必须有对错标准（criteria），且对错必须回传**——
> 回传机制是情景题能被统一管理、统计、编排的唯一前提。

## 0. 设计总纲（改码前必读）

1. **数据层同待遇**：情景题的每个评分点（task）在 `quiz_stats` 里就是一道普通题（占一个 `question_index`）。
   正确率 / streak / 薄弱点分析 / ~~study-flow 编排~~（⚰️ 2026-09-25 学习流整族下线删除，批次 K；其余三项照旧）**零新增接线**——这是「统一管理、统计、编排」的实现方式，
   不另建第二套统计。
2. **裁判在服务端**：demo 只上报「发生了什么」（observed 事实），**对错由服务端按 criteria 判**
   （`judgeTask` 纯函数）。demo 内的即时对错反馈用同一份 criteria 本地判（只管体验），入库以服务端复核为准。
   理由：demo 是模型写的、不可信侧——它判错了数据就永久错，且无法复查。
3. **回传只有一条通道**：桥接脚本（服务端注入）→ `window.parent.postMessage` → 宿主面板校验 → REST 上报。
   现有 CSP sandbox（opaque origin）白送安全边界：**demo 调不动任何写接口**（写接口 Origin 校验放行不了
   `'null'` 源，见 `security.ts`），伪造数据只能走桥接这条独木桥，而独木桥上有白名单。
4. **体验与数据分离**：demo 内可以自由反馈对错动画（体验侧，模型自决）；服务端只认上报事实 + criteria
   （数据侧，本契约管）。两者用同一份 criteria，但判分各自独立发生。

## 1. 数据形状（shared 契约，`packages/shared/src/scenario.ts`）

```ts
/** 对错标准（判型首期三种，缺 criteria 的评分点在 normalize 时丢弃——标准不完整等于没有这道题） */
type ScenarioCriteria =
  | { kind: 'choice'; answer: number[] }        // observed 须为选中下标数组，与 answer 集合相等
  | { kind: 'state';  value: string | number | boolean } // observed 须与 value 逐字相等（String 化比较）
  | { kind: 'order';  answer: string[] };       // observed 须为与 answer 完全同序的字符串数组

interface ScenarioTask {
  id: string;             // 评分点 id（demo 内引用；回传白名单的键）
  prompt: string;         // 任务描述（统计页/笔记展示用）
  criteria: ScenarioCriteria;
  hint?: string;          // 可选提示
}

interface ScenarioPayload {
  title: string;
  tasks: ScenarioTask[];  // normalize 后 ≥1 条，上限 MAX_SCENARIO_TASKS=10
}
```

- 情景题落 `quiz_bank`（`source = 'scenario'`，data = JSON(ScenarioPayload)）；demo HTML 落 **`scenario_demo`**
  表（迁移 v20：`id` 主键 / `quiz_id` / `html` / `created_at`）。
- `quiz_bank.data` 里**只有 ScenarioPayload，没有 demoId**——demo 与套题是 1:1，由 `scenario_demo.quiz_id`
  反查，套题行自身保持可读（删 demo 行不破坏题库 JSON）。
- 题库列表的「N 题」对情景题 = `tasks.length`（`listQuiz` 解析时按有无 `tasks` 键分派，不是 `questions`）。

## 2. 回传消息契约（唯一上行通道）

```ts
interface ScenarioReportMessage {
  v: 1;
  type: 'sb-scenario-report';   // 宿主只认这一个 type
  demoId: string;               // 服务端出页时注入桥接的常量，宿主比对防串台
  taskId: string;               // 宿主按题目 tasks 白名单校验，不在名单内丢弃
  observed: unknown;            // 「发生了什么」的事实（选中项 / 状态值 / 排列），判分交给服务端
}
```

- **桥接脚本**（`SCENARIO_BRIDGE_JS` 常量，服务端出页时注入 demo 头部，`__SB_DEMO_ID__` 占位符替换为真 id）：
  暴露 `window.SBScenario.report(taskId, observed)`，内部 `parent.postMessage`，不做任何别的。
  demo 作者（AI 或人）只许调这一个函数。
- **宿主校验三道**（`validateScenarioReport` 纯函数，web 侧）：`type` 匹配 → `demoId` 匹配当前面板 →
  `taskId` 在当前题目的白名单内。三道全过才发 REST，否则静默丢弃（不可信侧的噪音不弹错误打扰用户）。
- **服务端复核两道**（`reportScenario`）：demoId 存在 → taskId 在该套题 tasks 里（第二道白名单，防宿主侧
  伪造）。判分用 `judgeTask(criteria, observed)`，结果走 `recordAnswer(quizId, taskIndex, correct)` 落
  `quiz_stats`。

## 3. judgeTask 判分规则（纯函数，前后端同源）

| 判型 | observed 合法形状 | 对的判定 |
|------|-------------------|----------|
| `choice` | `number[]`（全为整数） | 与 `criteria.answer` 作**集合相等**（去重后同长且逐个命中） |
| `state` | 任意 | `String(observed) === String(criteria.value)`；`undefined`/`null` 恒错 |
| `order` | `string[]` | 与 `criteria.answer` **逐位相等**（长度不等即错） |

形状不对一律判错（不抛错、不猜）——「demo 上报了垃圾」是 demo 的错，但记账不能崩（ADR-4）。

## 4. 端点（挂 `/api/scenario`，`routes/scenario.ts`）

| 端点 | 用途 | 说明 |
|------|------|------|
| `POST /seed` | 登记一套情景题 | body `{ title, html, tasks }` → normalize → `quiz_bank` + `scenario_demo`，回 `{ quizId, demoId }`。**M1 由人工/测试调用，M2 起成为出题引擎的内部落点**（同一函数 `saveScenario`） |
| `GET /demo/:id` | 出 demo 页 | CSP `sandbox allow-scripts allow-modals allow-forms`（同 preview，**不给 same-origin**）+ 注入桥接；404＝demo 不存在 |
| `POST /report` | 回传对错 | body `{ demoId, taskId, observed }` → 白名单 → `judgeTask` → `recordAnswer`，回 `{ ok, correct, taskIndex }`；demo/task 不存在回 404 |
| `POST /generate` | AI 生成一套情景题（M2） | body `{ topic, material? }` → `generateScenario`（§6）→ `saveScenario` 一次落库，回 `{ quizId, demoId, payload, report }`；topic/material 全缺 400；502 按真因分开说（`no-model` 给绑定指引 / `parse` 给换模型建议，report 随响应回传）。**不设 save 开关**——情景题不落库就没有 demo 可玩 |

`html` 上限沿 preview 的 512KB；tasks 上限 10（`MAX_SCENARIO_TASKS`）。

## 5. 前端（M1：题库页入口；M3：聊天流卡片）

- **宿主组件 `ScenarioPanel`**：iframe `sandbox="allow-scripts allow-modals allow-forms"` 挂
  `/api/scenario/demo/:demoId`，`useEffect` 挂 `window.message` 监听 → `validateScenarioReport` →
  `POST /report` → 更新本地完成态。**必须在本应用 iframe 内完成**——「新标签页打开」会断回传链，不提供。
- 面板显示任务清单 + 逐个完成态 + 汇总（对 x / 共 y）；**对错以服务端响应为准**，demo 内的本地反馈不算数。
- 题库列表对 `source === 'scenario'` 的条目打「情景」标记；点进练习视图走 ScenarioPanel 而非 QuizCard。
- `source === 'scenario'` 的判定放纯函数（`scenario-view.ts`），组件只挂。

## 6. 出题协议（v1.1 新增，`learning/scenario-protocol.ts`）

### 6.1 双标记

模型输出**两段标记**，刻意不把 demo 塞进 JSON 字符串字段：

```
[SCENARIO]{"title":"…","tasks":[{"id":"t1","prompt":"…","criteria":{…}}]}[/SCENARIO]
[SCENARIO_HTML]<!DOCTYPE html>…完整 HTML 文档，原样输出零转义…[/SCENARIO_HTML]
```

理由：整页 HTML 的引号转义是传统题 svg 字段翻车坑的放大版（体量大一个数量级），裸标记让模型零转义输出，
失败面砍掉一大半。`SCENARIO_PROTOCOL` 提示词钉死：demo 自包含无外链（CSP sandbox 加载不了）、
每个任务 id 必须原样出现在 HTML 的脚本调用里、demo 只上报事实不判对错（§0.2）、评分点 3～6 个。

### 6.2 解析救援阶梯（`parseScenarioBlock`，代价从低到高）

| 阶 | 治什么 | 手段 |
|----|--------|------|
| ① 原样 | 正常输出 | 成对标记 + 合法 JSON 直接过；忘写 `[SCENARIO]` 时在 HTML 标记前兜底抽取 |
| ② 无损修复 | 漏转义 / 漏 `]` | 复用 quiz-json-repair（合法输入上永不触发，严格增益） |
| ③ JSON 截断回退 | 撞 max_tokens | 线性深度扫描，砍到最后一个完整 task 收尾处补 `]}`（残缺任务整条不要） |
| ④ HTML 截断抢救 | 闭合标记被截 | 吃到结尾，能收口 `</html>` 就收口；残缺尾巴接不上的评分点由 ⑥ 兜底丢弃 |

全部线性扫描、无正则回溯（SVG_FIELD 事故不许重演）；超 500K 字符不做抢救。

### 6.3 校验闸门（入库前最后两道）

- **引用完整性静态检查**：task id 没出现在 demo HTML 里 ⇒ 该评分点**整条丢弃**并计数
  （它永远等不到回传，是死题）；全部接不上 ⇒ 整组 null。这是「demo 质量方差」这一 M2 最大风险的防线。
- **硬限制**：没有 HTML 段 ⇒ null（没有 demo 不成情景题）；demo 超 `MAX_SCENARIO_HTML_CHARS` ⇒ null
  且 `htmlOversized` 如实报（检查在解析之前，不白耗一遍）。
- 过程报告 `ScenarioGenReport`（truncated / htmlRescued / droppedTasks / htmlOversized / failure）
  随响应回传——丢了几条、有没有抢救，如实说（ADR-5 不静默）。

### 6.4 引擎（`generateScenario`）

与 `generateQuiz` 同一条装配线：`quiz-generator` 角色模型、`QUIZ_TEMPERATURE`（0.4，题目要稳）、
`getQuizMaxOutputTokens`（demo 体量大，通用表更会撞）；流式累积 → `parseScenarioBlock` →
`saveScenario` 落库（M1 同一条 normalize 闸门，不走第二条写入路径）。

## 6.1 配比档接入（v1.2，2026-09-17——老板点单「在设置出题的题型配比那里也加上情景题」）

情景题成为**第 5 配比档**，与四类传统题同卡统一调（`shared/content-blocks.ts`）：

- `QuizMixKind = QuizType | 'scenario'`：**配比是档位概念**，scenario 不是 QuizQuestion 形状，不混进 `QuizType`；
- `MIX_KINDS`：情景排末位＝**出题执行顺序末位**（传统四类一道引擎出完，情景套随后逐套生成）；
- `MAX_SCENARIO_PER_MIX = 3`：一套 = 一次整页 demo 的 LLM 生成，比一道普通题贵一个量级，单档钳 3；
- `DEFAULT_QUIZ_MIX.scenario = 0`：默认关，老用户升级**零行为变化**；
- normalize 超限**从后往前削＝先砍情景**（最贵的先砍）；缺键回 0（老配置无此键不炸）；**五档全 0 才回默认**——纯情景配比（四档全 0 + scenario > 0）合法。

**生成路由接线**（`POST /api/quiz/generate`）：

- 纯情景配比：**跳过传统引擎**——全 0 配比喂给传统出题提示词只会得到空题组 → 假 502；
- 混合配比：传统题先出，情景套随后逐套生成；每套成功即广播 + 进会话流（与 REST 单套入口共用 `announceScenarioToSession`，一份下发逻辑）；
- **逐套失败如实进 `scenarios[]`，不整体 502**（部分失败不连坐传统题；全失败时响应仍 200，UI 给真因指引）；传统题 502 时跳过情景（失败路径不追加耗时）；
- 情景套**始终落库**（`save=false` 预览语义只对传统题生效——demo 不落库就没有可玩载体，SPEC §4 已约定）。

**UI 口径**：设置卡第 5 行按「套」计；`scenarioMixNote` 补白——成功也报套数（卡片本身看不出一共出了几套），失败按真因给不同指引（no-model → 去绑定模型 / parse → 可重试）。

## 7. 安全边界（为什么这套是安全的）

1. demo 页 CSP sandbox 无 same-origin ⇒ 源为 `'null'` ⇒ 调不了写接口（`security.ts` 不放行 `'null'`）、
   读不到本应用 localStorage。
2. `postMessage` 是 opaque origin 下**唯一**能出沙箱的通道，而能发出正确 `demoId` 的只有被服务端注入过
   桥接的那一页；宿主还有 taskId 白名单。
3. 服务端再复核一道白名单并自行判分——宿主被伪造只浪费一次请求，库不受污染。
4. `observed` 原样进 `judgeTask`，**不落库原文**（M1 不做 observed 快照；笔记快照属 M-notes 批）。

## 8. 分期与验收

| 期 | 内容 | 验收 |
|----|------|------|
| **M1（已实施）** | shared 契约 + v20 迁移 + saveScenario/reportScenario/桥接注入 + 端点 + ScenarioPanel + 题库入口 | 测试内 `POST /seed` 一套手写情景题 → `GET /demo/:id` 含桥接 → `POST /report` 判对/判错各一条 → `quiz_stats` 出数；题库页可见「情景」题并能玩 |
| **M2（本批）** | 出题协议（§6）：`SCENARIO_PROTOCOL` 双标记 + 解析救援阶梯 + 引用完整性检查 + `generateScenario` + `POST /generate` | 解析阶梯 10 例 + 端点 2 例全绿；**真实模型出题入库待真机验收** |
| **M3（本批）** | 聊天流 scenario 卡片（BlockKind 登记 + 渲染器） | 对话内「+」菜单出情景题 → SSE block 进消息流 → ScenarioPanel 内嵌可玩 → 对错进 quiz_stats；历史还原纯函数 8 例 + 路由接线回归 1 例；**真机端到端待目检** |
| **M4（本批）** | study-flow 编排接入 + 薄弱点分析覆盖情景题：`FlowStepKind` 第 7 种 `'scenario'` + **专用执行器** `scenarioStep`（唯一不走 chatStep 的步骤——聊天模型吐不出可接桥接的 demo，直接调 generateScenario 再经与 REST 同一份 `announceScenarioToSession` 下发）+ `buildStepPrompt('scenario')` 抛哨兵错误（穷尽性契约锁）；quiz-weak 形状探测 tasks 分支（越界过滤上界=tasks.length）+ `buildScenarioWeakPrompt`（任务+判据做素材） | 执行器 5 例（wired/无会话抛/入参抛/no-model 抛/announce 落库）+ 薄弱点情景 3 例全绿；flow 画布可拖「情景演练」步骤、跑到该步停下等人玩、对错自动进 quiz_stats；**真机端到端待目检**。⚰️ **2026-09-25 批次 K：本行"编排"半边随学习流整族下线删除**（`flow-executors.ts` 的 `scenarioStep`、`FlowStepKind` 的 `'scenario'`、画布与执行器 5 例一起走；**其中第 5 例测的 `announceScenarioToSession` 是幸存函数，已搬到 `routes/scenario.test.ts` 的 M3 组**），**薄弱点半边与聊天流卡片（M3）原样活着** |

## 9. 已知边界（诚实记账）

- M1 的 observed 不留快照、不落刷题笔记（`upsertNoteFromAnswer` 的 questionData 是 QuizQuestion 形状，
  情景题接入笔记属独立批）。⚠️ **2026-09-25 订正**：那条「独立批」**已被撤销**——刷题笔记功能整体下线（issue #21），
  `upsertNoteFromAnswer` 已从仓里删除，observed 快照不再有"接进笔记"这个去向；要留作答原文得先找新的存储位。
- 桥接脚本 `ready` 事件（`sb-scenario-ready`）仅用于面板显示「已连接」，不作为判分依据。
- M2 的解析阶梯已落地（§6.2/§6.3），但**提示词对 demo 质量的约束只能靠真机模型验证**——
  引用完整性检查保证「接不上的评分点不进库」，不保证「进库的 demo 都好玩」；真机首批生成结果要人目检。
- `generateScenario` 未接联网检索（quiz 的 `search` 能力）：情景题源自材料/主题本身，M2 先不做，
  需要时按 QUIZ-SEARCH-SPEC 同一套账接入。
