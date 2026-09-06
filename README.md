# studentbuddy v2

![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![tests](https://img.shields.io/badge/tests-26%20files%20%2F%20302%20cases-brightgreen)
![stack](https://img.shields.io/badge/stack-React%2018%20·%20Express%20·%20SQLite-8a63f6)

> 本地优先的 AI 学习助手（学习版豆包）：**学 → 练 → 析 → 忆 → 反馈**闭环。
> v2 全新重写仓——v1（[llwand1/studentbuddy](https://github.com/llwand1/studentbuddy)，已冻结）按「需求为纲、简洁优先」六条 ADR 从零重写为本仓。

## 目录

- [这是什么](#这是什么)
- [核心优势](#核心优势)
- [功能总览](#功能总览)
- [内容块协议](#内容块协议)
- [架构](#架构)
- [安全设计](#安全设计)
- [快速开始](#快速开始)
- [v1 数据迁移](#v1-数据迁移)
- [仓库结构](#仓库结构)
- [开发指南](#开发指南)
- [配置说明](#配置说明)
- [里程碑](#里程碑)
- [已知限制](#已知限制)
- [文档体系](#文档体系)

## 这是什么

一个跑在本机的单用户 AI 学习助手：`api(Express :18791，仅 127.0.0.1) + web(Vite :5173)`，浏览器访问，所有数据存本地 SQLite 单文件（WAL），**不上云、零 AI 写盘**。

它把学习做成闭环：**学**（对话 + 文档模式）→ **练**（AI 出题）→ **析**（逐题统计 / 薄弱点）→ **忆**（AI 词条库）→ **反馈**（XP / 今日总结）。助手正文按 Markdown 排版，```svg / ```chart / ```html 三种围栏让模型能直接产出矢量图、数据图和可交互演示页。

## 核心优势

与「给聊天框加层皮」的 AI 学习工具的差别在于：v2 把 **闭环完整度、AI 输出可靠性、工程质量** 三层都做实了，且每条都给出可当场复验的证据。

| 优势 | 强在哪 | 可当场复验的证据 |
|------|--------|------------------|
| **真·本地优先** | 只绑 `127.0.0.1`、数据 SQLite 单文件、搜索密钥 AES-GCM 密文入库、零 AI 写盘——学习记录与 key 都不出本机 | `Origin: null` 写请求 → 403 有回归锁；沙箱页 `localStorage` 抛 SecurityError、读 sessions 被拒均真机实测（CHANGELOG 08-28） |
| **学习域特化功能，不是大模型传声筒** | 练是一台自建出题引擎：`[QUIZ]` 结构化自动判分、四题型可配配比、模型特化 SVG 配图（真机生产口径 5/6 组出图）、五级解析阶梯让模型漏括号/坏图/撞顶都不塌整组；忆是一个自学词条库：加权相关性注入 + 对话自动沉淀 + AI 整理；理解的进化有 5 级认知进化链在契约中（如实标注：未实施），逐条见 §功能总览 | 已落地项各有测试基线与真机统计（CHANGELOG 09-04 出题两批 / 09-01·09-04 词条库批）；未落地项在 §忆 · 认知进化 小节标题即标状态 |
| **AI 输出可靠性工程** | 模型不听话不塌系统：出题五级解析阶梯（补括号 → 剥图重试 → 截断逐题回退…）、丢图保题、`\theta` 类非法转义修复、SSE 屏上文本与库内文本逐字一致 | 每个对策都对应一次真实故障的根因登记与回归锁（`docs/dev/bug-ledger.md` + CHANGELOG 09-04 两批） |
| **模型产出敢真跑** | ```html 围栏产出的网页在 `CSP: sandbox` + iframe 双层沙箱里运行，页面源为 `null`；SVG 净化剥 `<image>` 外链（防外链信标泄露 IP） | 真机实测沙箱页调写接口 / 读数据全被拒；净化有 `web/svg-utils.test.ts` 锁 |
| **前端零第三方库** | 无 UI 库 · 无 markdown 库 · 无图表库：Markdown 解析、数据图自绘 SVG、SVG 净化自愈全部自写——供应链攻击面与包体积同时趋零、行为完全可控 | `packages/web/package.json` 运行时依赖只有 react / react-dom / `@sb/shared` |
| **302 例测试 + 机器强制门禁** | `npm run check` = tsc×3 + eslint + vitest + gates：单文件行数红线（server ≤400 / web ≤300）、禁 `any`、禁内联样式全部由脚本拦截，不靠自觉 | 一条命令本地/CI 复验；基线 26 文件 / 302 例（09-05 Node 22 复验同数） |
| **契约先行的可维护性** | `@sb/shared` 是 SSE 事件 / 内容块 / REST / 领域模型的单一事实源，前后端不允许各写一套；先登记再实现 | shared 契约文件头注释即纪律；四条固定扩展模式见 §开发指南 |
| **不锁定供应商** | OpenAI 兼容 + Anthropic 双适配；搜索 Exa / Tavily / 智谱三家并行聚合 + DDG 兜底——换模型换服务商只动设置页 | 适配器有出站请求体断言测试，且当场逮出过真缺陷 B-001（多条 system 在 Anthropic 型上静默丢失） |

> 一条隐性优势是**诚实的文档文化**：CHANGELOG 每批都有「未验（诚实记账）」段、推断不进验证列，§已知限制 明写哪些是缺陷哪些是定档边界——这份 README 的每个数字都能在仓库内对上出处。

## 功能总览

### 学 · 对话核
- **SSE 流式输出**：token 级流式上屏，屏上文本与库内文本逐字一致；断线指数退避重连 + 事件序号回放去重
- **单轨工具循环**：原生 function-calling 循环（8 轮上限 / 14k 回灌截断 / 逐轮预算检查 / 工具轮原子落库，无孤儿 tool 消息）
- **联网搜索**：Exa / Tavily / 智谱按 key 并行聚合 + 跨家 URL 去重 + 24h 缓存；三家无 key 走 DuckDuckGo 兜底；出网带 SSRF 护栏
- **工具调用可视化**：`step` 事件三态进度芯片上屏（进行中 / 完成 / 失败），搜索溯源可见
- **文档模式（RAG）**：给会话绑定一篇资料（粘贴 / .txt / .md）；**短文档（≤ 60k 字）整篇直塞，长文档走真检索**——零依赖词法 **BM25** 切块（800 字 / 重叠 120）后按本轮提问取 Top-12 段落注入，**带【段 n】段号可溯源**，并强制声明「这些段落是局部不是全文，没出现不代表资料里没有」；存储不丢字、换形状只发生在注入层；出题 / 抽词缺材料时自动回退用会话资料（出题按主题检索、抽词条无主题则按位置均匀覆盖）。实测：70 万字资料下旧直塞的内容覆盖率 **0/13**、新检索 **13/13**（关键词型），注入量从 60k 字降到 10.5k（契约 `docs/DOC-RAG-SPEC.md`）

### 学 · 内置浏览器面板
- ```html 围栏产出可交互演示页：对话里只出卡片，点「侧栏预览」在应用右侧内置面板运行（或新标签页）
- 面板只挂模型产出（无地址栏），出页带 `CSP: sandbox` + iframe 双层 sandbox，页面源为 `null`

### 练 + 析 · 出题（自建出题引擎，不是大模型传声筒）
- **`[QUIZ]` 结构化协议**：模型按字段清单 + 格式示例输出题组（题干 / 选项 / 答案索引 / 解析 / svg）整块入库——判分靠结构化作答索引，自动批改、逐题可统计，不依赖模型逐次判卷
- **题型配比可配**：单选 / 多选 / 填空 / 解答四档各 0..10、总上限 20；编辑期钳位（所见即所存），服务端归一化兜底；对话页与题库页共用全局配比；模型没出够不补题、缺几题说几题（ADR-4 降级不崩 + ADR-5 不静默）
- **AI 特化配图**（默认关，总开关是服务端硬门不只靠提示词）：凡题干涉及图形 / 结构 / 装置 / 几何体 / 受力 / 电路 / 光路的题**必须**产出 SVG 矢量图，每组最多 3 张限流对冲耗时；SVG 属性一律单引号，从源头掐掉 JSON 转义坑；**真机实测产出率**：生产口径 5/6 组至少 1 张图（1.6~2.3 张/组），电路图 / 电表接反对比图 / 30° 斜面四力受力图经浏览器逐张目视为切题真矢量图，填空题正确无图
- **丢图保题，坏不连坐**：单图 8000 字符上限、缺闭合标记即丢弃——**学习软件里残缺的几何图比没图更糟，会教错学生**；任何一条校验失败只删该题 `svg` 字段，题目照常交付
- **模型犯错不塌整组**：五级解析阶梯（无损补括号 → 原样 parse → 剥图重试 → 截断逐题回退 → 回退后再剥图），外加 `repairJsonBrackets` 无损补模型漏写的 `]`——该修复**在合法 JSON 上永不触发**，纯增益基底；撞 `max_tokens`、漏括号、坏图，任何一种都不再让整组题 502
- **如实上报**：`QuizImageReport{on, delivered, droppedSvg, truncated}` 四态贯穿 server→路由→前端，没图 / 丢图 / 被截断各如实补一句，绝不拿「开关已开」冒充「图已交付」
- **题库与统计**：逐题正确率统计、薄弱点定位、golden dataset

### 忆 · AI 词条库（自学忆域，不靠用户手动记）
- **双通道抽词**：回复后 `[TERMS]` 协议 fire-and-forget 自动抽取（不阻塞对话、失败降级空列表）+ 对话页「存入记忆」手动通道；入库按 `UNIQUE(term,domain)` upsert 合并（同词保更高 importance、更新释义），并向模型注入已有领域 top-12 引导复用词表——防词条库分裂
- **加权相关性注入**：回复前按「子串命中 2.0 / 词元互含 0.5 + importance×0.8 + 最近使用×0.3」加权检索，命中词条作第二条 system 软性注入（不强制、不污染正文）；回复后 usage 命中计数——**越用的词越容易被再注入**，记忆形成正反馈
- **AI 整理**：对话内自然语言触发 `tidy_terms` 工具——自动分组、同义词归一、领域归一，单事务应用；只合并不删除，被并同义词挂主条 `aliases` 防再分裂（参照 Anki 查重 + Obsidian aliases 范式）

### 忆 · 认知进化（契约 v1.1 · 待评审，**尚未落实现代码**）

把「用户对一个词条的理解」做成可累积的等级链：**L0 直觉 → L1 复述 → L2 准确 → L3 边界 → L4 迁移**，AI 在对话中承担教练角色每轮现场判定（判定纪律：宁判低不判高；不许把没讲过的内容算作已掌握）。设计取契约〔[`docs/COGNITIVE-EVOLUTION-SPEC.md`](docs/COGNITIVE-EVOLUTION-SPEC.md)〕实文：
- **`[VERDICT]` 协议 + 流式闸门**：判定数据由模型在回复末尾以隐藏标记输出，闸门吞段——不上屏、不落库，不破「屏上文本 == 库内文本」铁律；判定由主对话模型顺带产出，**零额外 LLM 调用**
- **进化链本身就是复习材料**：每次判定 append-only 落链（含用户当时原话快照、评语、缺口清单、下一级目标），词条页可展开完整时间轴回顾「我当时是怎么说的」
- **难度联动**：等级直接喂出题引擎——L0..L4 各档对应题型配比与干扰项侧重（L0 考直觉识别、L4 出新情境考迁移讲评）；允许降级（回退是真实信号不粉饰），但 `best_level` 只增不减，一次失手不会把复习难度打回原形
- **合环不加环**：忆（词条库）→ 析（判定缺口）→ 练（难度随等级）→ 反馈（升级记 XP）四环合流，不新建第六环
- **v1.1 反馈加强（2026-09-06 老板拍板）**：`met` 证据式判定——等级不动的轮次也必须列「本轮命中的 rubric 要素 / 还缺什么」，双空被禁，治「讲了半天没升级 = 没反馈」；**词条直达进化**——词条行一键开进化会话，首轮 AI 直接对该词条出 `[QUIZ]` 单题水平探针评估认知程度（复用既有出题引擎与解析阶梯，零新协议、零嵌套 LLM 调用）

### 反馈
- 学 / 练 / 忆的每个动作经事件总线 `publishEvent` 落 XP（存题、添词条、对话各按费率表计分），驱动 XP 连签、今日总结、近 7 天趋势——学习闭环的成就感不靠用户自觉记账

### 回答方式偏好
- 四维偏好（详略 / 口吻 / 辅助 / 形状）：**L0** 设置页常驻卡 + **L1** 出题前没配过就先就地问一次（勾「记住」才落库）；默认档逐字等价现状口径，老用户零感知

## 内容块协议

助手正文的围栏白名单只有三种，其余语言一律按代码块转义渲染（禁裸注入）：

| 围栏 | 行为 | 实现 |
|------|------|------|
| ```svg | DOMParser 快路径 + 正则回退**净化**（剥 script / foreignObject / iframe / object / embed / image 外链），再 L1 自愈（补闭合 / 钳宽 / 主题色）后内联渲染；支持放大 / 下载 | `web/lib/svg-utils.ts` |
| ```chart | JSON 容错解析 + bar / line / pie **零依赖自绘 SVG** 数据图 | `web/lib/chart-utils.ts` |
| ```html | 对话内永不内联；点「侧栏预览」上传（内存暂存 20 条 / 512KB）后在右侧面板的沙箱 iframe 运行，也可新标签页 | `server/routes/preview.ts` + `web/features/preview/` |

## 架构

```
浏览器  http://localhost:5173（Vite dev；生产态由 api 同源托管 dist/web）
    │  HTTP + SSE  /api/*（同源代理）
    ▼
┌────────────────────────────────────────────────────────┐
│ packages/server — Express :18791（仅绑定 127.0.0.1）      │
│   routes        REST + settingsRouter（密钥不出接口）      │
│   chat/flow     一轮对话编排：四段 system 注入 + 预算收口   │
│     ├ chat/tools      工具注册表（search_web/tidy_terms）│
│     ├ learning/*      quiz / terms / tidy / document    │
│     ├ search/*        Exa·Tavily·智谱并行 → DDG 兜底     │
│     ├ llm/*           openai / anthropic 双适配          │
│     └ security.ts     Origin 校验 / 密钥加密 / SSRF 护栏  │
└──────────────────────────┬─────────────────────────────┘
                           │ better-sqlite3（WAL，逐版本迁移）
                           ▼
        %APPDATA%/studentbuddy-v2/studentbuddy.db（SB_DATA_DIR 可覆盖）

packages/shared — 契约单一事实源：SSE 事件 / 内容块协议 / REST / 领域模型
tools/gates     — 工程门禁：行数上限 / 禁内联样式 / 禁 any
```

**三包职责**：`@sb/shared` 只放契约与纯函数（前后端共用一份，不允许各写一套）；`@sb/server` 承载全部业务域；`@sb/web` 是 React 18 前端，**零运行时依赖**（无 UI 库 / 无 markdown 库 / 无图表库，全部自绘）。

## 安全设计

按 ADR-2「安全做必要最小」，落了这几件：

- **Origin 校验**：写操作校验 Origin，**不放行 `'null'`**（sandbox 预览页的源就是字符串 null，放行等于让模型写的网页能调写接口）
- **SVG 净化**：剥除外链 `<image>`（防外链信标泄露 IP）与全部脚本载体，净化后才可进 blob 文档
- **html 沙箱双保险**：响应带 `CSP: sandbox`（无 `allow-same-origin`）⇒ 页面源为 `null`，读不到本应用数据也调不了写接口；前端 iframe 再叠一层 `sandbox`
- **密钥不出接口**：搜索 key AES-GCM 密文入库，响应只回布尔
- **SSRF 护栏**：搜索 / 抓取出网走护栏 + 白名单
- **请求体 2MB 上限**；SQLite 落库，无上传目录、无路径穿越面

## 快速开始

> ⚠️ **Node 版本必须「装依赖」与「运行时」一致**（`engines: >=22.11.0`，现役 Node 22.22.2 / ABI 127，仓库带 `.nvmrc`）：`better-sqlite3` 是原生模块，产物按**安装那一刻**的 Node ABI 编译；用 Node 20 装完再拿 Node 22 跑（或反之），涉库代码会全线 `ERR_DLOPEN_FAILED`，表现为所有 HTTP 接口 500、测试大面积红，**极易误判成新代码写错**。**换 Node 大版本必须重装依赖**（删 `node_modules` 后 `npm install`），只换运行时无效。

```bash
npm install          # workspaces 三包一次装齐（装依赖的 Node = 以后跑的 Node）
npm run check        # lint(tsc×3 + eslint) + test(vitest) + gates —— 全绿基线
npm run dev:server   # api :18791（端口被占时 SB_PORT=18792）
npm run dev:web      # web :5173（代理目标 SB_PROXY_TARGET 可配）
```

浏览器打开 **http://localhost:5173**（vite 监听 IPv6 `::1`，用 localhost 而非 127.0.0.1）。

首次使用：设置页添加 AI 服务商（OpenAI 兼容协议，`baseUrl` / `apiKey` / `defaultModel`）；要用联网搜索再配搜索 key（见[配置说明](#配置说明)）。

## v1 数据迁移

M4 自带全量迁移工具（ADR-6：**永不触碰 v1 原库**；v2 库先备份再动）：

```bash
node tools/migrate-from-v1/migrate.mjs --dry-run   # 只出报告，不落库
node tools/migrate-from-v1/migrate.mjs --run       # 备份 v2 库后执行
```

迁移 `sessions / messages / quiz_bank / memorize`（SRS 初值）与 providers；v1 早期 GBK 乱码标题自动重解码，不可恢复的保留原文并打标。

## 仓库结构

```
packages/
├─ shared/src/            契约单一事实源
│  ├─ sse-events.ts         SSE 事件契约（先登记再实现）
│  ├─ content-blocks.ts     内容块协议 + 题型配比契约
│  ├─ answer-style.ts       回答方式偏好契约（UI 文案与提示词同源）
│  └─ domain.ts             Session / Message / TermItem 领域模型
├─ server/src/
│  ├─ index.ts              Express 入口（安全头 / CORS / originCheck / 2MB）
│  ├─ chat/flow.ts          对话编排：四段 system 注入 + 上下文预算收口
│  ├─ chat/tools.ts         单轨工具注册表
│  ├─ learning/             quiz 出题引擎(+json-repair) / terms 词条库 / tidy 整理 / document 文档模式(+doc-retrieve BM25 检索) / activity
│  ├─ search/               三路聚合 + DDG 兜底 + 24h 缓存 + SSRF 护栏
│  ├─ llm/                  openai / anthropic 双适配（system 全量合并）
│  ├─ routes.ts             REST + settingsRouter
│  ├─ storage/              better-sqlite3 封装 / 逐版本迁移 / 偏好读写
│  └─ security.ts           Origin 校验（不放行 'null'）
├─ web/src/
│  ├─ app/App.tsx           应用壳：180px 侧栏五环导航
│  ├─ features/chat/        ChatView / useChatStream / Markdown / HtmlCard / Welcome + 像素吉祥物 / AskStyleCard / DocModeControl
│  ├─ features/preview/     内置浏览器面板（沙箱 iframe）
│  ├─ features/settings/    搜索 key / 配比 / 配图 / 回答偏好 四张卡
│  ├─ features/quiz·terms·summary/   题库 / 词条库 / 今日总结
│  ├─ lib/                  svg-utils（净化+自愈）/ chart-utils（自绘图表）/ markdown（零依赖解析）/ api
│  ├─ components/icons.tsx  SVG line-icon 基座（禁 emoji）
│  └─ styles/tokens.css     设计 token 唯一事实源
tools/
├─ gates/check.mjs         行数 / 内联样式 / any 门禁
└─ migrate-from-v1/        v1→v2 数据迁移
docs/                      L3 仓库文档（契约规范 / 测试计划 / bug 台账）
CHANGELOG.md               项目改动登记册（代码/文档/测试同批登记）
```

## 开发指南

**门禁红线**（`npm run gates` 强制）：

- 单文件行数：server ≤ 400 行 / web 组件 ≤ 300 行
- 禁内联 `style={{…}}`（一律走 tokens.css 的 token）；禁 `any`；测试也禁 `!` 非空断言

**`npm run check` = tsc×3（shared/server/web）+ eslint + vitest + gates**，全绿才许提交。当前基线：**26 测试文件 / 302 用例**。

**提交纪律**：

- 三件套：代码 + 文档 + 测试同批提交；每批在 `CHANGELOG.md`「未发布」段追加一行，验证列只写实测结论（推断不进表）
- Conventional Commits；从 v1 搬运的件标注 `port from v1`
- 改 bug 前先读 `docs/dev/bug-ledger.md`（收敛计数 3 = 禁止第 4 次同向尝试）

**扩展模式**：

- 新增 SSE 事件 → 先在 `shared/src/sse-events.ts` 登记，同步 `docs/SSE-CONTRACT.md`
- 新增内容卡片 → `shared/src/content-blocks.ts` 登记 kind + web 注册渲染器
- 新增工具 → `chat/tools.ts` 加定义 + `step` 上报，flow 循环零改动
- 新增设置项 → `app_settings` 键名在 shared 登记，套路照 quiz-mix（load 归一化回落 / save upsert）

## 配置说明

| 配置 | 位置 | 说明 |
|------|------|------|
| AI 服务商 | 设置页（`providers` 表） | OpenAI 兼容协议；Anthropic 型走独立适配器（system 全量合并） |
| 搜索 key | 设置页（AES-GCM 密文入库） | 推荐 Exa / Tavily / 智谱任一，按 key 并行聚合；**三路全无 key 走 DDG 兜底，但 DDG 在部分本机网络不可达**（实测直连超时），要真出结果请至少配一个 key，智谱国产可达 |
| 端口 | 环境变量 `SB_PORT`（默认 18791）、`SB_PROXY_TARGET` | 端口被 v1 占用时切 18792，**不杀 v1 进程** |
| 数据目录 | 环境变量 `SB_DATA_DIR`（默认 `%APPDATA%/studentbuddy-v2`） | SQLite 单文件 `studentbuddy.db`（WAL），逐版本 schema 迁移 |

## 里程碑

| 阶段 | 状态 |
|------|------|
| M0 地基（workspaces 三包 / 门禁 / 浅色豆包 token / SVG 图标 / 安全中间件） | ✅ 2026-08-23 |
| M1 对话核（SSE / 单轨工具循环 / 模型路由 / 内容块流 / 内置浏览器面板） | ✅ 2026-08-28 |
| M2 练+析（出题引擎 / 题型配比 / SVG 配图 / 逐题统计） | ✅ 2026-09-04 |
| M3 忆（AI 词条库 + AI 整理） | ✅ 2026-09-03 |
| M4 反馈环 + v1 数据迁移 | 🔶 反馈与迁移已落，定稿未做 |
| 5.0 §5 学环·文档模式（短文档直塞 + 长文档 BM25 检索） | ✅ 2026-09-02，检索改造 2026-09-06 |

## 已知限制

- **行内公式不渲染**：`$…$` 按原文显示（未引 katex，保持 `@sb/web` 零运行时依赖）；`mermaid` / `echarts` 围栏降级代码块（刻意不引库，数据图由自绘 ```chart 覆盖）
- **预览页只活内存**：服务重启即失效，无分享链接（本地单用户形态无场景）；内置面板无地址栏、宽度不可拖拽（只挂模型产出，是定档边界不是缺陷）
- **文档模式：词法检索，不是语义检索**：≤ 60k 字整篇直塞（与旧实现逐字等价）；> 60k 才切块 + BM25 按提问取段落。**没有的：embedding 向量／跨会话资料库／持久化索引／pdf-docx 解析／可点击溯源**。已知天花板：用户**不用资料里的原词**改写提问时，70 万字规模下召回收敛在 **8/13 ≈ 62%**（多给段落救不回来，这是词法路线的性质，只能靠向量路线突破）；且**不靠分数阈值判「资料没写」**——两种阈值方案都被实测否掉（真命中区间与干扰项区间重叠），识别不到的权力交给模型如实说（契约 `docs/DOC-RAG-SPEC.md` §3.3）
- **`search_web` 免 key 兜底在本机网络大概率不可用**：DDG 直连实测超时，至少配一个搜索 key
- **security.ts 放行 localhost 任意端口**：单用户本地权衡，刻意保留
- **转义修复只补「漏根」不修「错命令」**：`\theta` / `\nu` 这类恰好等于合法转义的写法无法与真制表符区分，故意不修（命中走逐题回退，最坏丢一题不连坐整组）

## 文档体系

| 层 | 位置 |
|----|------|
| L0 元规则 / L1 开发文档 5.0 / L2 专题 | `Desktop/studentbuddy重写/`（本机） |
| L3 仓库文档 | 本仓 `docs/` |
| L4 归档区 | `Desktop/studentbuddy重写/废弃文档/`（本机） |

`docs/` 索引：

| 文档 | 内容 |
|------|------|
| [`SSE-CONTRACT.md`](docs/SSE-CONTRACT.md) | SSE 事件与 HTTP 接口契约（前端对接核心） |
| [`QUIZ-IMAGE-SPEC.md`](docs/QUIZ-IMAGE-SPEC.md) | 出题配图契约（字段加法 / 丢图保题 / 提示词口径） |
| [`ANSWER-STYLE-SPEC.md`](docs/ANSWER-STYLE-SPEC.md) | 回答方式偏好契约（L0/L1 行为、默认档等价性） |
| [`TERM-TIDY-SPEC.md`](docs/TERM-TIDY-SPEC.md) | 词条库 AI 整理契约（归一规则 / 别名防分裂） |
| [`DOC-RAG-SPEC.md`](docs/DOC-RAG-SPEC.md) | 文档检索契约（短文档直塞 / 长文档 BM25 Top-K / 常量取值依据与被否掉的两条阈值方案） |
| [`COGNITIVE-EVOLUTION-SPEC.md`](docs/COGNITIVE-EVOLUTION-SPEC.md) | 认知进化专题契约（v1.1：5 级链 / VERDICT 闸门 / 证据式判定 / 词条直达·出题评估） |
| [`dev/test-plan.md`](docs/dev/test-plan.md) | 测试策略 / 基线用例数 / 逐文件不变量 |
| [`dev/bug-ledger.md`](docs/dev/bug-ledger.md) | 反复 bug 台账（收敛计数驱动换根因假设） |
