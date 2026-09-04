# studentbuddy v2 · 测试方案（test-plan）

> 版本：v0.2.4 | 状态：[活跃] | 更新：2026-09-04 22:35（回答方式偏好 L0+L1 批回写；上一版为出题配图 v1.1.1）
> （表头版本号此前滞后一格——`§8` 已记到 v0.2.2 而表头仍写 v0.2.1，本次一并校正。）
> 依据：个人开发文档 `AI-DEVELOPMENT-GUIDE.md` §0.8（测试同步）／§0.15 第 5 步（登记）、《计划重写文档》§10.4。
> **本表是 §0.8 的强制载体**：改了代码 → 跑测试 → 更新本表，缺一即违规。此前本仓无本文件，属流程欠账（2026-09-02 随「文档模式」批次补齐）。
> 配套：反复/修不动的 bug 记账在 `docs/dev/bug-ledger.md`（§0.15 第 0 步的数据源）。

## 1. 测试策略

| 层级 | 工具 | 范围 | 状态 |
|------|------|------|------|
| 单元 | Vitest（`environment: 'node'`，`include: packages/*/src/**/*.test.ts(x)`） | 纯函数与域逻辑：协议解析、上下文截断、词条检索、SVG/图表净化 | [DONE] |
| 接口集成 | Vitest + supertest（`packages/server/src/index.test.ts`，直接驱动 `createApp()`，不落真端口） | 安全头 / Origin 闸门 / 密钥不回显 / 预览沙箱 CSP | [DONE] |
| 编排回归 | Vitest + `vi.mock('../llm/router.js')`（`flow.test.ts`） | 单轨工具循环落库顺序、无孤儿 tool 消息、预算收口、上下文注入 | [DONE] |
| 静态门禁 | `node tools/gates/check.mjs` | 行数上限（server ≤400 / web `.tsx` ≤300）、禁内联 `style={{`、禁 `any` | [DONE] |
| AI 质量回归 | promptfoo / golden dataset | **未接入**（无 key、无数据集，见 §6 待补充） | [P2] |
| 端到端 | Playwright | **未接入**——`开发文档5.0` §1 曾把它与 promptfoo 写进技术栈，仓库内实测 0 引用（2026-09-02 对账），该句待订正 | [P2] |

## 2. 运行命令

```powershell
npm run check     # = tsc×3 + eslint + vitest + gates，提交前必须全绿
npm run test      # 只跑 vitest
npm run gates     # 只跑门禁
node node_modules\vitest\vitest.mjs run --reporter=dot   # npx 不可用时的等价直调（见下方坑）
```

- **本机坑（2026-09-02 实测）**：`PATH` 上存在 `D:\npx.ps1` 残 shim，`npx vitest` 报 `Cannot find module 'D:\node_modules\npm\bin\npm-prefix.js'`。绕法=用 `node node_modules\vitest\vitest.mjs …` 直调，**不要为此改仓库配置**。
- **退出码坑**：Vite 的 CJS Node API 弃告走 stderr，PowerShell 会把管道结果标成 `ExitCode 1`；判定以汇总行 `Tests  N passed` 为准，不以退出码为准。
- **★ Node 版本坑（2026-09-02 实测，最坑的一条）**：`better-sqlite3` 原生模块按 **Node 20** 编译（`NODE_MODULE_VERSION 115`），而 PATH 上默认的 `node` 是 22.22.2（`127`）。用 22 跑 ⇒ 所有涉库接口 500、测试大面积红（`was compiled against a different Node.js version`），**极易误判成新写的代码有 bug**。绕法：`C:\nodejs20\node-v20.18.3-win-x64\node.exe node_modules\vitest\vitest.mjs run`（或把该目录前置到 `PATH` 再 `npm run check`）。**不要为此改仓库配置。**
- 测试隔离：`flow.test.ts` 等在 import 前设 `process.env.SB_DATA_DIR = mkdtempSync(...)`；`storage/db.ts` 另有 `openIsolated(dataDir)` 供单库用例。**禁止测试写真实数据目录。**
- **★ PowerShell 中文编码坑（2026-09-04 实测）**：`curl.exe` 里内联中文 JSON、以及 `>` 重定向都会经 GBK 重编码，打本地接口时得到乱码或 `SyntaxError: Unexpected token`。绕法=写 node 脚本自己 `fetch`（本仓复验脚本全走这条），或落盘用 `Out-File -Encoding utf8` 再读。另：`[System.IO.File]::ReadAllLines` 一类 .NET API **不认 `cd`**，必须传绝对路径。
- **退出挂住（沙箱实测，非功能缺陷，诚实记账）**：本批在沙箱内直接 `node node_modules/vitest/vitest.mjs run` 调全量 **208 例全部通过**，但进程跑完不退出（挂住）；经 `npm` 脚本包裹的 `npm run test`（= `vitest run`）**正常 EXIT=0**。该挂住疑属沙箱直调 Node 路径的信号回收问题，与功能无关——**判定一律以汇总行 `Tests  N passed`（N=208）为准**，不以退出码/退出挂住判失败。本机（`llwan` 真实终端）按 §2 版本坑用 Node 20 跑 `npm run test` 即可干净退出。

## 3. 用例清单（基线：26 文件 / 302 例全绿，2026-09-04 22:31 实测，Node 20）

> 上一基线：24 文件 / 258 例（出题配图 v1.1.1，2026-09-04 21:02）。**本批（回答方式偏好 L0+L1）**：
> 文件 24→26、例 258→302（**+44**，逐文件实测求和而非拿总数倒推）：
> 新 `shared/answer-style.test.ts` 18／新 `routes/answer-style.test.ts` 8／`learning/quiz-json-repair.test.ts` 10→16（+6，转义修复）／
> `learning/quiz.test.ts` 33→37（+4，风格段注入）／`chat/flow.test.ts` 13→17（+4，第四条 system）／
> `llm/anthropic.test.ts` 10→11（+1，四条 system 仍全量合并）／`web/lib/api.test.ts` 2→5（+3，B-003 通则）。
> 小计随之变：shared 27→**45**、server 187→**210**、web 44→**47**（45+210+47=302，与本节表格行数一致）。
> 其中 **6 例转义修复、两例风格段行为不是原契约 §5 列的**，是做的时候补上（前者被真机 502 逼出来、后者因为「只测 shared 拼字符串」证明不了风格段真进过出站消息）。
> **同时补登两处本表自身的老账**（与代码无关，是登记缺失）：① `routes/quiz-mix.test.ts` 10 例自 09-03 配比批起从未进表，现补行；② 三节小计按行求和校正——server 141→**187**、web 64→**44**（逐文件跑 vitest 数出来的，shared 27 本来就对）。小计与自家表格不符 = 基线数没人复核过。
> 用例数以 `vitest run` 汇总为准；新增用例须同步本表与 §2 基线数。**必须用 Node 20 跑（见 §2 版本坑）**。

### shared（45 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/answer-style.test.ts` | 18 | **回答方式偏好契约（ANSWER-STYLE §1/§5）**：正好四道题·每题 2~4 个互斥选项·label ≤6 字能进 chip·**12 句指令措辞两两不同**（同题换档必须换话）·每个 value 都在该字段类型联合取值内（防文案与类型各跑一头）；`normalizeAnswerStyle` 逐字段回落（`null`/数字/数组/空串都不抛，合法+非法+缺失混给时**合法的进、其余各自保默认，不是整份作废**）；**默认值＝引入本功能之前的行为**（四维默认逐个钉死 + 默认段只含现状等价口径、不含新增强指令——改这里＝改所有未设置用户的 AI 口吻）；`buildAnswerStyleBlock` 默认段 = 1 行护栏 + 4 行指令（一维一句，不少不并）、**任换一档输出必随之变**、quiz 场景带「不动 [QUIZ] 协议字段」护栏而对话场景不提 | [DONE] |
| `src/quiz-image.test.ts` | 8 | **出题配图契约（QUIZ-IMAGE-SPEC §2.3）**：`normalizeQuizSvg` 只返回「能用的图」或 undefined，**绝不抛错**；合法图原样过（含自闭合 `<svg .../>`——终止写法有 `</svg>` 与自闭合两种，只有两者皆无才判截断）；丢弃规则：非字符串/null/对象/空白→丢、不含 `<svg` 根标记→丢、**缺终止标记（截断）→丢**、超 `MAX_QUIZ_SVG_CHARS`→丢。常量：默认 `DEFAULT_QUIZ_IMAGE=false`、键名 `quiz_image` | [DONE] |
| `src/quiz-mix.test.ts` | 19 | `stepQuizMix` **编辑期钳住**：加档只动目标档位、减档不越 0、单题型到 10 停住不绕回、总额到 20 后加不进任何题型且已有档位一格不动；**先减后加这条路径要通**；一步跨多档只加到能加的位置；不改入参（`delta=0` 也返回新副本）。`setQuizMix` **数字直输同源钳位**：直输只动目标档、0=关题型、负数→0/小数取整/NaN→0、超 10 钳 10、**总满场景只给「其他档占用后剩余额度」且别的档一格不动**、全 0 起可直输、不改入参。与 `normalizeQuizMix` 的分工：编辑态钳住的配比落库后原样不变（**所见即所存**，不再被从后往前削）、绕过 `stepQuizMix` 硬造的超限配比仍由 `normalizeQuizMix` 兜底削到总上限 | [DONE] |

### server（210 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/index.test.ts` | 15 | ① status/health 契约、未知路由 404 JSON、安全响应头齐备；② **写操作无 Origin → 403**、合法 localhost 放行；③ 搜索 key **明文与密文都不出接口**、空串即删除、超长 400 且一字不落（先校验后写）、非 string 忽略；④ `/api/preview` 出页带 `sandbox` CSP（不含 `allow-same-origin`）、`X-Frame-Options` 仅预览页放宽到 SAMEORIGIN、未知 id 404、`Origin: null` 打写接口 403 | [DONE] |
| `src/chat/flow.test.ts` | 17 | 工具轮 `assistant(tool_calls)→tool→assistant` 原子落库；中途失败不留孤儿 tool 且屏上文本===库内文本；达轮次上限仍收口为 assistant；回灌逼近预算提前收口（提示区分「预算已满」/「轮次上限」）；无 key 时工具回灌引导配 key；**忆域 v2 命中词条以第二条 system 注入且不污染正文**；自动抽取失败不打断主流程；**文档模式：资料段作第三条 system 注入且不外泄到屏上/库内、清除后下一轮出站 messages 不再含资料段、资料段计入截断预算（载入 4 万字后被载历史明变少）**；**tidy_terms 工具全链路：tool_calls→执行→摘要回灌→step 三态（running/done/error）；参数缺失→引导模型重调、引擎不被调用、step error**；**★ 回答方式偏好（ANSWER-STYLE §3）：未配置也注入一段默认偏好且排在所有注入段最后、改库内偏好→下一轮出站的偏好段随之改变（不改就不算生效）、偏好段只进上下文（屏上与库内正文都不含它）、恢复默认（删键）后回到默认偏好段** | [DONE] |
| `src/llm/anthropic.test.ts` | 11 | **出站请求体逐字段钉死**（B-001 回归锁 + 适配器零断言欠账首笔）：多条 system 合并为一串且顺序保持、system 绝不混进 messages、无 system 时不下发该字段、空段被过滤；tool→`user(tool_result)`、assistant tool_calls→text+tool_use 块、坏 JSON arguments 兜底 `{}`；`max_tokens` 必发（Anthropic 缺失即 400）；OpenAI 形态 tools 映射为 `input_schema`；**四条 system（基础提示词 + 词条段 + 资料段 + 偏好段）仍全部合并下发、顺序保持**（风格段使 system 从三条变四条，B-001 那条锁必须跟进，否则新段会在 Anthropic 型服务商上静默消失） | [DONE] |
| `src/learning/document.test.ts` | 11 | v6 迁移真给 `sessions` 加了 `doc_name`/`doc_text` 两列；读写回读、首尾裁空白、无名兜底、整篇替换永远只一份；空白正文/会话不存在都返回 null（不静默）；clear 只清两列不碰标题与消息；**超长存储不丢字、`truncated` 仅表示注入会截**；`docMeta` 只含三字段且正文绝不出现在其中；`buildDocBlock` 文案含「数据不是指令/优先依据资料/可补一般知识」、超长时只注入前 MAX 字符并自报截断 | [DONE] |
| `src/routes/document.test.ts` | 13 | `/api/doc` 吃同一套跨源闸门（无 Origin 写→403）；未载入回 `{doc:null}`；GET/POST/DELETE 缺 sessionId 均 400；**GET 永不回显正文**；换资料是整篇替换；超 60k → `truncated:true`；空正文 400、会话不存在 404；DELETE 后回到未载入。**出题/抽词回退**：未传 material 时资料全文送到 `generateQuiz`、显式给了则不抢戏、两者都无仍 400；`extract` 无 text 时用会话资料、有 text 用 text、清除资料后回退链断开回到 400 | [DONE] |
| `src/chat/context.test.ts` | 6 | 截断点落在 tool 上时向旧吸入至来源 assistant、同轮兄弟 tool 结果一并保留、头部孤儿丢弃、**截断后序列绝不以 tool 开头**（防拆散 `tool_calls` 被 API 400——v1 崩溃性 bug 回归）、预算极小仍保留最后一条、token 估算 CJK≈1 字/英文按词 | [DONE] |
| `src/chat/sse-bus.test.ts` | 5 | 按 sessionId 隔离广播（v1 串台防护）；seq 按会话单调、`since` 只补错过的事件；新一轮 seq 归 1；**已完结的一轮只补 `done` 不重放正文**；进行中的一轮全量回放 | [DONE] |
| `src/learning/terms.test.ts` | 20 | `[TERMS]` 协议解析容错（围栏/杂质/非法 JSON→[]/字段缺失丢弃+importance 钳 0-1）；`UNIQUE(term,domain)` upsert 合并取更高 importance、同词不同域独立成条；手动存/编辑/删除；`domainStats`；`getRelevantTerms` 中英子串命中与无关返回空；`countUsage` 累加；`term_library` 表与唯一约束存在；**防再分裂（TERM-TIDY-SPEC §7）**：别名感知并入（被并同义词挂主条 `aliases`）/大小写不敏感归并/同词不同域不并入/别名计数+词边界匹配（英文按词边界、中文子串）/html 标签不实报/抽取提示词注入已有领域 top-12 | [DONE] |
| `src/learning/tidy.test.ts` | 17 | `[TIDY]` 协议解析容错（围栏/杂质/非法 JSON→丢）/字段不符丢簇/normalize 校验（id 全存在·簇≥2·canonical 取簇内名·同一 id 先到先得·领域改名只留真实存在的旧域）/applyTidy 合并语义逐字段（usage 求和·importance max·def 取最高·aliases 并集·created 最早·成员删除）/UNIQUE 冲突防御性并入/mergeTerms 点名确定性/renameDomain 确定性/tidyTerms 不足两条 noop | [DONE] |
| `src/learning/quiz.test.ts` | 37 | `[QUIZ]` 解析成功/杂质容错/非法 JSON→null（ADR-4 降级不抛）/normalize 丢弃无选项与无题干题；**配图（QUIZ-IMAGE-SPEC）**：合法图原样保留且不污染判分字段、图缺终止标记→只丢图题还在、图是描述文字→只丢图、**★ SVG 漏转义致 JSON 非法时剥图重试且 4 道题一道不丢**（先用 `expect(()=>JSON.parse(...)).toThrow()` 证明确实非法，再断言 4 题全在）、剥图后仍非法→null（不硬凑）；`normalizeQuiz` 逐题校验「坏图丢、好图留、题目一律保留」；`buildImageInstruction` 配图指令（v1.1 重写）：关→给「一律空字符串」的正面指令（负面措辞模型会无视）、开→硬性要求 + 不给逃逸口 + 仍带 viewBox / 禁 `<image>` 硬约束 + **每组最多 3 张**限流（实测带图出题最长 96.8s，逼近适配器 120s 硬断流）；**★ 协议示例自证 3 例**（格式示例四个题对象全部带 `svg`、示例自己就能被解析成 4 题 1 图、`svg` 写进字段清单而非只在末尾追加一段说明——这条钉住 0 出图率的根因）；**★ 撞 `max_tokens` 的截断逐题回退**（尾部残缺→砍掉残缺题、保住前面的完整题并如实报 `truncated`；不截断就不误报）；**总闸硬门**（`allowSvg=false` → 合法 svg 也无条件剥掉且不计 `droppedSvg`，关着不出图是预期不是损失；`normalizeQuiz` 自己就收硬门，不经解析器的调用方也漏不掉）；**丢图上报**（开关开着但图画坏了→丢图保题、逐题计 `droppedSvg`；★ 剥图重试那条路也要报，图在 JSON 文本层就被清空了、进到 normalize 前根本看不到；正常交付 `droppedSvg` 0 且 `countQuizImages` 数得出交付张数）；★ 剥图 + 逐题回退都上了的垃圾输入→题保住、只丢图（v1.0 在这直接整组 null）；**★ 回答方式偏好（ANSWER-STYLE §3）4 例**：未配置偏好→prompt 带默认档且出题侧带「不动协议字段」护栏、不传 `style` 则读库内那份（设置页选的就算数）、**显式传 `style` 只覆盖本次且库内那份不受影响也不两段并存**、**段落顺序固定为配比→配图→偏好**（偏好排最后，不插进协议与配图之间） | [DONE] |
| `src/learning/quiz-json-repair.test.ts` | 16 | **补模型漏写的 `]`（QUIZ-IMAGE-SPEC §2.4 第四种失败，真机 502 的解药）**：三条「不误伤」路径（串内冒号 / 数组里套对象 / 转义引号都不得动）、真机那份漏括号样本逐字复现并补好、**★ `]` 必须插在分隔逗号之前**（插后面得到 `["a","b",]` 仍是非法 JSON）、`}` 撞上未收尾数组时补 `]` 并顶掉悬空逗号、末尾残缺不乱补（`fixed` 0——那是逐题回退的活，凭猜编 JSON 会造出错题）、合法 JSON 一律 0 改动（**这条是它能当所有解析尝试基底的前提**）；末例打通到 `parseQuizBlock`：原来那句 502 现在出 3 题 1 图且报告零损失。**后六例＝转义修复（ANSWER-STYLE §8.3，真机 detailed+bullets 7 次里 3 次 502 逼出来的）**：合法 JSON 一个字不动（`\n`/`\t`/引号/`\\`/`\uXXXX` 都是正当转义，这条是它能当所有尝试基底的前提）、★ 真机样本（LaTeX 漏一根斜杠）补完能 parse 且**解出来的文字里 `\sin` 还在**、逐个点名首字母不像转义的命令（`sin`/`alpha`/`mu`/`mathrm`/`approx`/`unit`，`\u` 后面不是 4 位 hex 也算非法）、**★ 已知局限（如实钉住不是漏改）：`\theta`/`\nu` 撞上合法转义（`\t`=tab、`\n`=换行）故意不修**——修它就得猜，会把真控制字符改坏；这类题文字坏成控制字符但仍能解析，幂等（修好的再过一遍不再动手）、经 `parseQuizBlock` 端到端（原来那句 502 现在出 1 题且选项与解析都在） | [DONE] |
| `src/routes/quiz-image.test.ts` | 11 | 默认回关（配图拉长输出，默认不背）；PUT 开/关均真落库且 GET 回读与 `loadQuizImage()` 直读一致；**非真值一律按关**（`"true"` 字符串 / `1` / 缺字段 都不算开）；写操作无 Origin→403（与其余设置接口同一道闸门）；带合法 SVG 的题存进题库后**回读仍在**（图随 JSON 走）；老题无 svg 字段→回读 undefined 且不报错（向后兼容，不做数据迁移）；**v1.1 新增 4 例**：响应带 `images` 报告且**交付张数是路由自己数的**（不靠模型自觉）、带图的题被配比裁掉→`delivered` 只数最终留下的（报「你拿到几张」而不是「模型画了几张」）、**502 真因分开说**——解析不出来只说模型/解析、配比裁空只说配比（v1.0 把两个真因写进同一句，照着重试永远调不对） | [DONE] |
| `src/routes/answer-style.test.ts` | 8 | **回答方式偏好端点（supertest，照 `quiz-image.test.ts` 手法）**：未配置过→默认偏好 + `configured:false`（L1 据此决定要不要弹卡）；PUT 四维全改→回读一致**且真落库**（不是只在响应里演一遍）；**存了恰好等于默认的值→`configured` 仍为 true**（配过与没配过是两件事，`AnswerStyle` 本身表达不了）；非法值/缺字段→逐字段归一后回读，不 400 也不落脏值；**body 里根本没有 `style`→全默认落库**（PUT 语义是「存我给的」不是「改我给的」）；**库里是坏 JSON→读回默认但 `configured` 仍 true**（键在就是配过，别把用户重新问一遍）；DELETE→回到未配置态，下次出题会重新问一次；写操作无 Origin→403（与其余设置接口同一道闸门） | [DONE] |
| `src/routes/quiz-mix.test.ts` | 10 | **（09-03 配比批交付、本表漏登，本次补行）** GET 未配置过回默认配比（2 单选 + 1 填空 + 1 解答）；PUT 先归一化再落库（负数归 0、小数取整、超上限钳住）、四档全 0 落默认、总题数堆不过上限、写操作无 Origin→403；`/api/quiz/generate` 不传 mix 用设置页全局配比、本次传 mix 覆盖全局**且不写脏库里的配比**、模型多出裁到配比并回实际配比报告、模型少出 `matched false` 且不补题（UI 据此如实告知）、题型全不在配比内→502 给可重试文案（不返回空题组） | [DONE] |
| `src/search/search.test.ts` | 10 | 三家无 key 走 DDG 兜底、单路挂另一路兜底、双路挂失败原因逐路冒泡不静默；配 Exa key 只发 Exa；一家失败只跳过 + 跨家 URL 去重；24h 缓存命中不真发、**缓存键含 provider 组合**（配 key 后不吃旧免 key 缓存）、`skipCache` 强制真发；key 密文落库读取解密、空串删除；`resultsToContext` 带来源编号与 URL | [DONE] |
| `src/storage/db.test.ts` | 3 | 建表齐全 + `schema_version` 记录 + 幂等（重复打开不改动）；`messages(session_id, created_at)` 索引第一天就有；外键生效 | [DONE] |

### web（47 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/lib/api.test.ts` | 5 | **B-003 回归锁**：`api.settings.quizMix()`/`saveQuizMix()` 存在且请求契约正确——GET `/api/settings/quiz-mix`（默认动词）、PUT 同路径且 body 为 `{ mix }`，响应均按 `{ mix }` 回读。防「server 加了路由、三处 UI 在调、唯独 web 端 api 封装整段缺失」的断链再静默发生。**★ 本批补三条（同一条通则：tsc 只能证明方法存在，证不了路径与动词跟服务端对得上）**：`settings.answerStyle()` GET `/api/settings/answer-style` 回 `{ style, configured }`、`saveAnswerStyle(style)` PUT 同路径且 body 为 `{ style }` 包装层、`resetAnswerStyle()` **DELETE 同路径且不带请求体**并回 `configured:false`（L1 弹卡的全部行为都建在这三条请求上） | [DONE] |
| `src/lib/svg-utils.test.ts` | 12 | 围栏抽取/流式首行剥离；尺寸只认根标签；L1 自愈补闭合、钳宽、纯色描边换主题变量；**净化剥 `script`/`foreignObject`/`iframe` 与 `on*`、`javascript:` 协议**；**剥 `<image>` 外链（P2 缺口修补：否则本地应用会被动发请求，泄露 IP 与「本机会跑 studentbuddy」这一事实——DOM 快路径与正则回退路径都已覆盖）**；大输入线性完成（v1 曾因 `[\s\S]*?` 回溯钉死主线程）；`prepareSvg` 半截危险图不白屏不留脚本 | [DONE] |
| `src/lib/markdown.test.ts` | 9 | 块级切分不吞字；标题/列表/引用/分割线/表格各自成块；```svg / ```html / ```chart 围栏白名单，未实现语言一律代码块；未闭合标 `closed=false`（流式）；行内 bold/code/链接成对；**`javascript:` 链接降级纯文本**；未闭合记号原样保留 | [DONE] |
| `src/lib/chart-utils.test.ts` | 9 | `fixJson` 剥注释（串内与 `://` 不受损）与尾逗号；`parseChart` 合法性与超限降级（柱 >31 点／饼 >8 扇区 → null、标题钳 40 字）；自绘 SVG 节点数=值数、主题色走 CSS 变量；**文本节点全转义，恶意 label 不产生裸标签** | [DONE] |
| `src/lib/preview-api.test.ts` | 5 | `uploadPreview` 成功返 `/api/preview/:id`；400 抛服务端原文；响应非 JSON 退化成 HTTP 状态码（不抛 SyntaxError）；200 缺 id 仍判失败；`pickTitle` 取 `<title>` 否则回落 | [DONE] |
| `src/lib/preview-store.test.ts` | 4 | 初始无预览；同 url 重复开 → nonce 递增（强制重载）不同 url 归零；**快照引用稳定**（`useSyncExternalStore` 防死循环）；close 幂等；无预览时 refresh 空操作 | [DONE] |
| `src/features/chat/Mascot.test.ts` | 3 | 点阵与类名映射自洽、16×16 齐边且档位齐、眨眼合帧只压眼位不改身体轮廓 | [DONE] |

## 4. 已发现 Bug（登记簿）

> 只记「本表需要留痕」的缺陷；**反复/修不动的**须同时进 `bug-ledger.md` 并带收敛计数。

| 发现日 | 版本/提交 | Bug | 根因 | 修复与回归锁 |
|--------|-----------|-----|------|--------------|
| 2026-08-27 | `c29f153` 前 | `security.ts` 放行 `Origin: 'null'` ⇒ 模型写的 sandbox 预览页能调写接口 | v1 `file://` 遗留，v2 无该场景 | 删除放行；`index.test.ts` 断言 `Origin: null` 写请求 403 且无 CORS 头 |
| 2026-08-28 | 同批 | 工具循环只看轮次上限不看预算 ⇒ 长结果回灌撑爆上下文 | 缺逐轮累计 | `flow.ts` 每轮累计 `toolTokens` 提前收口；`flow.test.ts` 断言 3 轮×3 结果触发「上下文预算已满」 |
| 2026-09-01 发现／09-02 修 | `15accb0` | **`llm/anthropic.ts` 只取第一条 `system`、丢弃其余** ⇒ 忆域 v2 的词条注入在 Anthropic 型服务商上静默失效 | `find(m => m.role==='system')` + `filter(m => m.role!=='system')` 后不再回补（`anthropic.ts:17-18`，落到 `system: systemMsg?.content` L56）；真机用 openai 型 agnes 验证，`openai.ts` 全量透传因而掩盖 | 合并**全部** system 消息为单串下发。**已客观验证（非自评）**：先把 `anthropic.ts` 退回 `git checkout` 的修复前版本跑新测 → **10 例中 2 例失败**，失败信息正是 `expected '基础提示词' to contain '忆域词条段'` 与 `expected '' to be '有内容'`；恢复修复版 → 144 例全绿。→ 详见 `bug-ledger.md` **B-001** |
| 2026-09-02 | 文档对账 | `开发文档5.0` §1 技术栈写了 Playwright + promptfoo，仓库内 0 引用；§4「17 表 + role_bindings + search_cache」与实际 schema（已增 `term_library`、废弃 `memorize`/`srs`）分叉 | 文档未随 M1-M4 与忆域 v2 回填 | 属 §0.11 漂移，随本批文档回写订正（无代码改动） |
| 2026-09-03 | WIP（HEAD `15accb0`，未提交） | **出题配比 web 侧整链断头**：`api.ts` 缺 `settings.quizMix`/`saveQuizMix`（QuizMixCard/QuizBankPage TS2339）、`ChatView` 引用未声明的 `mixTip`（TS2304 ⇒ 对话页白屏）——功能做了但用户看不见，需求原文被重发 | 09-03「收口」批交付不完整：只写了 JSX/样式与引用，漏 state 声明与 api 客户端方法；同批「check 全绿」验证失实（web tsc 实况 8 错） | 补齐后 **`tsc -p web` 归零**，`npm run check` 实测全绿（20 文件 / 177 例）；新 `web/src/lib/api.test.ts` 2 例作回归锁。→ 详见 `bug-ledger.md` **B-003** |
| 2026-09-04 发现／同批修 | 配图 v1.0→v1.1 | **出题配图上线后真机出图率 0**，而 232 例单测全绿、契约已标 `[已落地]` | 根因不在代码链路（字段/开关/接口/落库/渲染逐层排除均正常），在**提示词层**：`svg` 只出现在提示词末尾追加说明里，`[QUIZ]` **格式示例的 JSON 里没有这个字段**——flash 级模型把示例当完整契约；再叠加劝说式负面措辞（「只有靠文字说不清才画」）等于送模型免费逃逸口 | `QUIZ_PROTOCOL` 把 `svg` 写进字段清单与示例、`buildImageInstruction` 改正面强制口径 + 留 `"svg": ""` 合法出口。回归锁是「**★ 协议示例自证**」3 例——钉根因而非钉症状（`learning/quiz.test.ts`，细则见 `QUIZ-IMAGE-SPEC.md` §2.7） |
| 2026-09-04 发现／同批修 | 配图 v1.1.1 | 真机 HTTP 502：`finish=stop`、输出一个字没少、`[QUIZ]` 成对、`svg` 键齐全，三道好题仍被判死 | 模型自己漏写 `]`（写成 `"options":["A…","D…","answer":[0]`）→ 整份 JSON 非法；且 `parseQuizBlock` 四次尝试的 `catch { continue }` **把真因全吞了**，线上只剩一句笼统文案，靠读代码永远定位不到 | 新增 `learning/quiz-json-repair.ts` 无损补括号（10 例回归锁）。根因是用工作区探针脚本复现的：**import 生产真提示词**打模型 + 落盘原始输出 + 逐次打印 `JSON.parse` 报错与出错位置上下文 |
| 2026-09-04 发现／同批修 | 回答方式偏好 L0+L1 | **`detailed + bullets` 档出题 7 次里 3 次 HTTP 502（43%）**，而默认档 6 次 0 次；文案只有那句笼统的「模型不可用或解析失败」，看不出与风格档有关 | 不是截断（成功样本 `truncated:false`、`quizChars=3106`、`max_tokens`=8192）：详细+列点让解析里 LaTeX 变多，模型本该在 JSON 字符串里写两根反斜杠却直出一根 → `\s` 这类**非法 JSON 转义**使 `JSON.parse` 抛错 → 整组题判死；既有 `repairJsonBrackets` 只补漏括号，管不到转义 | 新增 `repairJsonEscapes`（逐字符扫，**合法 JSON 上永不触发**，故与补括号串成所有尝试的基底；**必须先修转义再扫括号**）+ quiz 提示词护栏句「反斜杠必须写成两根、整套题一次写完」；`quiz.ts` 接线**净增 0 行**（397/400 保住）。回归锁 6 例；**真机复验同档同题材 4/4 HTTP 200 且每题带反斜杠序列**。另登一条**不修的局限**：`\theta`/`\nu` 撞合法转义（`\t`/`\n`），修它就得猜，已用「已知局限」用例钉住 |

## 5. 每次必带回归

| 项 | 内容 |
|----|------|
| 触发 | 任何代码变更（含改文案以外的逻辑改动） |
| 命令 | `npm run check`（tsc×3 + eslint + vitest 302 + gates） |
| 通过判据 | 汇总行 `Tests  N passed`（N 只增不减）+ gates 无红 |
| **★ 涉模型输出格式的改动** | 单测全绿**不算完**：必须真机端到端跑一次（真实接口 → 落库回读 → 浏览器渲染），且换材料破缓存。判据与踩坑见 §7 末六条与 `docs/QUIZ-IMAGE-SPEC.md` §5 |
| 追加要求 | 涉 SSE 事件/REST 接口 → 同步 `docs/SSE-CONTRACT.md`；涉目录职责 → 同步 `AGENTS.md`；涉数据模型 → 同步 `开发文档5.0` §4 + `db.ts` 新迁移版本号 |

## 6. 待补充测试

| 优先级 | 测试项 | 说明 |
|--------|--------|------|
| ~~P1~~ → 已清偿 | 文档模式（2026-09-02 本批） | 37 例已落：注入与不外泄、截断、清除后回退链断开、出题/抽词回退（见 §3）。**未清偿的是真忠实度**，下行 P2 |
| P1 | `openai.ts` 适配器出站体断言 | `anthropic.ts` 已补（本批 10 例），但 `openai.ts` 仍无 `*.test.ts`——**跨 Provider 契约只锁了一半**，B-001 同类问题在 openai 侧仍靠真机撞 |
| P2 | `routes/*` 其余薄路由集成 | `/api/doc` 已有 HTTP 层测例（本批 13 例）；`/api/terms`  CRUD、`/api/sessions` 分页/软删仍未测 HTTP 层入参校验 |
| P2 | AI 忠实度 golden dataset | 需 key：同一资料下「资料里有/资料里没有」两类提问各若干，断答不出的不得编造。现仅靠提示词文案保障，**无客观度量** |
| P2 | 前端 `DocModeControl` 交互 | 只跑过真机 API 冒烟；三态/pill/刷新复原无组件测（本仓 `.tsx` 测例先例只有 `Mascot.test.ts`，且门禁只拦得住内联样式、视觉与交互只能靠人眼） |
| P1 | 前端 `useAskStyle` 三只行为（回答方式偏好 L1） | 「勾了记住就顺手 PUT／不勾只做单次覆盖／`configured` 初值取 true 不在出题路上插队／`persist` 失败仍照常出题」全写在 hook 里，**本批最容易改坏却零回归锁**的逻辑（服务端三条端点与 api 客户端都有锁，缺的正是屏上这一层）。卡点：本仓无 jsdom/@testing-library 依赖，补测得先拍板引依赖（或把 hook 里的判定抽成可测纯函数，同 `stepQuizMix` 那条路子——**优选**） |

## 7. 测试约定

- 测试与被测文件同目录（`x.ts` ↔ `x.test.ts`），不建独立 `tests/` 目录（现行 17 文件全按此摆放）。
- 外部依赖一律 `vi.mock`：LLM 走 `../llm/router.js`（把 `args.messages` 存进 hoisted stub 供断言）、搜索走 `../search/index.js`、词条走 `../learning/terms.js`。
- 行为契约放纯函数文件（如 v1 教训：判定逻辑留在组件内就测不到），组件只留结构断言。
- **改适配器不能只靠「代码看起来对了」**：先 `git checkout` 退回修复前跑新测、确认它真的红，再恢复修复版——B-001 就按此手法取证（回归锁没红过 = 它锁不住任何东西）。
- 命名 `it('中文一句话不变量')`，禁止 `test1/test2` 式无语义命名。
- 断言"注入了什么"必须打到 **传给适配器的 messages**，不打到日志或界面文本（否则等于没锁）。
- **★「校验不通过就丢弃字段」必须整字段删除，不能保留原值**：`normalizeQuiz` 里写 `push(svg ? {...q, svg} : q)` 看着像「合法才带图」，实则坏图分支把**原对象连同非法 svg 一起留了下来**——丢弃语义被静默吃掉，测试一跑就红（2026-09-04 配图批真实踩到）。正确写法是坏值时走 `const { svg: _dropped, ...rest } = q` 再 push `rest`。**此类 bug 的特征：三元的「假分支」什么都没做。**
- 断言「某函数拒绝了坏输入」时，别只断言返回值是 undefined——**要顺着数据流看到落库/下发的值**，否则「判了但没丢」这类缺陷会溜过去。
- **★ 涉模型输出格式的功能，「单测全绿 + 门禁全绿」不等于已落地**：模型自己的坏输出（漏写 `]`、把提示词里的格式示例原样抄进答案）单测永远造不出来。v1.0 就是 232 例全绿标了 `[已落地]`、真机出图率 **0**。落地判据＝**真机端到端跑通一次**：真实接口 → 落库回读 → 浏览器真渲染出图 → 清掉测试数据。
- **★ 统计与复验必须换材料破 prompt 缓存**：中转 `api.agnes-ai.cn` 按 prompt 缓存，同一提示词 8/10 次以 0.1s 返回**同一份**结果——不换材料测的是缓存不是模型（本批最早那轮 10 次统计因此作废重跑）。
- **★ 复验产物文件名不得复用**：探针脚本按 case 名固定写盘（`probe6-机械波.txt`），重跑同一材料把上一份**唯一的真机坏样本覆盖**掉，事后无法恢复——可靠凭证只剩单测里那份逐字结构的 fixture。复验样本必须带时间戳或自增后缀。
- **★ 真机端到端造出的数据必须自清并复核**：测试题库条目跑完 DELETE，再回读 404 + 数一遍列表，确认用户真实库回到原有规模（本批：17 条、无残留带图条目、设置项复原）。**不留测试垃圾进用户库**。
- **探针脚本范式（写在工作区，不进仓）**：只读取真库拿 provider/role → `decryptSecret` → 直接构造 `OpenAICompatibleAdapter`，并且 **import 生产真提示词**（`QUIZ_PROTOCOL` / `buildMixInstruction` / `buildImageInstruction`）——自己手抄一份提示词去测＝测的是另一套东西，结论不可迁移。定位解析失败时**逐次打印每次 `JSON.parse` 的报错与出错位置上下文**：`parseQuizBlock` 的 `catch { continue }` 会吞掉真因，线上文案永远只有一句笼统的「模型不可用或解析失败」。
- **「无损前置变换」的入场券：在合法输入上必须永不触发**。证到这一点才能当所有解析尝试的基底、不占用一次尝试（`repairJsonBrackets` 的依据是「合法 JSON 里数组元素闭合引号之后只能跟 `,` 或 `]`」）；证不到就别往阶梯前面塞——前置变换只要可能在合法输入上动手，就是把「改坏数据」的风险铺到每一条成功路径上。
- **★ 有歧义就不修，且要把歧义写成断言钉住**（上一条的推论，09-04 转义修复批撞出来的）：`repairJsonEscapes` 遇到 `\theta` 无法区分「漏了一根的 LaTeX」与「真制表符 + `heta`」，选**不动它**并加一条「已知局限」用例（断言文字坏成控制字符但题目仍保住）。零歧义才允许前置变换动手；有歧义还去修，就是拿「造出错题」换「提高成功率」——后者输得更隐蔽。**另：两道变换的先后不是自由选择**——转义不先修好，括号扫描连字符串边界都会认错。

## 8. 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-04 | v0.2.4 | 回答方式偏好 L0+L1 批回写：基线 24 文件／258 例 → **26 文件 / 302 例**（新 `shared/answer-style.test.ts` 18、新 `routes/answer-style.test.ts` 8；`quiz-json-repair` 10→16、`learning/quiz` 33→37、`flow` 13→17、`anthropic` 10→11、`web/lib/api` 2→5），小计随之改 shared 45／server 210／web 47（逐文件实测求和，=302）。§4 新增一行：`detailed + bullets` 档 43% 出题 502，真因是 **LaTeX 漏一根斜杠构成非法 JSON 转义**（不是截断，先排了 `truncated`/`max_tokens` 才敢下句），已用 `repairJsonEscapes` + 提示词护栏双保险修掉并真机复验 4/4。§6 新挂一条 P1：`useAskStyle` 三只行为零回归锁（本批最容易改坏的一层）。§7 新立一条：「有歧义就不修，且要把歧义写成断言钉住」（`\theta` 撞 `\t`，故意不修）——它是上一条「无损前置变换入场券」的推论。配套契约 `docs/ANSWER-STYLE-SPEC.md` 升 v1.0 并新增 §8（真机量化数据、两处契约偏离、四项未验） |
| 2026-09-04 | v0.2.3 | 出题配图 v1.1 / v1.1.1 批复验回写：基线 23 文件／232 例 → **24 文件 / 258 例**（新 `learning/quiz-json-repair.test.ts` 10；`learning/quiz.test.ts` 12→33；`routes/quiz-image.test.ts` 7→11）。§3 同时校正本表两处老账：补登 09-03 配比批漏登的 `routes/quiz-mix.test.ts` 10 例，三节小计改为按行实测求和（server 141→**187**、web 64→**44**、shared 27 本来就对）——小计与自家表格不符，说明基线数此前没被复核过。§2 新增 PowerShell GBK 重编码坑（中文打接口必乱，改 node 自 fetch）。§4 新增两行：真机出图率 0 的根因在提示词层／模型漏写 `]` 致整组 502 且被 `catch { continue }` 吞因。§5 新增强制项「涉模型输出格式的改动必须真机端到端」。§7 立六条新约定：真机端到端才算落地／换材料破 prompt 缓存／复验产物不得复用固定文件名／真机造出的数据要自清并复核／探针须 import 生产真提示词并逐次打印解析报错／无损前置变换的入场券是在合法输入上永不触发。表头版本号校正（此前滞后 §8 一格）。配套契约 `docs/QUIZ-IMAGE-SPEC.md` 升 v1.1.1 |
| 2026-09-04 | v0.2.2 | 出题配图批（契约 `docs/QUIZ-IMAGE-SPEC.md`）：基线 208 → **232 例**（21→23 文件，+24：新 `shared/quiz-image.test.ts` 8／新 `routes/quiz-image.test.ts` 7／`learning/quiz.test.ts` 4→12／`web/svg-utils.test.ts` 11→12）。`QuizQuestion` 加可选 `svg` 字段（纯加法，老题库不迁移）；**丢图保题**三道防线（normalizeQuizSvg 丢弃非法图／normalizeQuiz 整字段删除／parseQuizBlock 剥图重试救回整组题）；设置页总开关（默认关）+ 模型自决；**顺带补 P2 缺口**：`sanitizeSvg` 原漏剥 `<image href="...">`，会被当外链信标用。§7 新增两条约定（三元假分支静默保留原值的坑／断言要顺数据流看落库值） |
| 2026-09-04 | v0.2.1 | 词条库 AI 整理批：基线 184 → **208 例**（20→21 文件，+24：`learning/tidy.test.ts` 17／`terms.test.ts` 15→20／`flow.test.ts` 11→13）。DB 迁移 v7（aliases 列）+ 防再分裂三件套（别名感知入库 / 抽取提示词注入已有领域 top-12 / 别名计数）+ tidy_terms 工具全链路（auto/merge/rename_domain）。详见 `CHANGELOG.md` 2026-09-04 条目与 `docs/TERM-TIDY-SPEC.md` |
| 2026-09-03 | v0.3.0 | 出题配比编辑态钳位批：基线 163 → **175 例**（新 `shared/src/quiz-mix.test.ts` 12，shared 首次建测试章节）。规则从 `QuizMixCard` 组件内抽到 `shared/stepQuizMix`（§7「判定逻辑留在组件内就测不到」的又一次兑现）；修「配到 40 题保存后被服务端从后往前悄悄削掉」的闪变——前端编辑期即钳住，服务端 `normalizeQuizMix` 退为兜底；对话页「出题」补当前配比摘要（原本只有题库页有、点下去不知道会出什么）。测试写的过程中踩了 helper 部分覆盖的坑（`mix({single:10,multiple:10})` 实际是 22 题，默认档位没清零），已在用例内注释留痕 |
| 2026-09-02 | v0.2.0 | 文档模式批次回写：基线 107 → **144 例**（新 `llm/anthropic.test.ts` 10／`learning/document.test.ts` 11／`routes/document.test.ts` 13，`flow.test.ts` 8→11）；B-001 行改成已修并附**反向验证证据**（退回旧版 2 例红、失败文案逐字入表）；§6 清账：文档模式 P1 已清偿，新挂 `openai.ts` 出站体与 `DocModeControl` 交互两行；§7 新立「改适配器须先证实回归测试会红」约定 |
| 2026-09-02 | v0.1.0 | 建立本表（§0.8 载体补齐）：登记基线 14 文件/107 例逐文件不变量、`npx` 残 shim 与 stderr 退出码两处本机坑、技术栈对账（Playwright/promptfoo 仓库内 0 引用）、B-001（anthropic 丢 system）与「LLM 适配器出站体零断言」缺口 |
