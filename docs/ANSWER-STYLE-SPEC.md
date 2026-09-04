# 回答方式偏好（Answer Style）功能契约

> 版本：**v1.0（已实现）** | 状态：[已实现] | 日期：2026-09-04（实现与实测同日回写）
> 实测结论与两处契约偏离记在 **§8**（真机数据不在正文编造，只写在 §8）。
> 范围：**L0（设置页持久化偏好）+ L1（出题前就地弹选项卡）**。
> **不含 L2**（AI 在对话中途自己抛选择题）——那需要挂起/恢复一轮生成，风险与工作量为本文的三倍，
> 决策记 §6「本次不做」。
> 关联：`SSE-CONTRACT.md`（system 段合并契约 B-001）、`QUIZ-IMAGE-SPEC.md`（设置卡与归一回读范式）、
> `dev/test-plan.md`（§7 末六条：涉模型输出的改动必须真机端到端）。
> 本版所有文件名／函数名／行数均已回读源码核实（初稿曾写入不存在的 `quiz-prompt.ts`／`buildQuizMessages`，已更正）。

---

## 0. 目的与不做什么

**目的**：让 studentbuddy 在**出题或长回答之前**，先用几个可点的选项问清「你喜欢我怎么答」，
效果对齐各 AI 编码工具自带的那套选择题问答（一次最多 4 题、每题 2~4 个互斥选项、可自由输入、可记住）。

**三条硬约束（决定本方案形状）**：

1. **不能靠模型自觉去问**。把「每次都要问」做成 function-calling 工具是反模式——工具天生是"模型觉得需要才调"，
   漏问了你看不见。本批的问由**前端事件触发**（点出题按钮），模型只负责按偏好作答。
2. **默认值必须等于今天的行为**。四个维度全部取默认时，出站提示词与现状逐字等价——
   否则用户只是没去设置页点一下，AI 口吻就漂了，属不可接受的隐性变更（锁在 §5 单测里）。
3. **问一次就要记住**。同一个人同一台机器被连环问风格会立刻招烦；答过一次即落库，之后只在原处给一个「改」入口。

---

## 1. 数据模型（`packages/shared/src/answer-style.ts`，新建）

```ts
export type StyleVerbosity = 'brief' | 'standard' | 'detailed';
export type StyleTone = 'peer' | 'teacher' | 'socratic';
export type StyleSupport = 'none' | 'example' | 'analogy';
export type StyleShape = 'prose' | 'bullets' | 'mixed';

export interface AnswerStyle {
  verbosity: StyleVerbosity; // 详略
  tone: StyleTone;           // 口吻
  support: StyleSupport;     // 要不要例子
  shape: StyleShape;         // 结构
}

/** 默认值 = 现状行为（适中长度、老师口吻、不强制举例、段落为主） */
export const DEFAULT_ANSWER_STYLE: AnswerStyle = {
  verbosity: 'standard',
  tone: 'teacher',
  support: 'none',
  shape: 'prose',
};
```

> **【实现偏离登记】** `StyleSupport` 落地的取值是 `'none' | 'life' | 'worked'`，不是本节的
> `'none' | 'example' | 'analogy'`。理由：下方选项表第三行文案本来就叫「生活例子／学科内例题」，
> 取值名跟着文案走更准；`example`/`analogy` 这对反而要先说清「哪个才算例子」。
> 另多两个导出：`SETTING_KEY_ANSWER_STYLE`（键名收在 shared，与 `SETTING_KEY_QUIZ_IMAGE` 同范式）、
> `styleSummary()`（一行摘要，设置卡与出题按钮旁共用，不各写一份）。

**选项文案唯一事实源**也在本文件（前端渲染卡片、服务端拼提示词都读它，两处不各写一份）：

```ts
export const ANSWER_STYLE_FIELDS: Array<{
  key: keyof AnswerStyle;
  question: string;                     // 弹卡上的题面
  options: Array<{ value: string; label: string; hint: string }>;  // 2~4 个
}>
```

| 题面 | 选项（label ／ hint） |
|---|---|
| 回答要多详细？ | 简短／三两句给结论 · 适中／结论 + 关键步骤 · 详细／分步讲透，宁长勿短 |
| 喜欢什么口吻？ | 像老师／术语准确、有定义 · 像同学／大白话、少术语 · 引导式／先反问、你自己想一步 |
| 要不要举例子？ | 不用／就说正题 · 要生活例子／熟悉场景类比 · 要学科内例题／带数字的 |
| 排版怎么排？ | 整段叙述 · 列点为主／能列就列 · 混合／短段 + 表或图 |

`normalizeAnswerStyle(raw: unknown): AnswerStyle`——**逐字段白名单**：非法/缺失字段回落该字段的默认值，
绝不整体丢弃、绝不 400（与 `normalizeQuizMix` 同语义：入参一律归一后回读）。

`buildAnswerStyleBlock(style: AnswerStyle): string`——拼给模型的中文指令段。
**四个维度各有一句专属措辞**（不许写成"根据偏好回答"这种含糊话——含糊等于没生效，是本仓提示词层的老坑）。

---

## 2. 存储与端点

- 存储：`app_settings`，key = `answer_style`，value = JSON 串。
- 端点（挂在既有 `settingsRouter`，`packages/server/src/routes.ts`，**实现后实测 252 行 / 红线 400**）：

| 方法 | 路径 | 响应 | 语义 |
|---|---|---|---|
| GET | `/api/settings/answer-style` | `{ style, configured }` | 未配置过 → `style = DEFAULT_ANSWER_STYLE`、`configured = false` |
| PUT | `/api/settings/answer-style` | `{ style, configured: true }` | 入参过 `normalizeAnswerStyle` 后落库，**回读归一后的值** |
| DELETE | `/api/settings/answer-style` | `{ style: DEFAULT, configured: false }` | 设置页「恢复默认」：**删键**而不是写默认值——写成默认值 `configured` 仍为 true，L1 就永远不再问 |

★ **库里是坏 JSON 时**：读回默认值但 `configured` 仍为 true（键在就是配过，不能把用户重新问一遍）。

★ **`configured` 是 L1 的开关量**：它区分「没配过」与「配成了恰好等于默认的值」——
只有这个布尔能回答"还要不要弹卡问一次"。`AnswerStyle` 本身表达不了（默认值与真实选择长得一样）。

写操作吃既有的 Origin 跨源闸门（与其余设置接口同一条，不新写校验）。

---

## 3. 生效点（三处，都有现成范式）

1. **对话长回答**（`chat/flow.ts`）：新增一段 system 指令。
   **必须计入 `systemPromptTokens` 后再截断历史**——flow.ts 第 88-90 行的注释就是为这类漏算立的规矩
   （词条段/资料段都算进去了，风格段漏算就是同一个坑复刻）。
   位置：与 `termBlock`/`docBlock` 并列 push，保持多段 system 现状（适配器全量合并已有回归锁 B-001）。
   实现：`const styleBlock = buildAnswerStyleBlock(loadAnswerStyle())`，排在词条段/资料段**之后**入 system 数组
   （回归锁：`flow.test.ts` 13→17 例，含「四条 system 全部下发」的 `anthropic.test.ts` +1 例）；本文件现 **310 行**。
2. **出题题干与解析**（`learning/quiz.ts` 的 `generateQuiz`）：该函数把提示词内联拼成**单条** `role: 'user'`
   消息后下发（无独立的 prompt 组装文件，实测 `learning/` 下不存在 `quiz-prompt.ts`），
   风格段就在拼 `prompt` 处与 `buildMixInstruction`／`buildImageInstruction` 并列 concat。
   实测段落顺序：**协议 → 配比 → 配图 → 偏好**（偏好排最后，不插进协议与配图之间，这条钉在 `quiz.test.ts`）。
   ★ **行数账实测**：`quiz.ts` 由 393 → **397/400 行**，余量仅 **3 行**（本批净增 4 行：import 2 + 可选参数 1 + 拼接行改写）。
   下批任何再动 `quiz.ts` 的改动都必须先搬迁腾行（候选：把题库四函数 `saveQuiz`/`listQuiz`/`getQuiz`/`deleteQuiz`
   约 38 行搬去独立文件）——门禁红的是 CI，不是运气。
   【实测补记】§8 那条 LaTeX 转义修复接进 `parseQuizBlock` 时**净增 0 行**（只在既有那一行里多套一层），
   正因为余量只剩 3 行，没余量的批次就别想顺手加修复——这就是把行数写进契约的意义。
3. **聊天页/题库页的「出题」**（L1，见 §4）：`routes/quiz.ts`（现 **126 行**）body 收可选 `style`，
   未传则传 `undefined` 下去，由 `generateQuiz` 自己读库内偏好的（**只读一处，不在路由里提前定级**）。

**服务端读写放新建的 `packages/server/src/storage/answer-style.ts`**（`loadAnswerStyle` / `saveAnswerStyle`，
现 **46 行**；照 `quiz.ts` 里 `loadQuizMix`/`saveQuizMix` 的 `app_settings` 套路：读不到或 JSON 坏都回退默认、
落库前先归一。此外多两个导出：`isAnswerStyleConfigured()`（**只查键在不在**，这是 `configured` 的唯一真相）、
`resetAnswerStyle()`（删键）。
★ 不要塞进 `quiz.ts`：它是对话全局设置，与出题域无关，何况那文件本批做完只剩 3 行。

风格段只影响**表达**，不影响**协议**：`[QUIZ]` 的字段格式、`svg` 配图契约、配比钳位一概不动。
出题风格与配图开关相互独立（`quiz_image` 管画不画，本卡管话说多少）。

---

## 4. L1：出题前就地弹选项卡（`AskStyleCard`）

**新组件** `packages/web/src/features/chat/AskStyleCard.tsx`（现 **128 行**，四行 chip，
不新增 modal 基元、不加遮罩——内联在按钮上方，点「就按这个出题」即收起）。

> **【实现偏离登记（样式）】** 本行原写「样式复用 `quiz-mix-chip`/`.active`」，落地改为自包含：
> 共用件 `components/StyleChips.tsx`（49 行）+ 自己的 `components/style-chips.css`（自有 `.style-chip`），
> 弹卡骨架另走 `features/chat/ask-style.css`（67 行）。理由：`components/` 下的共用件隐式依赖
> 某个 feature 的私有样式（`settings.css`）是脆弱耦合——哪天设置页改类名，聊天页的 chip 会静默裸式。
> 门禁另两条照旧满足：零 `style={{`、零 `any`。

> **【实现偏离登记（入口位置）】** §4-2 说的「摘要 + 「改」链接」落地为：摘要追在**已有的配比行后面**
> （实测渲染：「出题配比：单选题 2 · 填空题 1 · 解答题 1｜回答方式：简短 · 像老师 · 不用 · 列点为主 · 设置页可改」，
> 四段文案由 `styleSummary()` 直出，与卡片同字），没另开一个「改」链接：
> 那一行已经指了「设置页可改」，再挂个入口就是两个地方说同一件事。

**交互流程（写死，前端不给自由发挥空间）**：

1. 用户点「出题」/「一键出题」（题库页输入框的 **Enter 也走同一条路**，否则回车可绕过弹卡）。
2. 若 `configured === true` → **照旧直接出题**，一行都不弹；按钮旁已有配比摘要，追加风格摘要 + 「改」链接。
3. 若 `configured === false` → 展开 `AskStyleCard`（四行都预选默认值），两个出口：
   - **「就按这个出题」**：本次带 `style` 参数出题；若勾了「记住，以后别问了」→ 同时 `PUT` 落库（`configured` 转 true）。
   - **「别问了，直接出」**：用默认值出题并 `PUT` 落库（**也算已配置**，不再骚扰）。
4. 勾了「记住」的那次出题，`style` 参数与落库值必须同一个（不能屏上选 A、库里存 B）。

**单次覆盖**：`POST /api/quiz/generate` 的 body 增加可选 `style`，与既有 `mix` 的"本次显式传了就覆盖全局"同语义；
缺省则读库内偏好，库内没有则 `DEFAULT_ANSWER_STYLE`。

**实现手法（两页共用一个 hook）**：读写、勾「记住」就顺手 `PUT`、单次覆盖、摘要与轻提示全收在
`useAskStyle(run)` 里（返回 `{ tap, card, summary, hint }`），`ChatView` 与 `QuizBankPage` 各只加 4~6 行。
三处行为写在这里，因为它们都是实测决定的、下批很容易改坏：

- `configured` 初值是 **true**：偏好还没读回来时按「配过」处理——宁可少问一次，也不在出题路上插队。
- `persist` **失败也照常出题**（本次覆盖照样生效，只是下次还会问）；不能因为存不上就把功能堵死。
- 「别问了，直接出」走 `persist(DEFAULT_ANSWER_STYLE)` 再 `run(归一后的默认值)`，**屏上选什么与库里存什么必须同源**。

**对话发送（`/api/chat/send`）不弹卡**：只在**新会话的第一条消息**前，若 `configured === false`，
在 composer 上方轻提示一次「要先告诉我喜欢你怎么答吗？→ 设置」。理由：对话是随手打字的地方，插选择题打断感太强。

> **【实现偏离登记（轻提示触发条件）】** 落地没做「仅新会话首条」的限定：只要 `configured === false`
> 就在 composer 上方挂一行（聊天页与题库页都挂），配过或点了「记住」就自然消失。理由：限定「首条」
> 需要多一个「本会话提过没有」的状态，而它的唯一作用是少显示一行——不划算，且容易做成刷新后又弹。

---

## 5. 测试计划——已实现，逐条实测（基线：全量 **26 文件 / 302 例全绿**）

| 本节原计划 | 落在哪 | 实测结果 |
|---|---|---|
| `normalizeAnswerStyle` 非法值/缺字段/非对象 → 逐字段回落默认，不抛 | `shared/answer-style.test.ts` | [DONE] 18 例中的 3 例：`null`/数字/数组/空串不抛；合法+非法+缺失混给 → 合法的进、其余各自保默认（**不是整份作废**） |
| 默认值输出包含现状等价口径，且四维各有独有措辞 | 同上 | [DONE] 「12 句指令措辞两两不同」+「默认段 = 1 行护栏 + 4 行指令」+「默认段只含现状等价口径、不含新增强指令」；改任一档必改输出（逐档扇出断言） |
| 卡片文案与提示词同源 | 同上 | [DONE] 正好 4 题·每题 2~4 选项·label ≤6 字能进 chip·value 必在类型联合取值内 |
| `routes/answer-style.test.ts`：未配置/读写一致/非法归一/无 Origin 403 | `routes/answer-style.test.ts` | [DONE] **8 例**，比计划多 4 条：存「恰好等于默认的值」后 `configured` 仍 true、body 没 `style` 字段时全默认落库（PUT 是"存我给的"不是"改我给的"）、**库里是坏 JSON → 读回默认但 `configured` 仍 true**、DELETE 后回到未配过态 |
| `generate` 传 `style` → 出站 prompt 含风格段 | `learning/quiz.test.ts` 33→37 | [DONE] +4 例：未配置也带默认档且含出题护栏、不传 `style` 则读库内、显式传只覆盖本次且**不两段并存**、段落顺序固定为配比→配图→偏好 |
| 对话长回答真的注入风格段（计划里没这条，**做的时候补上**） | `chat/flow.test.ts` 13→17、`llm/anthropic.test.ts` 10→11 | [DONE] +5 例：未配置也注入且排一切注入段之后、改库内偏好下一轮随之变、**偏好段只进上下文（屏上与库内正文都不含它）**、删键后回到默认段；适配器「四条 system 全部合并下发」（风格段使 system 从三条变四条，B-001 那条锁必须跟进） |
| api 客户端契约（B-003 通则，计划里没这条） | `web/lib/api.test.ts` 2→5 | [DONE] +3 例钉 GET 路径/PUT 带 `{ style }` 体/DELETE 无体且回 `configured:false` |
| **真机**：两档对比、必须换材料破缓存 | §8 | [DONE] **量化对比而非肉眼了事**（见 §8 表），但得出一条不好听的结论：`shape=bullets` 在短回答上根本不出列点 |

★ 上一行那条是本轮唯一的「测试计划本身不够硬」的欠账：§5 只写了「肉眼核回答确实变短变列点」，
真机靠**长度均值 + 列点行占比**量化后才发现：简短档下 bullets 占比 0.00——不是 bug，但也不能拿它当已验收。

---

## 6. 本次不做（明确记账）

- **L2：AI 在对话中途抛选择题追问**。要动四处：`ToolContext` 加等待能力、独立 `POST /api/chat/answer`
  端点（答案走 `/chat/send` 会被 flow.ts 的同会话串行锁排队自锁）、pending 的超时/中止/幂等收口
  （`tsx watch` 一重启内存 promise 就悬空，超时不是可选项）、以及 `[ASK]{…}[/ASK]` 落 messages 才能刷新复原
  （照 `routes/quiz.ts` 里 `[QUIZ]…[/QUIZ]` 那份先例）。且要先探针实测「模型调 ask_user 的命中率」再决定做不做。
- 按角色分别设风格（explain/quiz/analyze 各一套）：先要一份，用得好再拆。
- 会话级风格覆盖（本会话专用、不改全局）：`sessions` 表要加列，收益不明。
- 判析（`/api/quiz/analyze/:id`）注入风格：本批只管题干与讲解。

---

## 7. 工作量与顺序——六步全走完

| 步 | 内容 | 估时 | 状态 |
|---|---|---|---|
| 1 | shared `answer-style.ts` + 单测（含默认值等价现状那条） | 1.5h | [DONE] 130 行 / 18 例 |
| 2 | server 读写端点 + `routes/answer-style.test.ts` | 1h | [DONE] `storage/answer-style.ts` 46 行、routes.ts +24 行、8 例 |
| 3 | server `storage/answer-style.ts` 读写 + flow.ts / quiz.ts 注入风格段（含 `systemPromptTokens` 计入） | 1.5h | [DONE] flow 310 / quiz 397，+9 例回归锁 |
| 4 | 设置页 `AnswerStyleCard`（四行 chip，点选即存 + 恢复默认） | 1.5h | [DONE] 88 行，共用 `StyleChips`；挂在 `QuizMixCard` 之前 |
| 5 | L1 `AskStyleCard` 接入两处出题按钮 + `generate` 的 `style` 覆盖 | 2h | [DONE] 两页各 4~6 行（同一个 hook）；题库页 Enter 也走同一条路 |
| 6 | 门禁三绿 + 真机风格对比复验 + 本文件回写「已实现」 | 1h | [DONE] lint/gates/302 例 逐命令核 EXIT；真机结论见 §8 |
| 附 | 第 6 步真机跑出来的解析层缺陷（不是原计划，**因本批才暴露**） | +2h | [DONE] `repairJsonEscapes` + 护栏句，见 §8.3 |

合计约 **1 天**（实做略超，超出部分全在 §8.3 那条真机缺陷上）。文档先行：本契约批复后才动码；
实现与测试完成后回写本文状态并同步 test-plan / CHANGELOG / AGENTS.md（目录速查新增五处、`app_settings` 登记
`answer_style` 键、M2 里程碑一行、`quiz-json-repair.ts` 的职责补上「修非法转义」，并在「已知约束」里写明那处故意不修的局限，见 §8.3）。

---

## 8. 真机实测结论与遗留风险（2026-09-04 22:00–22:30，本地实例 + agnes 中转）

**验证手法**：全部走工作区脚本 `verify-*.mjs`（打 HTTP 接口，不改仓库配置），每次 `save:false` 不留题库垃圾，
结果 `writeFileSync(..., 'utf8')` 落盘——PowerShell 管道会把中文按 GBK 重编码，**终端里的乱码不代表接口返回错**。
每换一个主题破一次 prompt 缓存（test-plan §7 那条）。

### 8.1 端点与 `configured` 语义：全部符合契约

| 请求 | 实测 |
|---|---|
| GET（未配置） | 200 `{standard/teacher/none/prose, configured:false}` |
| PUT `{brief,teacher,none,bullets}` | 200 回读一致、`configured:true` |
| PUT `{verbosity:'hmm', ...}` | 200，**逐字段回落**：verbosity→standard、缺失的 support→none，其余照收，不 400 |
| PUT 无 Origin | **403**（与其余设置接口同一道闸门） |
| DELETE | 200 回默认 + `configured:false` |

### 8.2 风格差异是真的，不是安慰剂

测的是出题解析长度与列点行占比（同口径、各换主题）：

| 档位 | 来源 | 解析均长 | 最长 | 列点行占比 |
|---|---|---|---|---|
| 库内 A：brief + bullets | 主复验脚本 | 51 字 | 69 | 0.00 |
| 默认档（未配置） | 同上 | 136 字 | 197 | 0.00 |
| 单次覆盖 B：detailed + prose | 同上 | 287 字 | 401 | 0.00 |
| detailed + bullets | 形状专项脚本 | 312 字 | 行 30 中 26 列点 | **0.87** |

- **结论 1**：`verbosity` 生效显著（51 → 136 → 287 字，三倍跳度），默认档落在中间，与「默认＝现状」一致。
- **结论 2（不好听但如实写）**：`shape=bullets` 在 brief 档下**占比 0.00**——两三句话的解析没有可列的结构，
  模型列不出来；把其他维拉到 detailed，同一维占比立刻 0.87。**两维是相乘关系不是各自独立**。
  若下批要「选了列点就必须有列点」，得在指令里补「即便只有一两句也用 `-` 起头」，
  本批不改（优先保 §0 硬约束 2：默认值等价现状，不愿为了演示效果改提示词基线）。

### 8.3 真机跑出来的真缺陷（已修）：detailed + bullets → 出题 502

- 统计（修复前，同档 7 次、主题全不同）：**4 成功 / 3 次 502（43%）**；同期非该组合 6 次 **0 次失败**。
  502 全落在 27~60s 的长输出上，文案是那句笼统的「模型不可用或解析失败」。
- 排查：先排除硬截断（成功样本 `truncated:false`、`quizChars=3106`、`max_tokens`=8192），
  再定位到 **`JSON.parse` 层**——详细+列点让解析里 LaTeX 变多，而模型在 JSON 字符串里本该写两根
  （`$\\sin\\theta$`，解出来才是 `$\sin\theta$`），却常直出一根（`$\sin\theta$`）——
  剩下的 `\s` 是**非法 JSON 转义** → `JSON.parse` 抛 → 整组题判死；既有的 `repairJsonBrackets` 只补漏括号，管不到这件事。
- 修复（双保险）：① `quiz-json-repair.ts` 新增 `repairJsonEscapes`——逐字符扫，串外照抄、合法转义成对消费、
  `\uXXXX` 需紧跟 4 位 hex，其余反斜杠补成两根；**与补括号同一条入场券：合法 JSON 上永不触发**（有回归锁），
  故直接当所有尝试的基底，且**必须先修转义再扫括号**（转义不修好，括号扫描连字符串边界都会认错）。
  ② quiz 护栏句补一句「字符串内的反斜杠必须写成两根（如 `\\sin`），整套题必须一次写完」。
  行数代价：`quiz.ts` **净增 0 行**（只在既有那行里多套一层）、shared 2 行、repair 一个新函数。
- 复验（修复后，同档同题材，含此前 502 的两个主题）：**4/4 HTTP 200，每次 4/4 题都带反斜杠序列**。
  回归锁 6 例（`quiz-json-repair.test.ts` 10→16）。
- **已知局限（如实钉住，不偷偷扩权）**：`\theta`、`\nu` 这类首字母恰好撞合法转义的写法（`\t`=tab、`\n`=换行）
  **故意不修**——修它就得猜模型本意，会把真的制表符/换行改坏；这类题文字会坏成控制字符但仍能解析出来，
  有一条用例专门钉这个行为。要根治靠提示词侧护栏（已加）或渲染侧容错（本批不做）。

### 8.4 未验 / 遗留风险（不得当已验收）

- **未做浏览器截图与真人主观确认**：弹卡视觉、chip 排布、「勾了记住」后不再弹的实际手感，
  需老板在 :5173 上点一遍（§0.15 体验类不自行验收）。
- **socratic / peer / life / worked 四档没逐个真机量化**：只量了 verbosity 与 shape 两维（差异最可见的两维）；
  其余靠 §5 的「12 句指令两两不同」+「改档必改输出」静态锁——那是**指令已下发**的证明，
  不是**模型已照做**的证明。
- 风格段已计入 `systemPromptTokens`（有 flow 回归锁），但**未量过长会话下多这一段对历史截断深度的实际影响**。
- 判析（`/api/quiz/analyze/:id`）未注入风格（§6 明确不做）。
- **实测期间用户自己也在真机试用**：库里 `answer_style` 现为「默认档 + `configured:true`」
  （22:06 由浏览器点「别问了，直接出」写入，并留下一条「综合知识小测」入库）。
  这不是测试残留，**未擅自删除**；要回到没配过态，设置页「恢复默认」即可。
