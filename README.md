# StudentBuddy

[![CI](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml)
![release](https://img.shields.io/github/v/release/llwand1/studentbuddy-v2)
![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![version](https://img.shields.io/badge/version-0.2.151-orange)
![tests](https://img.shields.io/badge/tests-314%20files%20%2F%203749%20cases-brightgreen)
![api](https://img.shields.io/badge/REST%20routes-159-0ea5e9)
![contracts](https://img.shields.io/badge/shared%20contracts-208%20types-8a63f6)
![deps](https://img.shields.io/badge/external%20runtime%20deps-6-blue)
![stack](https://img.shields.io/badge/stack-React%2018%20%C2%B7%20Express%20%C2%B7%20SQLite-8a63f6)

**Windows 安装包：[下载本地版 0.1.0](https://github.com/llwand1/studentbuddy-v2/releases/tag/desktop-v0.1.0)**。Windows 10/11 x64，双击安装后从开始菜单启动，无需安装 Node 或 npm；浏览器自动打开，首次使用在设置里配置自己的 AI 服务商。关闭浏览器后可从托盘退出，升级和卸载保留学习数据。构建说明见 [Windows 本地安装包](docs/DESKTOP-SPEC.md)。

**像素风的游戏化学习 Agent：对话里学、出题里练、知识大陆上复习——你自己的词条库是主体，数据归你（SQLite 单文件，可自托管，开源）。** 在线：<https://11wand.com>（免注册可直接体验）· 本地：`npm install && npm run dev` · 零 key 全栈演示：`npm run demo:e2e`。

**目录**：[为什么用它](#为什么用它) · [快速开始](#快速开始) · [验证：三条命令](#验证三条命令) · [架构](#架构) · [安全与隐私](#安全与隐私) · [已知限制](#已知限制) · [文档索引](#文档索引) —— 功能逐项的实现思路、产品判断与界面预览搬到了 [`docs/FEATURES.md`](docs/FEATURES.md)（长文），本页只留一页架构与三条验证命令。

**30 秒看懂：你想做什么 → 它怎么接**

| 你想… | 它怎么接 |
|---|---|
| 问个问题 | 流式回答 + 思考链 + 工具步骤实时可见；模型自己决定何时搜网 / 查你的词条库 / 出题 / 画图；AI 一联网，右侧**资料架**同步上架，正文里的 `[n]` 点得回原文 |
| 等回复的空档 | 2 秒没回完就弹一张**词卡**（词→义 / 义→词 / 拼写），到期词条答对＝一次真复习打卡 |
| 让它考我 | 对话里说「考我」即可：六型配比、**真题缺省优先**、每道题标清「真题·必刷 / 模拟题·建议做 / 基础题·可选做」、材料与图必须随题带齐、答案先盲解验算 |
| 把学过的记住 | 聊完的概念自动入库 → 回复里高亮 → 长成卡牌 → 铺进知识大陆；**FSRS-5** 按你的记忆决定何时复习，到期地块长草生怪，打败即收复 |
| 用自己的资料学 | 绑定长文档走 BM25 检索注入、带段号可溯源，70 万字也能对答；粘贴图片提问走独立视觉角色 |
| 不想注册 / 不想联网 | 首页「免注册，直接体验」；或 clone 后 `npm run demo:e2e`（零 API key、零外呼、杀进程重启后逐字仍在） |

## 为什么用它

**StudentBuddy 是一个带工具循环、写操作确认门与长期记忆的学习 Agent；你自己的词条库是主体，游戏化（知识大陆、词条卡牌、对战、魔法吟唱）是同一个学习内核（学 → 练 → 析 → 忆 → 反馈）的表达方式，不是套在外面的皮。**

- **对话本身就能干活**：流式回答 + 思考链可见，模型自己决定何时搜网、查你的词条库、出题、画图；资料架随搜索上架，回答里的 `[n]` 点得回原文；绑定长资料走 BM25 检索注入、带段号可溯源。
- **词条是主体，学的痕迹自动沉淀**：聊完的概念自动入库 → 驱动出题 → FSRS-5 决定复习时机 → 回复里高亮 → 长成卡牌 → 铺进知识大陆。
- **数据归你**：SQLite 单文件、可自托管、开源。
- **前端依赖极少**：`@sb/web` 运行时依赖只有 react / react-dom；Markdown / SVG 净化 / 图表自绘，不可信内容的渲染契约见 [`docs/UNTRUSTED-RENDER-SPEC.md`](docs/UNTRUSTED-RENDER-SPEC.md)。

- **在线体验**：<https://11wand.com>（**已上线到 v0.2.151**）。首页「免注册，直接体验」直连公用体验账号；⚠️ 公用池全站共享、访客彼此可见，别放个人信息。
- **不想点网页？** clone 后 `npm run demo:e2e` 跑完确定性全栈演示（用户 → API → 假 LLM → SSE → 落库 → 杀进程重启后逐字仍在；零 API key、零真实外呼）。
- v2 是全新重写仓（v1 [`llwand1/studentbuddy`](https://github.com/llwand1/studentbuddy) 已冻结）。每个功能为什么这么做、产品为什么砍功能转游戏化，见 [`docs/FEATURES.md`](docs/FEATURES.md)。

> 🏷️ **全仓只有一个版本号**（2026-09-30 起）：`package.json` ＝ git tag ＝ Release ＝ `CHANGELOG.md` ＝ `/changelog` ＝ `/api/status`，由 `node tools/check-version.mjs` 守门（`npm run gates` 的一环）。
> 📌 本文所有定量数字**不许手抄**：由 `node tools/metrics.mjs` 产出，`--check` 在漂移时退出码 1（CI 跑的就是 `metrics --tests --check`）。

## 快速开始

**不想装环境？** 直接打开 **<https://11wand.com>**。**想完全本地、数据只留在自己机器上？** 按下文跑本地单机形态——两种形态**共用同一份代码**，差异只在环境变量。

> ⚠️ **Node 版本必须「装依赖」与「运行时」一致**（`engines: >=22.11.0`，仓库带 `.nvmrc`）：`better-sqlite3` 是原生模块，产物按**安装那一刻**的 Node ABI 编译；换 Node 大版本必须删 `node_modules` 重装，只换运行时无效，症状是涉库代码全线 `ERR_DLOPEN_FAILED`（极易误判成新代码写错）。

```bash
npm install          # workspaces 三包一次装齐（装依赖的 Node = 以后跑的 Node）
npm run check        # lint(tsc×3 + eslint) + test(vitest) + gates —— 全绿基线
npm run demo:e2e     # 确定性全栈演示：34 断言，零 API key、零真实外呼、临时隔离库
npm run dev          # 一条命令并行拉起 api :18791 + web :5173（Ctrl+C 一起停）
```

浏览器打开 **http://localhost:5173**（vite 监听 IPv6 `::1`，用 localhost 而非 127.0.0.1）。首次使用：设置页添加 AI 服务商（OpenAI 兼容协议）；要用联网搜索再配搜索 key。

## 验证：三条命令

**文档说的任何话都可以不信，下面三条命令的输出可以当场信。**

| 命令 | 你会看到 |
|---|---|
| `npm run check` | tsc×3 ＋ eslint ＋ vitest 全量 ＋ 门禁（行数红线 / 禁 `any` / 禁内联样式 / 测试逐文件登记 / 版本号一致）一次跑绿 |
| `npm run demo:e2e` | **确定性全栈**：注册 → 假 LLM → SSE → 落库 → **杀进程重启后逐字仍在**，34 条断言全过，零 API key、零真实外呼 |
| `node tools/metrics.mjs --tests --check` | 本文与首屏的**每个可核对数字**对代码实测对账，漂移即退出码 1（CI 跑的就是这条） |

当前测试基线 **313 文件 / 3780 例**，全绿（passed/skipped 明细分平台不同，不进本文手抄）。逐文件不变量见 [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md) §3；三套离线评测（`npm run eval` / `eval:models` / `eval:agent`）见 [`docs/FEATURES.md`](docs/FEATURES.md#测评怎么证明上面每句话)。

另有几件不进 `check`、按需跑的仪器：`node tools/loadtest/sse-load.mjs`（单进程 SSE 容量探针，读数在 [`docs/SCALING.md`](docs/SCALING.md)）、`node tools/retention-report.mjs --db …`（只读留存报表，口径在 [`docs/RETENTION-SPEC.md`](docs/RETENTION-SPEC.md)）、`node tools/guard-audit.mjs`（把守门故意改坏，证明它们真的会红）。

## 架构

**单页架构图**（20 秒读法：从上往下＝一次请求的旅程；三条虚线＝三道边界——信任、归属、凭据）：

![架构总览：浏览器 → 信任边界 → App Server → 归属边界 → 域层 → SQLite；右侧凭据边界外是 LLM 上游](docs/images/architecture.svg)

**三包职责**：`@sb/shared` 只放契约与纯函数（前后端共用一份，不允许各写一套）；`@sb/server` 承载全部业务域（Express + better-sqlite3，逐版本迁移 v1..v52）；`@sb/web` 是 React 18 前端，**零第三方运行时依赖**（无 UI 库 / 无 Markdown 库 / 无图表库）。

**一级视图五个**（`App.tsx` 的 `View` 联合）：对话 / 词条 / 卡牌 / 知识大陆 / 设置；对战是 `#/pk` 独立页，督促是常驻胶囊。★ 新功能**默认不新增一级导航项**。

运行时形态：`api(Express :18791，默认仅绑 127.0.0.1) + web(Vite :5173)`，数据存 SQLite 单文件（WAL）；多用户 Web 形态同一份代码 + 邮箱/密码/GitHub OAuth 鉴权 + 按用户数据归属 + Caddy 反代 + systemd 守护。★ `server/auth/form.ts` 是形态的**唯一事实源**（`SB_REQUIRE_AUTH` 开 = cloud / 关 = local），「本地有、线上没有」的功能一律从这里判断，禁止各自读 env。

目录结构、模块地雷图与代码地图见 [`docs/ENGINEERING.md`](docs/ENGINEERING.md) §4；单进程容量实测、进程内状态清单与扩容阶梯见 [`docs/SCALING.md`](docs/SCALING.md)。

## 安全与隐私

按 ADR-2「安全做必要最小」：

- **Origin 校验**：写操作校验 Origin，**不放行 `'null'`**（sandbox 预览页的源就是字符串 null，放行等于让模型写的网页能调写接口——情景题与沙箱卡的整条信任边界就建在这条上）
- **口令与会话**：`crypto.scrypt` 派生且**参数随哈希自描述落库**；库里只存 `SHA-256(sessionToken)` + `HttpOnly` cookie；「邮箱不存在」与「密码错」回同一个错误码
- **验证码**：签发即哈希入库、一次性靠**原子认领**（先查后改会让同一个码用两次）；真正的防线是尝试上限 + 发送侧限流
- **模型产出不裸跑**：```html 走 `CSP: sandbox`（无 allow-same-origin）＋ iframe 双层沙箱，页面源为 `null`；```svg 走**白名单净化器**（HTML 解析 → 元素/属性白名单 → `XMLSerializer` 重排，剥 `<image>` 外链与全部脚本载体，输出幂等），28 例攻击语料 + 确定性模糊测试守着，契约见 [`docs/UNTRUSTED-RENDER-SPEC.md`](docs/UNTRUSTED-RENDER-SPEC.md)
- **密钥不出接口**：搜索 key 与模型 key AES-GCM 密文入库，响应只回布尔；搜索 / 抓取出网走 **SSRF 护栏 + 白名单**，抓页单页不遍历
- **归属过滤按读形状分两把锁**：读「一批行」用 `ownerFilter`，读「一个值/聚合」用 `ownerForWrite`；跨用户访问一律 **404 不回 403**（403 等于承认「这个 id 存在」）
- **资料阅读页不是开放代理**：`GET /api/sources/{view,pdf}` 只服务**本会话资料架上的网址**（授权 = 会话可访问 **且** 网址在该会话的在线注册表或 `message_source` 表里），否则 403；抓取一律走同一套 SSRF 逐跳复检。阅读页零脚本——CSP `default-src 'none'` + 白名单清洗双保险，`sandbox` 不给 `allow-same-origin`，图片 `no-referrer`；PDF 转发校前 5 字节魔数、上限 25 MB

## 已知限制

> 这一节的立场：**先说自己哪里不行。** 完整的缺陷 / 定档边界清单在 [`docs/metrics-product.md`](docs/metrics-product.md)。

- **可用性目前算不出来**：看门狗只在异常时落笔 ⇒ 没有分母，只能给「发生过几次 DOWN」。
- **线上量级是个位数，留存刚开始可测**：2026-09-24 只读审计 users 6 / sessions 47。此前连「谁在哪天来过」都没记录 ⇒ 留存算不出；2026-09-30 起 v52 按日活跃心跳 + `tools/retention-report.mjs` 把它变成可测的，但**数据从上线日起才有**，心跳满 4 周且纳入用户 ≥30 之前不发布任何留存百分比（[`docs/RETENTION-SPEC.md`](docs/RETENTION-SPEC.md) §5）。「已上线」不等于「有留存」，这一条本文不替自己圆。
- **单进程部署**：上游并发闸门、SSE 订阅、PK 房间都是进程内状态；本机实测 100 并发流式生成零失败，真正先到顶的是免费通道 `SB_UPSTREAM_SITE_MAX_CONCURRENT=8` 的配额策略；多实例的前提与阶梯见 [`docs/SCALING.md`](docs/SCALING.md)。
- **容器化：本机已跑通，线上确定不切**（2026-09-29 决策，理由与前置清单见 [`DEPLOY.md`](DEPLOY.md) §11）。
- **文档模式是词法检索，不是语义检索**：没有 embedding；用户不用资料里的原词改写提问时，70 万字规模下召回约 62%。
- **渲染层覆盖不完整**：jsdom 交互测试只覆盖最高频几页；布局与观感类症状只能靠真机探针 + 人工目检。
- **行内公式不渲染**（`$…$` 按原文显示）、`mermaid` / `echarts` 围栏降级代码块——刻意不引库以保住 `@sb/web` 零第三方依赖。
- **预览页只活内存**：服务重启即失效、无分享链接。
- **中英切换只到壳层**：功能页正文与服务端消息尚未双语。
- **题目自包含审查是词法的**：不点名却隐式依赖材料的题检测不到；题图不做 OCR。
- **agent-bench 镜像落后生产一个工具**（`pick_sources`），`npm run eval:agent -- --selftest` 会报镜像漂移；不在 CI 门禁内。
- **微信 / 短信登录未做**（需企业主体资质）。

★ 工程量化（源码 / 测试 / 路由 / 契约 / 覆盖率）由 `node tools/metrics.mjs` 产出，落地在 [`docs/metrics.md`](docs/metrics.md)。

## 文档索引

`docs/` 是本仓的**权威技术文档面**：`*SPEC*.md` 是行为契约（**改行为先改契约**）。

| 文档 | 内容 |
|------|------|
| [`FEATURES.md`](docs/FEATURES.md) | **功能与工程实现（长文）**：最近上新 / 产品判断 / 对话核 / 出题管道 / 记忆与 FSRS / 知识大陆 / 搜索 / AI 网关 / 测评体系 / 界面预览（2026-09-30 从 README 搬出） |
| [`ENGINEERING.md`](docs/ENGINEERING.md) | **工程文档**：工程约定（规模约束 / 禁 `any` / 禁内联样式 / 测试登记 / 契约先行）/ 四条复验命令 / 三道最难的工程问题 / 仓库结构与代码地图 / 门禁与扩展模式 / 配置说明 |
| [`GAMIFIED-AGENT-SPEC.md`](docs/GAMIFIED-AGENT-SPEC.md) | **游戏化产品口径契约**：一句话叙事 / 轻量化·可玩性·开放性判断标准 / 明确不做 / 分期 |
| [`TOOL-ECOSYSTEM-SPEC.md`](docs/TOOL-ECOSYSTEM-SPEC.md) | 工具生态契约（注册表 / 元数据 / 确认门 / 场景裁剪） |
| [`SCENARIO-SPEC.md`](docs/SCENARIO-SPEC.md) | 情景题契约（评分点判型 / 桥接脚本 / 沙箱边界） |
| [`TERM-CARDS-SPEC.md`](docs/TERM-CARDS-SPEC.md) | 词条卡牌契约（卡墙 / 星级 / 宝箱 / 任务清单） |
| [`MEMORY-SPEC.md`](docs/MEMORY-SPEC.md) · [`MEMORY-TREND-SPEC.md`](docs/MEMORY-TREND-SPEC.md) | 长期记忆契约（压缩 / 画像）/ 记忆联动契约 |
| [`COACH-SPEC.md`](docs/COACH-SPEC.md) | 学习督促契约 |
| [`EBBINGHAUS-SPEC.md`](docs/EBBINGHAUS-SPEC.md) | 复习时钟契约（日历日口径 / 选择式范围 / 目标）；⚠️ 调度内核已升级为 **FSRS-5 + 个人化拟合**（`shared/src/fsrs.ts` · `fsrs-fit.ts` 文件头是现役口径，见「记忆与学习者建模」一节） |
| [`NPC-PARTNER-SPEC.md`](docs/NPC-PARTNER-SPEC.md) | 学习伙伴契约（诞生 / 对话 / 智能体工具 / 主动搭话） |
| [`PK-SPEC.md`](docs/PK-SPEC.md) | 对战契约（计分细则 / power 语义 / 断点口径） |
| [`DOC-RAG-SPEC.md`](docs/DOC-RAG-SPEC.md) · [`FTS-SPEC.md`](docs/FTS-SPEC.md) | 文档模式契约（BM25 检索）/ 全站全文搜索契约 |
| [`AUTH-SPEC.md`](docs/AUTH-SPEC.md) · [`TENANCY-SPEC.md`](docs/TENANCY-SPEC.md) | 账号契约 / 多租户归属契约 |
| [`SSE-CONTRACT.md`](docs/SSE-CONTRACT.md) · [`CHAT-UX-SPEC.md`](docs/CHAT-UX-SPEC.md) | SSE 事件与 HTTP 接口契约（前端对接核心）/ 对话页流式期与常用动作口径（重试 / Esc 停止 / 会话草稿 / 标题态 / 引用追问） |
| [`WAIT-DRILL-SPEC.md`](docs/WAIT-DRILL-SPEC.md) | 等待时刷词契约（2 秒才弹 / 答完切回 / 到期打卡 / AI 新词候选闸门 / 特效与音频口径） |
| [`SOURCE-TRACE-SPEC.md`](docs/SOURCE-TRACE-SPEC.md) | 资料溯源契约（资料架编号即身份 / 阅读页零脚本与授权 / `pick_sources` / `[n]` 引用芯片 / 落库与历史重开 / 与刷词小窗共存） |
| [`QUIZ-TIER-SPEC.md`](docs/QUIZ-TIER-SPEC.md) | 出题分级与真题优先契约（三档由服务端按事实推 / 基础题就说是基础题 / 搜集辨别层：尾锚点·选项命中率·考试信号 / 真题优先配额与生效条件） |
| [`QUIZ-COMPLETE-SPEC.md`](docs/QUIZ-COMPLETE-SPEC.md) · [`eval/complete.md`](docs/eval/complete.md) | 题目自包含契约（`material` 字段 / 确定性依赖审查 / 一次修复调用 / 补不全整题剔除 / 搜集侧图与材料搬运）/ 对应评测读数 |
| [`tools/eval/agent-bench/README.md`](tools/eval/agent-bench/README.md) · [`model-bench/README.md`](tools/eval/model-bench/README.md) | 三套离线评测中的两套说明：agent 循环评测（四套件 / 镜像自检 / pass^k）/ 模型横评（七套件） |
| [`SCALING.md`](docs/SCALING.md) | **容量与扩容**：单进程实测边界（可复测）/ 进程内状态清单 / 三阶梯与触发条件 / `/api/health` 实例字段 |
| [`RETENTION-SPEC.md`](docs/RETENTION-SPEC.md) | **留存口径**：v52 按日活跃心跳 / 只读报表 / 何时才有资格发百分比 |
| [`UNTRUSTED-RENDER-SPEC.md`](docs/UNTRUSTED-RENDER-SPEC.md) | **不可信内容渲染契约**：SVG 白名单净化 / 链接协议 / 模糊测试 |
| [`TEST-PLAN.md`](docs/TEST-PLAN.md) | **测试清单**：测试策略 / 运行命令 / 逐文件不变量（每个测试文件锁什么） |
| [`DEPLOY.md`](DEPLOY.md) | **部署手册**：服务器 / systemd / 五条部署 env / TLS / 备份 / 回滚 |
| [`CHANGELOG.md`](CHANGELOG.md) | 已发布版本的对外更新记录 |

★ 完整契约清单（42 份 SPEC）直接看 `docs/` 目录。仓内以 `docs/` 与代码为准；文档与实现冲突时**以代码 + 测试为准**。
