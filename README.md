# StudentBuddy

**像素风的游戏化学习 Agent：聊明白之后，还管你下一次还记不记得。**

[![CI](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml)
![release](https://img.shields.io/github/v/release/llwand1/studentbuddy-v2)
![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![version](https://img.shields.io/badge/version-2.0.0--alpha.0-orange)

它已经上线在 **[11wand.com](https://11wand.com)**，也可以在你自己的电脑上跑。

市面上给 AI 加个输入框的产品已经很多了。StudentBuddy 想补的是**提问之后的那几步**——这段解释值不值得留下、什么时候该再看一次、到时候你还答得出来吗。

这些东西最后会变成一片**属于你自己的知识大陆**：学过的概念是地块，到期没复习的会长出怪物，答对了才能把地收回来。积累下来的词条和卡牌，就是下一次探索的起点。

[在线体验](https://11wand.com) · [本地运行](#快速开始) · [它跟普通聊天有什么不一样](#它跟普通聊天有什么不一样) · [更新记录](https://11wand.com/changelog/index.html)

---

## 它跟普通聊天有什么不一样

不是功能多少的差别，是这五件事被当成主线来做：

**① 聊完会留下东西。**
一段解释觉得有用，可以让 AI 把它整理成词条存进你的词条库。以后在任何一次回复里再遇到这个词，都能直接点开那张卡片回看——它是你的库存，不是沉在聊天记录里翻不到的流水。

**② 每个词条挂着一个复习时钟。**
复查点是 **1 / 2 / 4 / 7 / 15 / 30 / 60 天**七个节点，走完算毕业。复习范围由你自己勾选（不是全库自动进池，不相关的东西不会来烦你），今日目标也能自己定；到期量不够时，队列按「真到期 → 提前背 → 重复巩固」三段补位，而不是丢给你一个空队列。

**③ 卡牌不是第二套积分。**
一条词条有几张卡，是从**已经发生过的事件**里数出来的：被提及的次数 ＋ 复习过的天数 ＋ 从每日宝箱收下的次数 ＋ 建卡那张。数据库里没有 `cards` 这样的计数字段，所以它永远不会和你的真实行为对不上账。

**④ 复习是一次收复，不是一条待办。**
到期的词条会在知识大陆上变成怪物占住地块。你得把英雄走过去、站到它旁边才能开打；逾期越久，它吞下的地块越多。判断 / 选择 / 填空 / 连线 / 情景五种题型按等级出题，全答对才把地收回来、图鉴里多记一笔。**地图只增不减**——忘了只是地块褪色长草，不会把你已经铺出来的东西抹掉。

> 走位、领地扩散、地图上的宝箱和情景题这几样**已经在仓库里**，但要等下一个版本才会在网站上出现（见下面「这一版没做什么」）。

**⑤ 数据默认在你自己手上。**
同一份代码有两种跑法：装在自己电脑上，学习记录就是本机的一个 SQLite 文件，不出机器；也可以自己部署成多用户服务。模型走你自己的服务商（OpenAI 兼容协议或 Anthropic），联网搜索三家可换，一个都不配也有免 key 通道兜底。

顺带说明：题型和怪物是围着你的真实词条生成的，不是一份通用题库。

---

## 一次学习在这里怎么走完

```text
  问明白 ──▶ 留成词条 ──▶ 攒成卡牌 ──▶ 到期复习 ──▶ 收复地块
     ▲                                      │            │
     │                                      ▼            │
     └────────── 答错的点回到对话继续追问 ◀── 判分与逐题解析 ──┘
```

这条闭环从左走到右，也允许中途随时折回去：任何一步卡住，都能回到对话接着问同一个点。

Agent 在这条路上负责的是**把几件事接起来**：按对话内容决定要不要查资料、要不要整理成词条、什么时候该出题，结合复习状态提醒你回来，也支持在合适的话题下发起对战邀请。你想学什么由你定，它负责让你不用自己盯着流程。

## 界面

下面是**真机截图**：无头浏览器直出，按仓库当前源码在本地形态渲染，不是设计稿也不是拼接。跑图用的是一个临时隔离库，往里灌了一小批示例词条，好让卡墙和地图上有东西可看——跑完即删，不碰真实数据，也不调用模型。

**进去第一眼** —— 像素风应用壳：左侧导航、中间对话，右下角是常驻督促胶囊

![对话](docs/images/pixel-chat.png)

**词条卡牌** —— 上面是每日宝箱与任务清单，下面是按星级铺开的卡墙

![词条卡牌](docs/images/pixel-cards.png)

**知识大陆** —— 词条从中心往外铺成地块，越靠中心说明学得越早

![知识大陆](docs/images/pixel-continent.png)

整套界面是统一的像素风主题：聊天、词条、卡牌、知识大陆、对战与设置共用一套配色和图标；手机上另有底部导航；系统打开「减少动态效果」时动画会让位。

---

## 现在能做什么

| 你想做的事 | 对应功能 |
| --- | --- |
| 弄懂一个概念，追问看不懂的地方 | AI 对话、回答方式偏好、文档问答、联网搜索 |
| 保存知识，之后能再找到 | 词条库、AI 整理、回复中的词条高亮与卡片 |
| 看到自己攒下了什么 | 词条卡牌：卡墙、星级、收藏进度、每日宝箱、任务清单 |
| 回顾自己选定的内容 | 复习范围与倒计时、自定义今日目标、三段补位队列 |
| 把复习当成一次收复 | 知识大陆：词条地块、到期怪物、五题型挑战、英雄走位与领地扩散、图鉴 |
| 检查理解，和朋友一起练 | 对话出题（当场判分 + 逐题解析）、AI 对战、邀请好友 PK |
| 用自己的模型和数据环境 | 自定义 AI 服务商、本地运行或自行部署 |

**已上线到 v0.2.136**。具体变化见[更新记录](https://11wand.com/changelog/index.html)；GitHub 主分支和开发分支可能包含尚未部署的改动。

题库页面、笔记、今日总结已下线，出题能力保留在对话与对战里；这些已下线功能的设计存档仍在文档索引里可查。

---

## 这一版没做什么

先分清两件事：**网站上是 v0.2.136**，仓库里已经合并但还没发布的改动不在这一版里。

**代码里有、网站上还没有**（要等下一个版本）：英雄走位与自动寻路、按逾期天数扩散的领地、地图上的宝箱、第五种题型（情景题）、以及过渡特效。★ 这一批到目前为止**只做过 headless 验证**（Canvas 部分是打桩跑的），浏览器里的实际观感还没验收过。

**还没做的**：
- 历史副本生成、AI 生成地图、Boss 对战与 PK 联动。
- **弱项统计不再有**：逐题薄弱点统计随题库一起下线，现在留下来的是**当场判分 + 逐题解析**。
- **单实例部署**：数据落在单个 SQLite 文件里，跨实例水平扩展时归属与并发闸门的语义要重做。
- **Docker：本机已跑通，服务器还没切**：2026-09-27 在 Windows Docker Desktop / WSL2 上首次把 compose 全栈真跑起来了（`build` 成功、注册登录与 `/me` 全通、`down` 不带 `-v` 重起后会话仍在＝持久卷成立），顺手修掉四处拦路硬伤。但**服务器侧仍是旧的 systemd 部署，还没切换**，容器路径也没进自动化测试门禁（只靠人工验收单）。
- **`demo:e2e` 脚本有陈旧断言**：其中几步还在检查已下线的题库路由，会报红；这是脚本的技术债，不是产品功能坏了。

上面这几条里，最想要的是**历史副本**：给出一个主题（比如「光合作用」），让 Agent 沿着它的发现顺序与争论节点组织一次探索，在关键点出题，用自己的理解推进。这条路还只在设计里。

每一条都写在文档台账里，没做的就写没做。

---

## 快速开始

### 直接使用网页版

打开 **[11wand.com](https://11wand.com)**，注册后开始使用。

### 在自己的电脑上运行

需要 Git 和 **Node.js 22.11 或更高版本**。安装依赖和启动应用时请使用相同的 Node 主版本；切换主版本后需重新安装依赖。

```bash
git clone https://github.com/llwand1/studentbuddy-v2.git
cd studentbuddy-v2
npm ci
npm run dev
```

浏览器打开 **http://localhost:5173**。首次使用时，在设置页添加 AI 服务商，填入服务地址、API key 和模型名称。

本地运行时，学习记录保存在本机的 SQLite 数据库里；调用外部模型或搜索服务时，相关请求内容仍会发送给对应服务商。网页版的记录保存在服务器上。

不想先配模型，可以用 `npm run demo:e2e` 把整条链路跑一遍：模拟模型、全程零真实外呼。⚠️ 它现在跑出来是 **28 通过 / 8 失败**——红的那几步断言的是随题库一起下线的路由，脚本还没跟上收尾，已进入待办。

### 配置说明

| 设置 | 在哪里配置 |
| --- | --- |
| AI 服务商与模型 | 应用设置页；支持 OpenAI 兼容协议及 Anthropic 适配 |
| 联网搜索 | 设置页，或 `EXA_API_KEY` / `TAVILY_API_KEY` / `ZHIPU_API_KEY` 环境变量；未配置时有免 key 通道兜底 |
| 本地数据目录 | `SB_DATA_DIR`；默认放在系统的应用数据目录 |
| 多用户部署、邮件与 GitHub 登录 | 按[部署手册](DEPLOY.md)配置 |

---

## 仓库结构

TypeScript monorepo，三个 npm workspace：

```text
packages/shared   前后端共用的类型与规则
packages/server   对话、词条、复习、卡牌、大陆与数据存储
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

构建要先于检查执行，因为部分测试会检查构建产物。`check` 包含类型检查、lint、测试和代码规范检查；`metrics` 核对 README 里的工程数字。

---

## 工程上较真过的几处

把这个项目和一个「包了层 UI 的 API 调用」区分开的，是下面这几处——每一条都对应一次真实故障，对策都锁进了回归测试：

| 问题 | 这里的做法 |
| --- | --- |
| 模型不保证吐出合法 JSON | 出题走五级解析阶梯：补闭合 → 原样 parse → 剥图重试 → 截断逐题回退 → 回退后再剥图；单题配图非法**只删那一题的图**，整组照发；交付情况用 `requested / delivered / droppedSvg / truncated` 四态上报，缺几题说几题 |
| 断线重连会把答案上双份 | SSE 帧序号按轮单调；重连只为「正在进行的一轮」回放，已完结的一轮只补一个 `done`；跨轮 `since` 归零处理、15 秒心跳、缓冲 TTL 回收与快照对齐 |
| 多用户漏一个 WHERE 就是泄漏 | 读「一批行」和读「单个值」用两把不同的归属过滤器；跨用户一律回 **404 而不是 403**（403 等于承认这个 id 存在）；每批归属改造都配一条「故意改坏必红」的负向锁 |
| 模型写的页面要在你浏览器里跑 | 预览页带 `CSP: sandbox` + iframe 再叠一层沙箱；Origin 校验**刻意不放行 `'null'`**；SVG 先过净化器剥掉 script / foreignObject / 外链 image |
| 文档数字会腐烂 | README 里每个可核对数字由 `tools/metrics.mjs` 实测比对，手抄即红（CI 第 6 步）；门禁本身还有一份「把每条规则逐个改坏、证明它真会红」的审计脚本 |

这几类设计的取舍、代价和「什么时候这个选择作废」都写在 [工程导览](docs/INTERVIEW.md) 里，包括为什么选 SQLite、为什么用 SSE 不用 WebSocket、为什么不用向量库。

<details>
<summary>工程指标与代码地图</summary>

![tests](https://img.shields.io/badge/tests-213%20files%20%2F%202887%20cases-brightgreen)
![api](https://img.shields.io/badge/REST%20routes-129-0ea5e9)
![contracts](https://img.shields.io/badge/shared%20contracts-136%20types-8a63f6)
![deps](https://img.shields.io/badge/external%20runtime%20deps-6-blue)

测试基线：**213 文件 / 2887 例**（2886 passed + 1 skipped + 0 failed）。指标由 `tools/metrics.mjs` 产出，详情见[工程指标](docs/metrics.md)与[测试计划](docs/dev/test-plan.md)。

`v0.2.x` 是对外发布的构建版本，`package.json` 里的 `2.0.0-alpha.0` 是 v2 产品开发线。看线上变化请以公开更新记录和 GitHub Releases 为准。

**想看某个主题，打开这里：**

| 你想看 | 打开 |
| --- | --- |
| SSE 帧序与断线恢复 | `packages/server/src/chat/sse-bus.ts`（前后端两侧各有一份 8 例回归锁） |
| 一轮对话的完整编排 | `packages/server/src/chat/flow.ts` |
| 出题可靠性（五级阶梯） | `packages/server/src/learning/quiz.ts` |
| LLM 供应商适配与并发闸门 | `packages/server/src/llm/router.ts` · `upstream-gate.ts` |
| 归属隔离 | `packages/server/src/auth/ownership.ts` · [契约](docs/TENANCY-SPEC.md) |
| AI 内容消毒 | `packages/web/src/lib/svg-utils.ts` · `packages/server/src/routes/preview.ts` |
| 卡牌派生规则 | `packages/shared/src/term-cards.ts`（曲线与稀有度的唯一实现） |
| 复习与节点 | `packages/shared/src/ebbinghaus.ts` · [契约](docs/EBBINGHAUS-SPEC.md) |

</details>

---

## 文档索引

| 想了解的内容 | 从这里开始 |
| --- | --- |
| 像素界面与玩法 | [像素 UI 说明](docs/PIXEL-UI.md) · [知识大陆](docs/KNOWLEDGE-CONTINENT-SPEC.md) · [卡牌规则](docs/TERM-CARDS-SPEC.md) |
| 自己部署、备份与回滚 | [部署手册](DEPLOY.md) |
| 技术架构与取舍 | [工程导览](docs/INTERVIEW.md) |
| 词条、复习与长期记忆 | [词条整理](docs/TERM-TIDY-SPEC.md) · [词条卡片](docs/TERM-HIGHLIGHT-SPEC.md) · [复习规则](docs/EBBINGHAUS-SPEC.md) · [长期记忆](docs/MEMORY-SPEC.md) |
| 文档问答与对话呈现 | [文档检索](docs/DOC-RAG-SPEC.md) · [回答偏好](docs/ANSWER-STYLE-SPEC.md) · [交互提问](docs/ASK-CHOICE-SPEC.md) |
| 对战玩法 | [PK 设计](docs/PK-SPEC.md) · [对战演示](docs/PK-DEMO-SPEC.md) |
| 接口与账号 | [事件和接口约定](docs/SSE-CONTRACT.md) · [账号](docs/AUTH-SPEC.md) · [数据归属](docs/TENANCY-SPEC.md) |
| 开发与测试记录 | [项目改动](CHANGELOG.md) · [测试计划](docs/dev/test-plan.md) · [问题记录](docs/dev/bug-ledger.md) |

<details>
<summary>更多设计文档与历史记录</summary>

- 学习辅助：[记忆联动](docs/MEMORY-TREND-SPEC.md)、[学习督促](docs/COACH-SPEC.md)、[场景卡](docs/SCENARIO-SPEC.md)。
- 练习设计：[出题配图](docs/QUIZ-IMAGE-SPEC.md)、[出题检索](docs/QUIZ-SEARCH-SPEC.md)、[薄弱点分析](docs/QUIZ-WEAK-SPEC.md)、[学习素材搜集](docs/RESOURCE-SPEC.md)。
- 工程与发布：[工具扩展](docs/TOOL-ECOSYSTEM-SPEC.md)、[SEO](docs/SEO-SPEC.md)、[GitHub 维护](docs/GITHUB-OPS-SPEC.md)、[上线记录](docs/dev/launch-plan.md)。
- 产品记录：[产品度量](docs/metrics-product.md)、[项目增长](docs/project-growth.md)。
- 已移除功能的设计存档：[学习流与知识图](docs/STUDY-FLOW-SPEC.md)、[深度理解](docs/DEEP-UNDERSTANDING-SPEC.md)、[刷题笔记](docs/QUIZ-NOTES-SPEC.md)、[题库与薄弱点](docs/QUIZ-WEAK-SPEC.md)。这些文档保留历史设计，不代表当前功能。
- v1 用户迁移：仓库提供 `tools/migrate-from-v1/migrate.mjs`，先用 `--dry-run` 查看报告，再按需用 `--run` 执行；迁移前请备份数据。

</details>

如果某次解释不清楚、复习流程不顺手，或对战中遇到问题，欢迎[提交 issue](https://github.com/llwand1/studentbuddy-v2/issues/new/choose)，附上操作步骤和预期结果会更方便定位。

本仓库是 StudentBuddy v2。[v1 仓库](https://github.com/llwand1/studentbuddy)已冻结，后续开发在这里继续。

采用 [MIT 许可证](LICENSE)。
