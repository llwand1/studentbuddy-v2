# StudentBuddy

[![CI](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml)
![release](https://img.shields.io/github/v/release/llwand1/studentbuddy-v2)
![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![version](https://img.shields.io/badge/version-0.2.174-orange)
![tests](https://img.shields.io/badge/tests-395%20files%20%2F%204518%20cases-brightgreen)
![api](https://img.shields.io/badge/REST%20routes-188-0ea5e9)
![contracts](https://img.shields.io/badge/shared%20contracts-273%20types-8a63f6)
![deps](https://img.shields.io/badge/external%20runtime%20deps-6-blue)
![stack](https://img.shields.io/badge/stack-React%2018%20%C2%B7%20Express%20%C2%B7%20SQLite-8a63f6)

**Windows 安装包：[下载本地版 0.1.0](https://github.com/llwand1/studentbuddy-v2/releases/tag/desktop-v0.1.0)**。Windows 10/11 x64，双击安装后从开始菜单启动，无需安装 Node 或 npm；浏览器自动打开，首次使用在设置里配置自己的 AI 服务商。关闭浏览器后可从托盘退出，升级和卸载保留学习数据。构建说明见 [Windows 本地安装包](docs/DESKTOP-SPEC.md)。

**GitHub Packages：[studentbuddy-windows 0.1.0](https://github.com/users/llwand1/packages/npm/package/studentbuddy-windows)**。公开分发同一份安装程序、SHA-256 与许可证；npm 用户可按包内说明下载并运行安装命令。

**像素风的游戏化学习 Agent：对话里学、出题里练、知识大陆上复习——你自己的词条库是主体，数据归你（SQLite 单文件，可自托管，开源）。** 在线：<https://11wand.com>（免注册可直接体验）· 本地：`npm install && npm run dev` · 零 key 全栈演示：`npm run demo:e2e`。

**目录**：[为什么用它](#为什么用它) · [快速开始](#快速开始) · [验证：三条命令](#验证三条命令) · [架构](#架构) · [安全与隐私](#安全与隐私) · [已知限制](#已知限制) · [文档索引](#文档索引) —— 功能逐项的实现思路、产品判断与界面预览搬到了 [`docs/FEATURES.md`](docs/FEATURES.md)（长文），本页只留一页架构与三条验证命令。

**30 秒看懂：你想做什么 → 它怎么接**

| 你想… | 它怎么接 |
|---|---|
| 不知道下一步干什么 | 左上角的**引路灯**：聊完一轮、做完一组题这类时刻它自己亮起来，点开是 AI 按你此刻处境现挑的 2–4 个下一步，一点即执行——第一次＝随机话题、聊完＝出题、做完题＝**一键解析**；迷路了翻「全部功能」，灰着的会告诉你怎么解锁 |
| 问个问题 | 流式回答 + 思考链 + 工具步骤实时可见；模型自己决定何时搜网 / 查你的词条库 / 出题 / 画图；AI 一联网，右侧**资料架**同步上架，正文里的 `[n]` 点得回原文；「找视频」一键去 B站 / 抖音找讲解 |
| 等回复的空档 | 桌面按许可在等待 2 秒后开启**词卡**；手机手动进入，避免遮住回复。到期词条答对＝一次真复习打卡 |
| 让它考我 | 对话里说「考我」即可：六型配比、**真题缺省优先**、每道题标清「真题·必刷 / 模拟题·建议做 / 基础题·可选做」、材料与图必须随题带齐、答案先盲解验算 |
| 把学过的记住 | 聊完的概念自动入库 → 回复里高亮 → 长成卡牌 → 铺进知识大陆；**FSRS-5** 按你的记忆决定何时复习，到期地块长草生怪，打败即收复；词条页里每条词都带卡面与星级，卡墙、宝箱、任务也在同一页 |
| 对战关键时刻 | 新题、答对 / 答错 / 超时、对手得分变化有像素反馈与短音效；连击提示，音效可单独静音并记住本机偏好 |
| 用自己的资料学 | 绑定长文档走 BM25 检索注入、带段号可溯源，70 万字也能对答；粘贴图片提问走独立视觉角色 |
| 不想注册 / 不想联网 | 首页「免注册，直接体验」；或 clone 后 `npm run demo:e2e`（零 API key、零外呼、杀进程重启后逐字仍在） |

## 为什么用它

**StudentBuddy 是一个带工具循环、写操作确认门与长期记忆的学习 Agent；你自己的词条库是主体，游戏化（知识大陆、词条卡牌、对战、魔法吟唱）是同一个学习内核（学 → 练 → 析 → 忆 → 反馈）的表达方式，不是套在外面的皮。**

- **本产品有「引导 + 主动呈现」的设计——功能会来找你，而不是让用户自己琢磨功能**：本产品的判断标准是「惰性功能不写」（[`docs/FEATURES.md`](docs/FEATURES.md#产品判断为什么砍功能为什么转向游戏化)）——必须先想起它存在才起作用、不会自己发起交互、拿掉没人察觉的功能，不做。落到界面上：**左上角的引路灯**按你此刻的处境由 AI 现挑下一步（[`GUIDE-SPEC.md`](docs/GUIDE-SPEC.md)）；另有几处各管一段的主动设计，**每一处都带克制的闸门，不是弹窗轰炸**（逐项数字与契约见 [`docs/FEATURES.md`](docs/FEATURES.md#功能来找你主动呈现设计一览)）：
  - 等回复的空档 → 弹**词卡**（2 秒没回完才弹、秒回不打扰、关掉不作废、回复到了自动切回）
  - 聊到词库里的词 → 对话页弹「刷新了新的怪物」+「一键讨伐」，直达战场开打
  - 有真欠账 → **督促胶囊**主动敲门（没欠账不敲、2 小时冷却、逾期 ≥3 天或堆到 10 条才敲）
  - 讲完一段成体系的内容 → AI 自己递 **PK 邀请卡**（每会话 5 分钟冷却、每人每天 ≤3 次，闸门在数据库里、重启不归零）
  - 地图页开着时 → **学习伙伴**主动搭话（真模型；每位 6 分钟、全局间隔 90 秒、每小时 ≤8 次；没模型宁可沉默）
  - 走到岔路口 → AI 主动问一句并给 2–4 个选项（`ask_choice`）；开局先来一题——空会话现场召来热身题，答完顺着聊，也可直接提问；出题前就地问一次回答方式
  - 做完题 → 「一键讲解」「再练一遍」；每条回答下「找视频」；网页打不开 → 自动换服务器截图
  - 回答本身也会把东西递到眼前 → AI 联网后更新**资料入口**，主动打开可与聊天对照阅读；回复里命中词库的词自动下划线，悬停速览、点开是完整卡；题卡在做之前就标着「真题·必刷 / 模拟题·建议做 / 基础题·可选做」，重开做过的题时标出刷过几遍与「上次 ✓／↗」
- **对话本身就能干活**：流式回答 + 思考链可见，模型自己决定何时搜网、查你的词条库、出题、画图；资料架随搜索上架，回答里的 `[n]` 点得回原文；绑定长资料走 BM25 检索注入、带段号可溯源。
- **词条是主体，学的痕迹自动沉淀**：聊完的概念自动入库 → 驱动出题 → FSRS-5 决定复习时机 → 回复里高亮 → 长成卡牌 → 铺进知识大陆。
- **数据归你**：SQLite 单文件、可自托管、开源。
- **前端依赖极少**：`@sb/web` 运行时依赖只有 react / react-dom；Markdown / SVG 净化 / 图表自绘，不可信内容的渲染契约见 [`docs/UNTRUSTED-RENDER-SPEC.md`](docs/UNTRUSTED-RENDER-SPEC.md)。

- **在线体验**：<https://11wand.com>（**已上线到 v0.2.174**）。首页「免注册，直接体验」直连公用体验账号；⚠️ 公用池全站共享、访客彼此可见，别放个人信息。
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

当前测试基线 **395 文件 / 4518 例**，全绿（4516 passed / 2 skipped；2026-10-09 交互营地入场全量实跑）。逐文件不变量见 [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md) §3；三套离线评测（`npm run eval` / `eval:models` / `eval:agent`）见 [`docs/FEATURES.md`](docs/FEATURES.md#测评怎么证明上面每句话)。
### 为什么有四千条测试——它们不是数字游戏

一个常见的第一印象是「4000 例太多了，多半是凑数」。2026-10-02 我们按**风险驱动测试**的口径把全部用例逐条过了一遍（方法与局限见 [`docs/TEST-AUDIT.md`](docs/TEST-AUDIT.md)，逐例明细 [`docs/test-audit-cases.csv`](docs/test-audit-cases.csv)），每条用例回答三问：**挡住什么失败？别处（tsc / eslint / 门禁 / 其他测试）能不能挡？代价多大？** 结果：

| 档 | 定义 | 例数 | 占比 |
|---|---|---:|---:|
| **必须** | 挡住用户可见 / 数据 / 安全层面的失败，且别处挡不住：supertest 真库集成链、归属与安全边界（403/404、消毒、租户）、事故回归锁、迁移与库形状、错误路径、UI 交互→处理器 | 2975 | 73% |
| **保底** | 挡住真实失败，但影响面小或与「必须」部分重叠：纯函数单点边界、渲染细节、双语完整性、像素资产一致性、公开页形状 | 992 | 24% |
| **建议删除** | 不产生独立判定：常量＝常量、文案逐字相等、营销演示内容的形状、只验「能渲染不炸」 | 71 | 1% |

第三档已全部删除（审计时的基线是 342 个文件、4038 例；并入时 main 已长到 344 / 4085，删掉这 71 例后即上面的现基线），**第二档刻意没按比例砍**：它们每条都对应一个真实失败模式，删掉换来的只是数字好看。

数量大的真正原因是**粒度**，不是冗余：

- **一条用例锁一个失败模式。** 一条 supertest 用例平均只有 1–2 个断言；红了能直接指到哪条口径坏了，而不是「某个 20 断言的大用例挂了，自己去翻」。
- **文件头与用例标题写的是「为什么」。** 标题形如「跨用户访问一律 404 不回 403（403 等于承认 id 存在）」——判断标准本身就是文档，`docs/TEST-PLAN.md` §3 的不变量列是它的索引。
- **门禁反过来守测试。** 每个测试文件必须在台账成行（幽灵行也红）；`node tools/guard-audit.mjs` 会把每条守门逐个改坏、证明它真的会红。
- **三类锁必须多，因为出事成本高**：多租户归属（串台就是泄露）、流式不丢字不重字（断线重连）、AI 内容安全（CSP 沙箱、SVG 消毒、逐字锚点）。

审计也如实记了测试体系自己的问题：台账的行级例数有 22 行与实测漂移（门禁不查数字）；20 个文件适合并成表驱动；一条用例在全量并行下偶发。这些在 `TEST-AUDIT.md` §4 登记，处置方式是改台账与合并，不是删锁。

另有几件不进 `check`、按需跑的仪器：`node tools/loadtest/sse-load.mjs`（单进程 SSE 容量探针，读数在 [`docs/SCALING.md`](docs/SCALING.md)）、`node tools/retention-report.mjs --db …`（只读留存报表，口径在 [`docs/RETENTION-SPEC.md`](docs/RETENTION-SPEC.md)）、`node tools/guard-audit.mjs`（把守门故意改坏，证明它们真的会红）。

## 架构

**单页架构图**（20 秒读法：从上往下＝一次请求的旅程；三条虚线＝三道边界——信任、归属、凭据）：

![架构总览：浏览器 → 信任边界 → App Server → 归属边界 → 域层 → SQLite；右侧凭据边界外是 LLM 上游](docs/images/architecture.svg)

**三包职责**：`@sb/shared` 只放契约与纯函数（前后端共用一份，不允许各写一套）；`@sb/server` 承载全部业务域（Express + better-sqlite3，逐版本迁移 v1..v52）；`@sb/web` 是 React 18 前端，**零第三方运行时依赖**（无 UI 库 / 无 Markdown 库 / 无图表库）。

**一级视图四个**（`App.tsx` 的 `View` 联合）：对话 / 词条（含卡面、卡墙、宝箱与任务）/ 知识大陆 / 设置；卡牌已并入词条页，不再单独占导航；对战是 `#/pk` 独立页，督促是常驻胶囊。★ 新功能**默认不新增一级导航项**。

运行时形态：`api(Express :18791，默认仅绑 127.0.0.1) + web(Vite :5173)`，数据存 SQLite 单文件（WAL）；多用户 Web 形态同一份代码 + 邮箱/密码/GitHub OAuth 鉴权 + 按用户数据归属 + Caddy 反代 + systemd 守护。★ `server/auth/form.ts` 是形态的**唯一事实源**（`SB_REQUIRE_AUTH` 开 = cloud / 关 = local），「本地有、线上没有」的功能一律从这里判断，禁止各自读 env。

目录结构、模块地雷图与代码地图见 [`docs/ENGINEERING.md`](docs/ENGINEERING.md) §4；单进程容量实测、进程内状态清单与扩容阶梯见 [`docs/SCALING.md`](docs/SCALING.md)。

## 安全与隐私

按 ADR-2「安全做必要最小」：

- **Origin 校验**：浏览器业务写操作校验 Origin，**不放行 `'null'`**（sandbox 预览页的源就是字符串 null）；专用 `/api/open/v1` 使用词条权限密钥独立鉴权，CLI 无需 Origin，不能借此访问其他接口。
- **口令与会话**：`crypto.scrypt` 派生且**参数随哈希自描述落库**；库里只存 `SHA-256(sessionToken)` + `HttpOnly` cookie；「邮箱不存在」与「密码错」回同一个错误码
- **验证码**：签发即哈希入库、一次性靠**原子认领**（先查后改会让同一个码用两次）；真正的防线是尝试上限 + 发送侧限流
- **模型产出不裸跑**：```html 走 `CSP: sandbox`（无 allow-same-origin）＋ iframe 双层沙箱，页面源为 `null`；```svg 走**白名单净化器**（HTML 解析 → 元素/属性白名单 → `XMLSerializer` 重排，剥 `<image>` 外链与全部脚本载体，输出幂等），28 例攻击语料 + 确定性模糊测试守着，契约见 [`docs/UNTRUSTED-RENDER-SPEC.md`](docs/UNTRUSTED-RENDER-SPEC.md)
- **密钥不出接口**：搜索 key 与模型 key AES-GCM 密文入库，响应只回布尔；搜索 / 抓取出网走 **SSRF 护栏 + 白名单**，抓页单页不遍历
- **外部 agent 存词**：设置页生成专用密钥，仅允许读取本人词库和批量新增；明文仅创建时返回一次。规范与批次/去重/来源语义见 [`AGENT-TERMS-SPEC.md`](docs/AGENT-TERMS-SPEC.md)。桌面导出 JSON 可用 `node tools/import-agent-terms.mjs --file terms.json` 导入（私有环境变量 `STUDENTBUDDY_TERMS_TOKEN`），先加 `--dry-run` 查看批次规模。
- **归属过滤按读形状分两把锁**：读「一批行」用 `ownerFilter`，读「一个值/聚合」用 `ownerForWrite`；跨用户访问一律 **404 不回 403**（403 等于承认「这个 id 存在」）
- **资料阅读页不是开放代理**：`GET /api/sources/{view,pdf}` 只服务**本会话资料架上的网址**（授权 = 会话可访问 **且** 网址在该会话的在线注册表或 `message_source` 表里），否则 403；抓取一律走同一套 SSRF 逐跳复检。阅读页零脚本——CSP `default-src 'none'` + 白名单清洗双保险，`sandbox` 不给 `allow-same-origin`，图片 `no-referrer`；PDF 转发校前 5 字节魔数、上限 25 MB。截图保底 `/shot` 同一套许可，且截图浏览器的**每一个**出站连接（含重定向、子资源、回环）都经本机守门代理按同一套内网规则放行、按解析出的 IP 钉住连；并发 2 / 排队 4 / 20 秒 / 8 MB 封顶

## 已知限制

> 这一节的立场：**先说自己哪里不行。** 完整的缺陷 / 定档边界清单在 [`docs/metrics-product.md`](docs/metrics-product.md)。

- **可用性目前算不出来**：看门狗只在异常时落笔 ⇒ 没有分母，只能给「发生过几次 DOWN」。
- **线上量级是个位数，留存刚开始可测**：2026-09-24 只读审计 users 6 / sessions 47。此前连「谁在哪天来过」都没记录 ⇒ 留存算不出；2026-09-30 起 v52 按日活跃心跳 + `tools/retention-report.mjs` 把它变成可测的，但**数据从上线日起才有**，心跳满 4 周且纳入用户 ≥30 之前不发布任何留存百分比（[`docs/RETENTION-SPEC.md`](docs/RETENTION-SPEC.md) §5）。「已上线」不等于「有留存」，这一条本文不替自己圆。
- **单进程部署**：上游并发闸门、SSE 订阅、PK 房间都是进程内状态；本机实测 100 并发流式生成零失败，真正先到顶的是免费通道 `SB_UPSTREAM_SITE_MAX_CONCURRENT=8` 的配额策略；多实例的前提与阶梯见 [`docs/SCALING.md`](docs/SCALING.md)。
- **容器化：本机已跑通，线上确定不切**（2026-09-29 决策，理由与前置清单见 [`DEPLOY.md`](DEPLOY.md) §11）。
- **文档模式是词法检索，不是语义检索**：没有 embedding；用户不用资料里的原词改写提问时，70 万字规模下召回约 62%。
- **渲染层覆盖不完整**：jsdom 交互测试只覆盖最高频几页；布局与观感类症状只能靠真机探针 + 人工目检。
- **行内公式不渲染**（`$… 按原文显示）、`mermaid` / `echarts` 围栏降级代码块——刻意不引库以保住 `@sb/web` 零第三方依赖。
- **预览页只活内存**：服务重启即失效、无分享链接。
- **中英切换只到壳层**：功能页正文与服务端消息尚未双语。
- **引路灯的 AI 推荐花模型额度**：只在点开 / 悬停 0.4 秒 / 聚焦时才请求、同一现场缓存 10 分钟，亮灯本身不调模型；它只在应用壳里（落地页与对战页没有），窄屏与知识大陆页要在主区左侧让出 56px 的灯笼轨。
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
| [`GUIDE-SPEC.md`](docs/GUIDE-SPEC.md) | 下一步引导（引路灯）契约（13 种动作白名单 / 六个阶段与三个必备时刻 / AI 现挑 + 规则兜底 / 能力注册 / 三档位置与三档主动程度） |
| [`SOURCE-TRACE-SPEC.md`](docs/SOURCE-TRACE-SPEC.md) | 资料溯源契约（资料架编号即身份 / 阅读页零脚本与授权 / `pick_sources` / `[n]` 引用芯片 / 落库与历史重开 / 与刷词小窗共存 / 视频线路 B站就地播·抖音跳转 / 截图保底与守门代理） |
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
