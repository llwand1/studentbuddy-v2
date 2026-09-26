# StudentBuddy

**让学过的知识，成为一片可以探索的大陆。**

StudentBuddy 是一个像素风的**游戏化知识学习 Agent**。从一个你感兴趣的问题出发，AI 帮你查资料、理解概念、整理词条，再把这些知识带入复习与挑战。你学过的内容会出现在自己的知识大陆上，成为可以收复的地块、积累的卡牌和下一次探索的起点。

这片大陆来自你实际学过的内容。一个概念刚被弄懂时，你会留下它；到了该复习的时候，它会以怪物的形式提醒你回来。答题收复地块、点亮图鉴，让“我还记得多少”变成一件看得见、可以亲手完成的事。

[进入知识大陆](https://11wand.com) · [本地运行](#快速开始) · [更新记录](https://11wand.com/changelog/index.html) · [反馈问题](https://github.com/llwand1/studentbuddy-v2/issues)

## 从一个问题，开始你的探索

### 找到想弄懂的东西

比如，你正在学 JavaScript，却一直没弄懂闭包。可以直接问：

> “闭包到底保存了什么？用一个计数器的例子讲讲。”

接着追问某一句解释、让它换个例子，或交给它一份资料一起读。需要外部信息时，Agent 可以调用搜索；想检查理解时，也可以让它围绕当前话题出题。

### 把概念留在自己的世界里

让 AI 把值得记住的概念整理成词条。词条保存解释和别名，在之后的回复里再次出现时，可以打开卡片回看；词条也会成为知识大陆上的地块。

你决定哪些词条需要长期复习。被选中的知识进入间隔复习安排，之后的再次接触与复习也会积累成词条卡牌。卡墙记录收藏与进度，让每次回来都有一处具体的变化。

### 回到大陆，迎接挑战

到了复习时间，大陆上的相应词条会出现怪物。点开挑战，答对题目，收复地块，再继续探索自己的知识地图。图鉴记录遇见过的题型组合，卡牌页还提供任务清单和每日宝箱。

想换一种节奏，可以进入 PK，和 AI 对战，或者邀请朋友一起答题。遇到答不出的地方，就带着问题回到对话里，把那一块知识重新弄明白。

## Agent 如何参与这场探索

Agent 负责把提问、资料、词条和练习接起来：根据对话调用工具、整理知识、生成题目，结合复习状态给出提醒，也可以在合适的话题下发起对战邀请。你选择想学什么，它协助把一次兴趣变成能继续推进的学习过程。

| 探索中的一件事 | 当前对应能力 |
| --- | --- |
| 弄懂一个感兴趣的问题 | AI 对话、文档问答、联网搜索、回答方式偏好 |
| 留下值得记住的概念 | 词条整理、回复高亮、释义卡片、间隔复习 |
| 看见自己的知识地图 | 知识大陆、复习怪物、答题收复、图鉴 |
| 积累学习过程中的收获 | 词条卡墙、收藏进度、任务清单、每日宝箱 |
| 检验理解，和别人一起练 | 对话出题、AI 对战、好友 PK |
| 使用自己的模型和数据环境 | 自带模型 Key、本地运行、自行部署 |

## 这片大陆还会怎样生长

网页版已上线到 **v0.2.136**，包含统一像素界面、卡牌和知识大陆的基础复习挑战。主分支还已加入角色走位、怪物领地扩散、地图宝箱联动与情景题；这些后续改动尚未部署到网页版。具体线上变化以[公开更新记录](https://11wand.com/changelog/index.html)为准。

接下来，我们希望让知识大陆承载更多学习方式。你可以提出一个感兴趣的主题，比如“光合作用”，让 Agent 围绕它的发现、争论和研究发展组织一次历史副本：沿着问题发生的顺序探索，在关键节点遇见挑战，用自己的理解推进故事。

知识大陆也会逐步成为各项 Agent 能力的共同入口：遇到疑问时展开讲解与资料调查，遇到 Boss 时进入对战，探索后留下词条和卡牌。**历史副本生成与 Boss 联动目前仍在规划中，尚未实现。**

## 快速开始

### 直接使用网页版

打开 **[11wand.com](https://11wand.com)**，注册后开始使用。首页也提供“免注册，直接体验”入口。

免注册入口使用公用体验账号，内容可能被其他访客看到。想保存自己的学习记录，请注册独立账号。

### 在自己的电脑上运行

需要 Git 和 **Node.js 22.11 或更高版本**。安装依赖和启动应用时请使用相同的 Node 主版本；切换主版本后需重新安装依赖。

```bash
git clone https://github.com/llwand1/studentbuddy-v2.git
cd studentbuddy-v2
npm ci
npm run dev
```

浏览器打开 **http://localhost:5173**。首次使用时，在设置页添加 AI 服务商，填入服务地址、API key 和模型名称。

本地运行时，学习记录保存在本机的 SQLite 数据库中；调用外部模型或搜索服务时，相关请求内容仍会发送给对应服务商。网页版的记录保存在服务器上。

不配置真实模型也可以运行 `npm run demo:e2e`，查看使用模拟模型的自动化演示。它用于验证应用流程，不会调用真实模型。

### 配置说明

| 设置 | 在哪里配置 |
| --- | --- |
| AI 服务商与模型 | 应用设置页；支持 OpenAI 兼容协议及 Anthropic 适配 |
| 联网搜索 | 设置页，或 `EXA_API_KEY` / `TAVILY_API_KEY` / `ZHIPU_API_KEY` 环境变量；未配置时有免 key 通道兜底 |
| 本地数据目录 | `SB_DATA_DIR`；默认放在系统的应用数据目录 |
| 多用户部署、邮件与 GitHub 登录 | 按[部署手册](DEPLOY.md)配置 |

Docker 部署仍为实验性方案，尚未完成实机验证。自建服务请先阅读部署手册中的运行、备份与回滚说明。

## 开发与贡献

仓库使用 TypeScript，前端是 React，服务端是 Express，数据存储使用 SQLite。代码分为三个 npm workspace：

```text
packages/shared   前后端共用的类型与规则
packages/server   对话、词条、复习、对战与数据存储
packages/web      网页界面
docs              功能设计、接口约定与测试记录
tools             开发、测试与部署工具
```

修改前请先读 [AGENTS.md](AGENTS.md) 中的项目约定。提交前运行：

```bash
npm run build
npm run check
node tools/metrics.mjs --tests --check
```

构建需要先于检查执行，因为部分测试会检查构建后的文件。`check` 包含类型检查、lint、测试和代码规范检查；`metrics` 核对 README 中的工程数字。

如果某次解释不清楚、复习流程不顺手，或对战中遇到问题，欢迎[提交 issue](https://github.com/llwand1/studentbuddy-v2/issues/new/choose)。附上操作步骤和预期结果，会更方便定位。

<details>
<summary>工程指标与版本说明</summary>

[![CI](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml)
![release](https://img.shields.io/github/v/release/llwand1/studentbuddy-v2)
![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![version](https://img.shields.io/badge/version-2.0.0--alpha.0-orange)
![tests](https://img.shields.io/badge/tests-213%20files%20%2F%202887%20cases-brightgreen)
![api](https://img.shields.io/badge/REST%20routes-129-0ea5e9)
![contracts](https://img.shields.io/badge/shared%20contracts-136%20types-8a63f6)
![deps](https://img.shields.io/badge/external%20runtime%20deps-6-blue)

测试基线：**213 文件 / 2887 例**（2886 passed + 1 skipped + 0 failed）。指标由 `tools/metrics.mjs` 核对，详情见[工程指标](docs/metrics.md)与[测试计划](docs/dev/test-plan.md)。

`v0.2.x` 表示对外发布的构建版本；`package.json` 中的 `2.0.0-alpha.0` 表示 v2 产品开发线。查看线上变化请以公开更新记录和 GitHub Releases 为准。

</details>

## 文档索引

| 想了解的内容 | 从这里开始 |
| --- | --- |
| 像素界面与交互 | [像素 UI 说明](docs/PIXEL-UI.md) · [知识大陆接入](docs/KNOWLEDGE-CONTINENT-SPEC.md) · [卡牌规则](docs/TERM-CARDS-SPEC.md) |
| 自己部署、备份与恢复 | [部署手册](DEPLOY.md) |
| 技术架构与设计取舍 | [工程导览](docs/INTERVIEW.md) |
| 词条、复习与长期记忆 | [词条整理](docs/TERM-TIDY-SPEC.md) · [词条卡片](docs/TERM-HIGHLIGHT-SPEC.md) · [复习规则](docs/EBBINGHAUS-SPEC.md) · [长期记忆](docs/MEMORY-SPEC.md) |
| 文档问答与对话呈现 | [文档检索](docs/DOC-RAG-SPEC.md) · [回答偏好](docs/ANSWER-STYLE-SPEC.md) · [交互提问](docs/ASK-CHOICE-SPEC.md) |
| 对战玩法 | [PK 设计](docs/PK-SPEC.md) · [对战演示](docs/PK-DEMO-SPEC.md) |
| 接口与账号 | [事件和接口约定](docs/SSE-CONTRACT.md) · [账号](docs/AUTH-SPEC.md) · [数据归属](docs/TENANCY-SPEC.md) |
| 开发与测试记录 | [项目改动](CHANGELOG.md) · [测试计划](docs/dev/test-plan.md) · [问题记录](docs/dev/bug-ledger.md) · [人工验收](docs/dev/manual-test.md) |

<details>
<summary>更多设计文档与历史记录</summary>

- 学习辅助：[记忆联动](docs/MEMORY-TREND-SPEC.md)、[学习提醒](docs/COACH-SPEC.md)、[场景卡](docs/SCENARIO-SPEC.md)。
- 练习设计：[出题配图](docs/QUIZ-IMAGE-SPEC.md)、[出题检索](docs/QUIZ-SEARCH-SPEC.md)、[薄弱点分析](docs/QUIZ-WEAK-SPEC.md)、[学习素材搜集](docs/RESOURCE-SPEC.md)。
- 工程与发布：[工具扩展](docs/TOOL-ECOSYSTEM-SPEC.md)、[SEO](docs/SEO-SPEC.md)、[GitHub 维护](docs/GITHUB-OPS-SPEC.md)、[上线记录](docs/dev/launch-plan.md)。
- 产品记录：[产品度量](docs/metrics-product.md)、[项目增长](docs/project-growth.md)。
- 已移除功能的设计存档：[学习流与知识图](docs/STUDY-FLOW-SPEC.md)、[深度理解](docs/DEEP-UNDERSTANDING-SPEC.md)、[刷题笔记](docs/QUIZ-NOTES-SPEC.md)。这些文档保留历史设计，不代表当前功能。
- v1 用户迁移：仓库提供 `tools/migrate-from-v1/migrate.mjs`，先用 `--dry-run` 查看报告，再按需用 `--run` 执行；迁移前请备份数据。

</details>

本仓库是 StudentBuddy v2。[v1 仓库](https://github.com/llwand1/studentbuddy)已冻结，后续开发在这里继续。

采用 [MIT 许可证](LICENSE)。
