# StudentBuddy Interview Guide

> 版本：v1.0（2026-09-24）| 状态：[活跃] | 面向：第一次打开这个仓库的人（面试官 / 评审 / 未来的自己）
>
> 这份文档不是工程规格，是一张**导览图**：它假设你只有 5–15 分钟，告诉你按什么顺序看、
> 每个论断去哪一行代码/哪一条测试验证、以及这个项目**真实**的取舍与局限。
> 所有数字不手抄：以 README 徽章与 [`docs/metrics.md`](metrics.md)（`tools/metrics.mjs` 产出）为准。
>
> ⚠️ 一句话声明：本文档不为面试编造任何"标准答案"。每个 trade-off 写的是**当时真实选了什么、
> 为什么、代价是什么、什么时候会换**。

---

## 1 · 90 秒项目陈述（可直接拿去讲）

> StudentBuddy 是一个**已经上线运行**的 AI 学习产品，不是演示壳。
> 核心闭环是「学 → 练 → 析 → 忆 → 反馈」：流式对话学习、自建出题引擎自动判分、
> 逐题统计薄弱点、AI 词条库 + 艾宾浩斯复习 + 跨会话记忆、事件总线驱动的学习反馈。
>
> 技术上它是 React 18 + Express + SQLite 的 TypeScript monorepo（shared/server/web 三包），
> 同一份代码以两种形态运行：本地单机（数据不出机器）和多用户 Web 服务（已部署在
> <https://11wand.com>，真实用户在注册和使用）。
>
> 它和"ChatGPT wrapper"的区别在于把 LLM 当成**不可靠的分布式依赖**来做工程：
> 结构化输出协议 + 五级解析阶梯 + JSON 修复降级、SSE 帧序号/回放/去重/快照对齐、
> 多用户数据归属的负向测试锁、以及给 AI 生成内容准备的 CSP 沙箱与 SVG 净化。
> 每一条对策都对应 bug 台账里一次真实故障（`docs/dev/bug-ledger.md`）。
>
> 质量面：2800+ 个自动化用例进 CI、机器强制的行数/样式/any 门禁、
> 15 个真实浏览器 CDP 探针、一条命令可复跑的**零凭证全栈 E2E**（`npm run demo:e2e`）。

三个记忆锚点（面试官只记得住三件事）：
1. **已上线**：有域名、有 TLS、有备份回滚演练、有真实注册和对话数据。
2. **不可靠依赖的可靠化**：LLM 与 SSE 两条链路都有"改坏了测试必红"的回归锁。
3. **可验证的诚实**：文档里每个数字是脚本产出的；没做的、被否掉的方案都写在台账里。

---

## 2 · 5 分钟架构导览（按这个顺序看）

```
浏览器 (React 18, 零第三方 UI 依赖)
   │  REST + SSE（同源 cookie 会话）
   ▼
Express API  packages/server/src/index.ts          ← 中间件链在这里：安全头 → CORS → body limit → originCheck → 软鉴权 → 强制鉴权开关
   │
   ├─ 路由层    packages/server/src/routes/*.ts      ← 薄路由：校验 + 归属断言 + 错误映射
   ├─ 编排层    packages/server/src/chat/flow.ts     ← 一轮对话的完整编排（上下文预算/工具循环/流式收口）
   ├─ 领域层    packages/server/src/{learning,coach,flow,pk,search,auth}/
   ├─ LLM 层    packages/server/src/llm/             ← openai/anthropic 双适配 + 角色路由 + 并发闸门 + 超时
   ├─ 流式总线  packages/server/src/chat/sse-bus.ts  ← seq 单调 / 回放 / 去重 / TTL 回收
   ▼
契约层        packages/shared/src/                  ← SSE 事件、内容块、REST 类型、领域模型（前后端同一份）
   ▼
持久化        packages/server/src/storage/           ← better-sqlite3 WAL + 逐版本迁移（v1..v4x，append-only 分片）
外部世界      llm 上游 / Resend 发信 / GitHub OAuth / 三路联网搜索（都可在设置页换或不用）
```

对应阅读顺序与跳转点：

| 步 | 看什么 | 打开 |
|---|---|---|
| 1 | 请求进入的第一道门（安全中间件全在这 100 行内） | [`server/src/index.ts`](../packages/server/src/index.ts) |
| 2 | 前后端"同一事实只写一遍"的契约面 | [`shared/src/sse-events.ts`](../packages/shared/src/sse-events.ts) · [`shared/src/content-blocks.ts`](../packages/shared/src/content-blocks.ts) · [`shared/src/domain.ts`](../packages/shared/src/domain.ts) |
| 3 | 一轮 AI 回复怎么从 HTTP 变成 SSE 帧再变成库里的行 | [`server/src/chat/flow.ts`](../packages/server/src/chat/flow.ts) + [`server/src/chat/sse-bus.ts`](../packages/server/src/chat/sse-bus.ts) |
| 4 | LLM 被当成不可靠依赖的那一层 | [`server/src/llm/router.ts`](../packages/server/src/llm/router.ts) · [`upstream-gate.ts`](../packages/server/src/llm/upstream-gate.ts) · [`upstream-timeout.ts`](../packages/server/src/llm/upstream-timeout.ts) |
| 5 | 出题引擎的协议解析阶梯 | [`server/src/learning/quiz.ts`](../packages/server/src/learning/quiz.ts)（`QUIZ_PROTOCOL` + 五级阶梯注释） |
| 6 | 多用户归属的两把过滤器 | [`server/src/auth/ownership.ts`](../packages/server/src/auth/ownership.ts) · [`docs/TENANCY-SPEC.md`](TENANCY-SPEC.md) |
| 7 | 安全面（Origin 校验不放行 `'null'` 的理由在注释里） | [`server/src/security.ts`](../packages/server/src/security.ts) · [`server/src/routes/preview.ts`](../packages/server/src/routes/preview.ts) · [`web/src/lib/svg-utils.ts`](../packages/web/src/lib/svg-utils.ts) |
| 8 | 39→4x 次数据库迁移怎么保持可重放 | [`server/src/storage/migrations.ts`](../packages/server/src/storage/migrations.ts)（执行器只有 29 行） |

---

## 3 · 三个最难的工程问题（Problem → Design → Implementation → Test → Trade-off）

### A. LLM 不是可靠的 JSON API（输出可靠性）

- **Problem**：出题要求模型按 `[QUIZ]{...}[/QUIZ]` 输出结构化题组。真实上游会：漏闭合括号、
  把 JSON 裹进围栏、输出非法转义、画一半的 SVG 几何图、或者干脆少答题量。任何一处硬解析
  都会让"整组题"陪葬。
- **Design**：三条原则——①**降级不崩**（ADR-4）：解析走五级阶梯（无损补括号 → 原样 parse →
  剥图重试 → 截断逐题回退 → 回退后再剥图），每级都是纯增益（合法 JSON 上永不触发修复分支）；
  ②**坏不连坐**：单题配图非法只删该题 `svg` 字段，题目照常交付（"残缺的几何图比没图更糟，
  会教错学生"）；③**不静默**（ADR-5）：`QuizImageReport{on,delivered,droppedSvg,truncated}`
  四态贯穿 server→路由→前端，缺几题说几题，绝不拿"开关已开"冒充"图已交付"。
- **Implementation**：[`learning/quiz.ts`](../packages/server/src/learning/quiz.ts)（协议 + 阶梯 + 校验归一）、
  [`learning/quiz-json-repair.ts`](../packages/server/src/learning)（无损修复）、
  [`server/src/llm/`](../packages/server/src/llm)（上游超时/并发闸门/失败隔离）。
- **Test**：阶梯每一级都有单测（`learning/quiz*.test.ts` 族）；配比"要 N 出 M 报 M"有路由级断言；
  全链路有 [`tools/e2e/demo-e2e.mjs`](../tools/e2e/demo-e2e.mjs) 第 6-7 步（假上游出协议 → 解析 →
  落库 → 判分 → 统计 3 对 1 错可读出）。真实故障根因逐条登记在
  [`dev/bug-ledger.md`](dev/bug-ledger.md)（B-001 多条 system 静默丢失等）。
- **Trade-off**：没有引入 JSON-schema 强约束解码或 function-calling 出题——兼容协议的中转
  服务商不支持，且协议文本本身进了内容块契约（`[QUIZ]` 围栏前后端共用）。代价：解析阶梯必须
  自己写；收益：**任何一家 OpenAI 兼容上游都能出题**。

### B. SSE 不是"把 token 转发出去"那么回事（流式可靠性）

- **Problem**：浏览器会断线、会切会话、会重连；上游会卡死不回。朴素转发会出三类事故：
  帧乱序/丢帧（屏上文本与库内文本不一致）、重连后**同一轮全量回放 → 答案双份上屏**、
  上游挂起 → **会话永久卡在"生成中"**（真实故障 B-005）。
- **Design**：①服务端每会话一条缓冲（`Map<channel, SessionBuffer>`），帧序号**按轮**从 1 单调；
  三类频道（chat=sessionId / PK=`pk:` 前缀 / 教练=`coach:` 前缀）前缀隔离防串台；
  ②重连语义：回放只为"进行中的一轮"服务，**已完结轮只补一个 `done`**（正文由 `/messages`
  权威提供）；③陈旧 `since` 归零（B-007 修复：seq 按轮重计，客户端跨轮保留的计数比本轮最大值
  还大时，一条都收不到）；④前端 `acceptSeq(since, seq)` 纯函数收口接收规则；⑤15s 心跳 +
  缓冲 TTL 回收 + `/live` 快照对齐。
- **Implementation**：[`chat/sse-bus.ts`](../packages/server/src/chat/sse-bus.ts)（约 200 行，注释含每处
  事故编号）、[`web/src/lib/sse-seq.ts`](../packages/web/src/lib/sse-seq.ts)（客户端规则唯一实现）、
  [`web/src/features/chat/useChatStream.ts`](../packages/web/src/features/chat/useChatStream.ts)。
- **Test**：`chat/sse-bus.test.ts` + `sse-seq.test.ts` 各 8 例**两侧同锁**（改协议必改两处，
  B-007 的教训就是只改一侧）；真实 HTTP 帧流 + seq 单调 + 断线重连只回放 done，由
  `npm run demo:e2e` 第 3-4 步端到端复验。
- **Trade-off**：选 SSE 不选 WebSocket——单向流足够、走原生 HTTP（同源 cookie/CORS/反代栈全部
  复用，Caddy 零特殊配置）、自动重连是浏览器内建的。代价：没有客户端双向通道，"停止生成"要
  另开一个 POST `/api/chat/abort`（现状就这么做的，可接受）。

### C. 多用户隔离不能靠"记得加 WHERE"（归属正确性）

- **Problem**：v2 从单机形态长出多用户。全库几十张表，漏一张 = 跨用户数据泄漏；
  而且泄漏往往**静默**（查询只是多返回了几行，没人看得见）。
- **Design**：①**读按形状分两把过滤器**——读"一批行"用 `ownerFilter`（拼 SQL 条件），
  读"单个值/聚合"用 `ownerForWrite`（先取行再断言）；豁免过滤时前者多返回行、后者返回
  **任意一行**（静默串台），所以两把不能合并；②跨用户一律 **404 不回 403**（403 等于承认
  "这个 id 存在"）；③子表不重复挂归属列——`messages` 的归属由**父会话断言**（表随父表原则）；
  ④"没有主人"有两种刻意相反的可见性：`providers.owner_id IS NULL` = 平台通道人人可用，
  业务表 `owner_id = ''` = 无主谁都看不见；⑤成本归属（M2c）：用户自带 key 与平台免费通道
  分账 + 两层并发闸门（每用户 2 路 / 全站封顶 N）。
- **Implementation**：[`auth/ownership.ts`](../packages/server/src/auth/ownership.ts) +
  迁移分片 `storage/migrations-list-v22/v24/v25/v30/v31...`（逐表加列史）+
  [`llm/upstream-gate.ts`](../packages/server/src/llm/upstream-gate.ts)。
- **Test**：**每一批归属改造都配一条"故意改坏必红"的负向锁**——用户 B 读写 A 的资源必须 404，
  各表族各有 `*-tenancy.test.ts` / `tenancy.test.ts`；`demo:e2e` 第 5/8 步把两条负锁搬上了
  真实 HTTP。逐条登记在 [`test-plan.md`](dev/test-plan.md) §7 与 [`TENANCY-SPEC.md`](TENANCY-SPEC.md) §8。
- **Trade-off / 已知未完成**：`ownerFilter(null)`（未登录）返回空条件 = 看全部——这在本地
  单人形态是对的，但隔离只在带 cookie 时真实成立，强制鉴权靠部署 env `SB_REQUIRE_AUTH` 兜底，
  这是**部署配置正确性**而非纯代码正确性（五条部署闸门的判据见 README §部署形态）。
  会话是唯一的锚：新表必须先回答"随父表还是自挂归属"，这条纪律在 TENANCY-SPEC 里。

### D.（加分项）AI 生成内容不是可信内容（安全）

模型产出的 ```html 页和 ```svg 图会在用户浏览器里**运行/内联**——它们是 XSS/信标/SSRF 的载体。
对策三层：预览页响应带 `CSP: sandbox`（无 `allow-same-origin`，页面源 = `null`）+ iframe 再叠
一层 sandbox；`originCheck` **刻意不放行字符串 `'null'` Origin**（否则模型写的页面能调写接口）；
SVG 净化剥 script/foreignObject/外链 `<image>`（防信标泄 IP），html 内容含 SSRF 护栏的抓取面。
实现与测试：[`security.ts`](../packages/server/src/security.ts)、
[`routes/preview.ts`](../packages/server/src/routes/preview.ts)、
[`web/src/lib/svg-utils.ts`](../packages/web/src/lib/svg-utils.ts)（+对应 test），
真机侧有沙箱页调写接口被拒的实测记录（README §核心优势"模型产出敢真跑"行）。

---

## 4 · 重要取舍（真实方案 · 原因 · 局限）

不给标准答案，只给"当时为什么这么选、什么时候这个选择会作废"。

| 问题 | 当前选择 | 为什么 | 局限 / 什么时候换 |
|---|---|---|---|
| 为什么 SQLite？ | better-sqlite3 单文件 + WAL | 本地优先产品 90% 场景是单机；进程内嵌入零运维；事务完整；VPS 1GB 内存起不起独立 DB 服务是笔真账 | 多实例水平扩展时作废（归属与并发闸门都是单进程语义）。迁移史 v1..v4x 全部 append-only，换 PG 的路径 = 洗一次库，但没需求就不预支抽象 |
| 为什么 SSE 不用 WebSocket？ | SSE + 独立的 POST abort | 单向推流占全部需求；同源 cookie/CORS/反代/鉴权栈零改动；断线重连浏览器内建 | 需要双向实时（如 PK 房间内高频同步体验）时换；现状 PK 也是"REST 写 + SSE 推"，够用 |
| 为什么 BM25/FTS5 不上向量库？ | 词法 BM25 切块检索（长文档）+ SQLite FTS5 全站搜索 | 零依赖、可解释（段号可溯源）、数据不出机器；实测 70 万字语料覆盖 13/13，注入量 60k→10.5k 字 | **不用原词改写提问**时召回掉到 ~62%——词法路线的性质。突破点在契约里已预留：真有需求时叠加向量路线，不是替换 |
| 为什么 local-first？ | 同一份代码两种形态，`SB_REQUIRE_AUTH` 一个开关（形态判定唯一事实源 `auth/form.ts`） | 学习数据是敏感数据，单机是信任基线；"本地有、线上没有"的功能分叉被禁止各自读 env | 云形态的隔离/配额/计费复杂度全部由此而来（§3C 那一整章就是代价） |
| 为什么 shared contract 包？ | `@sb/shared` 放 SSE 事件/内容块/REST 类型/领域模型，先登记再实现 | 前后端各写一份 = 迟早漂移（实测多次）；契约文件头注释即纪律 | 契约膨胀风险：shared 已 150 类型，靠"纯函数 + 常量唯一事实源"约束它不变成第二个后端 |
| 为什么需要 owner isolation 的负向测试？ | 每批归属改造配"故意改坏必红"的跨用户 404 锁 | 正向测试证明不了"没别人能看进来"；泄漏是静默的，只有负向断言能锁住 | 覆盖 = 已登记的测试文件 × 表族，新表忘挂锁的红线靠 gates"测试必先登记"制度兜 |
| 为什么需要 LLM fallback/闸门？ | 双协议适配（OpenAI 兼容 + Anthropic）+ 两层并发闸门 + 空闲/总时长双超时 | 上游 429/挂起都真实发生过（B-005 上游并发=1 挂起 → 会话永久卡住）；免费平台通道必须有全站封顶 | 闸门是**进程内 Map**：多实例部署时"全站封顶 N"变成"每实例 N"，这是已知边界（README §已知限制原文承认） |
| 为什么 AI 生成的 HTML 要 sandbox？ | `CSP: sandbox` + iframe 双层 + null Origin 拒调写接口 | 模型产出 = 不可信输入，"页面只能看不能碰数据"是唯一合理默认 | 代价：预览页只活内存、无分享链接、无地址栏——定档边界写进了已知限制，不是没做 |
| 为什么单实例 + ssh 直传而不是 K8s/Docker？ | 1GB VPS、单人运维、`tar|ssh` + systemd + Caddy 自动 TLS | 部署路径的每一条都有实测症状与回滚演练；容器化在仓里**明标 EXPERIMENTAL、从未实机跑通**（诚实声明而非缺漏） | 流量真涨到需要多实例时，先解的是归属/闸门的跨进程语义（TENANCY-SPEC 有账），不是先堆编排 |
| 为什么零第三方前端库？ | Markdown/高亮/图表/SVG 净化全部自写 | 供应链攻击面与包体积趋零；AI 内容渲染器的行为必须完全可控（净化器引三方库 = 把安全边界外包） | 代价真实存在：行内公式不渲染、mermaid 降级代码块——都写在已知限制 |

---

## 5 · 代码地图（"想看 X，打开这里"）

| 你想看 | 打开 | 顺路看 |
|---|---|---|
| SSE 帧序与断线恢复 | [`server/src/chat/sse-bus.ts`](../packages/server/src/chat/sse-bus.ts) | [`web/src/lib/sse-seq.ts`](../packages/web/src/lib/sse-seq.ts) + 两侧各 8 例回归锁 |
| 一轮对话的完整编排 | [`server/src/chat/flow.ts`](../packages/server/src/chat/flow.ts) | 上下文段清单 [`chat/context-segments.ts`](../packages/server/src/chat/context-segments.ts)、压缩 [`chat/compact.ts`](../packages/server/src/chat/compact.ts) |
| quiz 可靠性（五级阶梯） | [`server/src/learning/quiz.ts`](../packages/server/src/learning/quiz.ts) | 路由侧四态报告 [`routes/quiz.ts`](../packages/server/src/routes/quiz.ts)、`QuizImageReport` 贯穿链 |
| LLM 供应商抽象与并发闸门 | [`server/src/llm/router.ts`](../packages/server/src/llm/router.ts) | [`openai.ts`](../packages/server/src/llm/openai.ts) / [`anthropic.ts`](../packages/server/src/llm/anthropic.ts) / [`upstream-gate.ts`](../packages/server/src/llm/upstream-gate.ts) / [`upstream-timeout.ts`](../packages/server/src/llm/upstream-timeout.ts) |
| auth / 归属隔离 | [`server/src/auth/ownership.ts`](../packages/server/src/auth/ownership.ts) | 契约 [`TENANCY-SPEC.md`](TENANCY-SPEC.md) §4-§5 + `routes/tenancy.test.ts` |
| 会话 token 只存哈希 / scrypt 自描述 | [`server/src/auth/session.ts`](../packages/server/src/auth/session.ts) · [`auth/password.ts`](../packages/server/src/auth/password.ts) | 验证码原子认领 [`auth/codes.ts`](../packages/server/src/auth/codes.ts) |
| 安全头 / Origin 校验 / SSRF 护栏 | [`server/src/security.ts`](../packages/server/src/security.ts) | 抓页护栏 [`search/`](../packages/server/src/search) + [`IMAGE-FETCH-SPEC.md`](IMAGE-FETCH-SPEC.md) |
| AI 内容消毒（SVG/HTML） | [`web/src/lib/svg-utils.ts`](../packages/web/src/lib/svg-utils.ts) | 预览沙箱 [`routes/preview.ts`](../packages/server/src/routes/preview.ts) |
| 文档检索 BM25 | [`shared/src/doc-rag.ts`](../packages/shared/src/doc-rag.ts)（常量唯一事实源） | [`DOC-RAG-SPEC.md`](DOC-RAG-SPEC.md)（含被实测否掉的两条阈值方案） |
| 数据库迁移（40+ 版本可重放） | [`server/src/storage/migrations.ts`](../packages/server/src/storage/migrations.ts) | 分片 `migrations-list-v*.ts` + 每片的幂等重放测试 |
| 工程门禁本身 | [`tools/gates/check.mjs`](../tools/gates/check.mjs)（行数/禁 any/禁内联样式/测试登记） | [`tools/guard-audit.mjs`](../tools/guard-audit.mjs)——**把每条守门逐个改坏证明它真的会红** |
| 量化数字的产出器 | [`tools/metrics.mjs`](../tools/metrics.mjs) | `--check` 是 CI 第 6 步：README 数字手抄即红 |
| 一条命令看全栈 | `npm run demo:e2e` → [`tools/e2e/demo-e2e.mjs`](../tools/e2e/demo-e2e.mjs) | 36 项断言：SSE 帧序/逐字一致/回放语义/跨用户 404/出题判分/重启存活 |

---

## 6 · 验证路径（面试官真的动手时）

1. **30 秒**：打开 <https://11wand.com>，点「免注册，直接体验」。
2. **2 分钟**：`npm install && npm run demo:e2e`——零 key、零配置、约 3 秒，
   看 36 条断言逐条打 `[ok]`（输出即本文 §3 三个问题的可执行版）。
3. **5 分钟**：`npm run check`（lint×3 + 2800 例 + 门禁）；
   `node tools/metrics.mjs --check` 看"文档数字不许手抄"如何被执行。
4. **10 分钟**：挑 §5 地图里两个主题各读一个实现文件 + 对应 `.test.ts`；
   有兴趣再看 [`tools/probes/`](../tools/probes) 里任一 CDP 探针的断言列表。

## 7 · 诚实边界（被问到"这项目哪里不行"时的真话）

- 单人项目：无外部贡献者、无 code review 对手，纪律靠门禁与台账自证。
- 产品冷启动期：真实用户量个位数→两位数，GitHub stars 与 clone 数不成比例——
  增长台账 [`GROWTH-CHANNELS.md`](GROWTH-CHANNELS.md) 记录了每一条做过与没做成的尝试。
- 已知技术债有账：`SB_REQUIRE_AUTH` 关闭时隔离退化为全局可见（本地形态的语义）、
  并发闸门仅单进程成立、深度理解功能契约"待评审"未接线——README §已知限制逐条在列。
- Docker 路径是草案不是能力（文件头 EXPERIMENTAL 声明）。
