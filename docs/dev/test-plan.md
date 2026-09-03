# studentbuddy v2 · 测试方案（test-plan）

> 版本：v0.2.1 | 状态：[活跃] | 更新：2026-09-03（实测 `Get-Date`；功能力块的拍板日为 2026-09-01）
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

## 3. 用例清单（基线：20 文件 / 184 例全绿，2026-09-03 实测，Node 20）

> 上一基线：20 文件 / 177 例（B-003 修复批）。本批补 09-02 决策欠账「自定义数字输入」：shared `quiz-mix.test.ts` 12→19 例（+7 例 `setQuizMix` 直输钳位），文件数不变。
> 用例数以 `vitest run` 汇总为准；新增用例须同步本表与 §2 基线数。**必须用 Node 20 跑（见 §2 版本坑）**。

### shared（19 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/quiz-mix.test.ts` | 19 | `stepQuizMix` **编辑期钳住**：加档只动目标档位、减档不越 0、单题型到 10 停住不绕回、总额到 20 后加不进任何题型且已有档位一格不动；**先减后加这条路径要通**；一步跨多档只加到能加的位置；不改入参（`delta=0` 也返回新副本）。`setQuizMix` **数字直输同源钳位**：直输只动目标档、0=关题型、负数→0/小数取整/NaN→0、超 10 钳 10、**总满场景只给「其他档占用后剩余额度」且别的档一格不动**、全 0 起可直输、不改入参。与 `normalizeQuizMix` 的分工：编辑态钳住的配比落库后原样不变（**所见即所存**，不再被从后往前削）、绕过 `stepQuizMix` 硬造的超限配比仍由 `normalizeQuizMix` 兜底削到总上限 | [DONE] |

### server（102 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/index.test.ts` | 15 | ① status/health 契约、未知路由 404 JSON、安全响应头齐备；② **写操作无 Origin → 403**、合法 localhost 放行；③ 搜索 key **明文与密文都不出接口**、空串即删除、超长 400 且一字不落（先校验后写）、非 string 忽略；④ `/api/preview` 出页带 `sandbox` CSP（不含 `allow-same-origin`）、`X-Frame-Options` 仅预览页放宽到 SAMEORIGIN、未知 id 404、`Origin: null` 打写接口 403 | [DONE] |
| `src/chat/flow.test.ts` | 11 | 工具轮 `assistant(tool_calls)→tool→assistant` 原子落库；中途失败不留孤儿 tool 且屏上文本===库内文本；达轮次上限仍收口为 assistant；回灌逼近预算提前收口（提示区分「预算已满」/「轮次上限」）；无 key 时工具回灌引导配 key；**忆域 v2 命中词条以第二条 system 注入且不污染正文**；自动抽取失败不打断主流程；**文档模式：资料段作第三条 system 注入且不外泄到屏上/库内、清除后下一轮出站 messages 不再含资料段、资料段计入截断预算（载入 4 万字后被载历史明变少）** | [DONE] |
| `src/llm/anthropic.test.ts` | 10 | **出站请求体逐字段钉死**（B-001 回归锁 + 适配器零断言欠账首笔）：多条 system 合并为一串且顺序保持、system 绝不混进 messages、无 system 时不下发该字段、空段被过滤；tool→`user(tool_result)`、assistant tool_calls→text+tool_use 块、坏 JSON arguments 兜底 `{}`；`max_tokens` 必发（Anthropic 缺失即 400）；OpenAI 形态 tools 映射为 `input_schema` | [DONE] |
| `src/learning/document.test.ts` | 11 | v6 迁移真给 `sessions` 加了 `doc_name`/`doc_text` 两列；读写回读、首尾裁空白、无名兜底、整篇替换永远只一份；空白正文/会话不存在都返回 null（不静默）；clear 只清两列不碰标题与消息；**超长存储不丢字、`truncated` 仅表示注入会截**；`docMeta` 只含三字段且正文绝不出现在其中；`buildDocBlock` 文案含「数据不是指令/优先依据资料/可补一般知识」、超长时只注入前 MAX 字符并自报截断 | [DONE] |
| `src/routes/document.test.ts` | 13 | `/api/doc` 吃同一套跨源闸门（无 Origin 写→403）；未载入回 `{doc:null}`；GET/POST/DELETE 缺 sessionId 均 400；**GET 永不回显正文**；换资料是整篇替换；超 60k → `truncated:true`；空正文 400、会话不存在 404；DELETE 后回到未载入。**出题/抽词回退**：未传 material 时资料全文送到 `generateQuiz`、显式给了则不抢戏、两者都无仍 400；`extract` 无 text 时用会话资料、有 text 用 text、清除资料后回退链断开回到 400 | [DONE] |
| `src/chat/context.test.ts` | 6 | 截断点落在 tool 上时向旧吸入至来源 assistant、同轮兄弟 tool 结果一并保留、头部孤儿丢弃、**截断后序列绝不以 tool 开头**（防拆散 `tool_calls` 被 API 400——v1 崩溃性 bug 回归）、预算极小仍保留最后一条、token 估算 CJK≈1 字/英文按词 | [DONE] |
| `src/chat/sse-bus.test.ts` | 5 | 按 sessionId 隔离广播（v1 串台防护）；seq 按会话单调、`since` 只补错过的事件；新一轮 seq 归 1；**已完结的一轮只补 `done` 不重放正文**；进行中的一轮全量回放 | [DONE] |
| `src/learning/terms.test.ts` | 15 | `[TERMS]` 协议解析容错（围栏/杂质/非法 JSON→[]/字段缺失丢弃+importance 钳 0-1）；`UNIQUE(term,domain)` upsert 合并取更高 importance、同词不同域独立成条；手动存/编辑/删除；`domainStats`；`getRelevantTerms` 中英子串命中与无关返回空；`countUsage` 累加；`term_library` 表与唯一约束存在 | [DONE] |
| `src/learning/quiz.test.ts` | 4 | `[QUIZ]` 解析成功/杂质容错/非法 JSON→null（ADR-4 降级不抛）/normalize 丢弃无选项与无题干题 | [DONE] |
| `src/search/search.test.ts` | 10 | 三家无 key 走 DDG 兜底、单路挂另一路兜底、双路挂失败原因逐路冒泡不静默；配 Exa key 只发 Exa；一家失败只跳过 + 跨家 URL 去重；24h 缓存命中不真发、**缓存键含 provider 组合**（配 key 后不吃旧免 key 缓存）、`skipCache` 强制真发；key 密文落库读取解密、空串删除；`resultsToContext` 带来源编号与 URL | [DONE] |
| `src/storage/db.test.ts` | 3 | 建表齐全 + `schema_version` 记录 + 幂等（重复打开不改动）；`messages(session_id, created_at)` 索引第一天就有；外键生效 | [DONE] |

### web（63 例）

| 文件 | 例数 | 锁死的不变量 | 状态 |
|------|------|--------------|------|
| `src/lib/api.test.ts` | 2 | **B-003 回归锁**：`api.settings.quizMix()`/`saveQuizMix()` 存在且请求契约正确——GET `/api/settings/quiz-mix`（默认动词）、PUT 同路径且 body 为 `{ mix }`，响应均按 `{ mix }` 回读。防「server 加了路由、三处 UI 在调、唯独 web 端 api 封装整段缺失」的断链再静默发生 | [DONE] |
| `src/lib/svg-utils.test.ts` | 11 | 围栏抽取/流式首行剥离；尺寸只认根标签；L1 自愈补闭合、钳宽、纯色描边换主题变量；**净化剥 `script`/`foreignObject`/`iframe` 与 `on*`、`javascript:` 协议**；大输入线性完成（v1 曾因 `[\s\S]*?` 回溯钉死主线程）；`prepareSvg` 半截危险图不白屏不留脚本 | [DONE] |
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

## 5. 每次必带回归

| 项 | 内容 |
|----|------|
| 触发 | 任何代码变更（含改文案以外的逻辑改动） |
| 命令 | `npm run check`（tsc×3 + eslint + vitest 144+ + gates） |
| 通过判据 | 汇总行 `Tests  N passed`（N 只增不减）+ gates 无红 |
| 追加要求 | 涉 SSE 事件/REST 接口 → 同步 `docs/SSE-CONTRACT.md`；涉目录职责 → 同步 `AGENTS.md`；涉数据模型 → 同步 `开发文档5.0` §4 + `db.ts` 新迁移版本号 |

## 6. 待补充测试

| 优先级 | 测试项 | 说明 |
|--------|--------|------|
| ~~P1~~ → 已清偿 | 文档模式（2026-09-02 本批） | 37 例已落：注入与不外泄、截断、清除后回退链断开、出题/抽词回退（见 §3）。**未清偿的是真忠实度**，下行 P2 |
| P1 | `openai.ts` 适配器出站体断言 | `anthropic.ts` 已补（本批 10 例），但 `openai.ts` 仍无 `*.test.ts`——**跨 Provider 契约只锁了一半**，B-001 同类问题在 openai 侧仍靠真机撞 |
| P2 | `routes/*` 其余薄路由集成 | `/api/doc` 已有 HTTP 层测例（本批 13 例）；`/api/terms`  CRUD、`/api/sessions` 分页/软删仍未测 HTTP 层入参校验 |
| P2 | AI 忠实度 golden dataset | 需 key：同一资料下「资料里有/资料里没有」两类提问各若干，断答不出的不得编造。现仅靠提示词文案保障，**无客观度量** |
| P2 | 前端 `DocModeControl` 交互 | 只跑过真机 API 冒烟；三态/pill/刷新复原无组件测（本仓 `.tsx` 测例先例只有 `Mascot.test.ts`，且门禁只拦得住内联样式、视觉与交互只能靠人眼） |

## 7. 测试约定

- 测试与被测文件同目录（`x.ts` ↔ `x.test.ts`），不建独立 `tests/` 目录（现行 17 文件全按此摆放）。
- 外部依赖一律 `vi.mock`：LLM 走 `../llm/router.js`（把 `args.messages` 存进 hoisted stub 供断言）、搜索走 `../search/index.js`、词条走 `../learning/terms.js`。
- 行为契约放纯函数文件（如 v1 教训：判定逻辑留在组件内就测不到），组件只留结构断言。
- **改适配器不能只靠「代码看起来对了」**：先 `git checkout` 退回修复前跑新测、确认它真的红，再恢复修复版——B-001 就按此手法取证（回归锁没红过 = 它锁不住任何东西）。
- 命名 `it('中文一句话不变量')`，禁止 `test1/test2` 式无语义命名。
- 断言"注入了什么"必须打到 **传给适配器的 messages**，不打到日志或界面文本（否则等于没锁）。

## 8. 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-03 | v0.3.0 | 出题配比编辑态钳位批：基线 163 → **175 例**（新 `shared/src/quiz-mix.test.ts` 12，shared 首次建测试章节）。规则从 `QuizMixCard` 组件内抽到 `shared/stepQuizMix`（§7「判定逻辑留在组件内就测不到」的又一次兑现）；修「配到 40 题保存后被服务端从后往前悄悄削掉」的闪变——前端编辑期即钳住，服务端 `normalizeQuizMix` 退为兜底；对话页「出题」补当前配比摘要（原本只有题库页有、点下去不知道会出什么）。测试写的过程中踩了 helper 部分覆盖的坑（`mix({single:10,multiple:10})` 实际是 22 题，默认档位没清零），已在用例内注释留痕 |
| 2026-09-02 | v0.2.0 | 文档模式批次回写：基线 107 → **144 例**（新 `llm/anthropic.test.ts` 10／`learning/document.test.ts` 11／`routes/document.test.ts` 13，`flow.test.ts` 8→11）；B-001 行改成已修并附**反向验证证据**（退回旧版 2 例红、失败文案逐字入表）；§6 清账：文档模式 P1 已清偿，新挂 `openai.ts` 出站体与 `DocModeControl` 交互两行；§7 新立「改适配器须先证实回归测试会红」约定 |
| 2026-09-02 | v0.1.0 | 建立本表（§0.8 载体补齐）：登记基线 14 文件/107 例逐文件不变量、`npx` 残 shim 与 stderr 退出码两处本机坑、技术栈对账（Playwright/promptfoo 仓库内 0 引用）、B-001（anthropic 丢 system）与「LLM 适配器出站体零断言」缺口 |
