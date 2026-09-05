# studentbuddy v2

![node](https://img.shields.io/badge/node-%E2%89%A520.11-blue)
![tests](https://img.shields.io/badge/tests-26%20files%20%2F%20302%20cases-brightgreen)
![stack](https://img.shields.io/badge/stack-React%2018%20·%20Express%20·%20SQLite-8a63f6)

> 本地优先的 AI 学习助手（学习版豆包）：**学 → 练 → 析 → 忆 → 反馈**闭环。
> v2 全新重写仓——v1（[llwand1/studentbuddy](https://github.com/llwand1/studentbuddy)，已冻结）按「需求为纲、简洁优先」六条 ADR 从零重写为本仓。

## 目录

- [这是什么](#这是什么)
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

## 功能总览

### 学 · 对话核
- **SSE 流式输出**：token 级流式上屏，屏上文本与库内文本逐字一致；断线指数退避重连 + 事件序号回放去重
- **单轨工具循环**：原生 function-calling 循环（8 轮上限 / 14k 回灌截断 / 逐轮预算检查 / 工具轮原子落库，无孤儿 tool 消息）
- **联网搜索**：Exa / Tavily / 智谱按 key 并行聚合 + 跨家 URL 去重 + 24h 缓存；三家无 key 走 DuckDuckGo 兜底；出网带 SSRF 护栏
- **工具调用可视化**：`step` 事件三态进度芯片上屏（进行中 / 完成 / 失败），搜索溯源可见
- **文档模式（简易 RAG）**：给会话绑定一篇资料（粘贴 / .txt / .md），整篇直塞注入提示词并计入上下文预算；存储不丢字，截断只发生在注入层；出题 / 抽词缺材料时自动回退用会话资料

### 学 · 内置浏览器面板
- ```html 围栏产出可交互演示页：对话里只出卡片，点「侧栏预览」在应用右侧内置面板运行（或新标签页）
- 面板只挂模型产出（无地址栏），出页带 `CSP: sandbox` + iframe 双层 sandbox，页面源为 `null`

### 练 + 析 · 出题
- **出题引擎**：`[QUIZ]` 协议出题入库，五级解析阶梯（无损补括号 → 原样 parse → 剥图重试 → 截断逐题回退 → 回退后再剥图），撞 `max_tokens` 或模型漏写括号都不再整组 502
- **题型配比可配**：单选 / 多选 / 填空 / 解答四档各 0..10、总上限 20；编辑期钳位（所见即所存），服务端归一化兜底；对话页与题库页共用全局配比
- **出题配图**（默认关）：开关打开后模型为涉及示意图的题目产出 SVG；丢图保题（坏图整字段删除，不连坐整组）；没图 / 丢图 / 被截断全链路如实上报
- **题库与统计**：逐题统计、薄弱点、golden dataset

### 忆 · AI 词条库
- **双通道抽词**：对话自动抽取（回复后 fire-and-forget，不阻塞）+ 手动「存入记忆」
- **相关性注入**：回复前检索命中词条作为第二条 system 注入，软性参考不强制；回复后 usage 计数
- **AI 整理**：对话内自然语言触发 `tidy_terms` 工具——自动分组、同义词归一、领域归一，只合并不删除，被并同义词挂主条 `aliases` 防再分裂

### 反馈
- 事件总线驱动的 XP 连签、今日总结、近 7 天趋势

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

> ⚠️ **必须用 Node 20**（`engines: >=20.11.0`）：`better-sqlite3` 原生模块按 Node 20 编译，Node 22 跑涉库代码会全线 `NODE_MODULE_VERSION` 报错。

```bash
# 0) 用 Node 20（按你的安装路径调整）
#    本机参考：C:\nodejs20\node-v20.18.3-win-x64

npm install          # workspaces 三包一次装齐
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
│  ├─ learning/             quiz 出题引擎(+json-repair) / terms 词条库 / tidy 整理 / document 文档模式 / activity
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
| 5.0 §5 学环·文档模式（整篇直塞 RAG） | ✅ 2026-09-02 |

## 已知限制

- **行内公式不渲染**：`$…$` 按原文显示（未引 katex，保持 `@sb/web` 零运行时依赖）；`mermaid` / `echarts` 围栏降级代码块（刻意不引库，数据图由自绘 ```chart 覆盖）
- **预览页只活内存**：服务重启即失效，无分享链接（本地单用户形态无场景）；内置面板无地址栏、宽度不可拖拽（只挂模型产出，是定档边界不是缺陷）
- **文档模式是整篇直塞不是检索**：无切块 / 无向量库 / 无跨会话检索，超 `MAX_DOC_CHARS=60_000` 注入层截断（库里保留全文）
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
| [`COGNITIVE-EVOLUTION-SPEC.md`](docs/COGNITIVE-EVOLUTION-SPEC.md) | 认知进化专题契约 |
| [`dev/test-plan.md`](docs/dev/test-plan.md) | 测试策略 / 基线用例数 / 逐文件不变量 |
| [`dev/bug-ledger.md`](docs/dev/bug-ledger.md) | 反复 bug 台账（收敛计数驱动换根因假设） |
