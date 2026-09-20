# studentbuddy v2

[![CI](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/llwand1/studentbuddy-v2/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522.11-blue)
![version](https://img.shields.io/badge/version-2.0.0--alpha.0-orange)
![tests](https://img.shields.io/badge/tests-157%20files%20%2F%202166%20cases-brightgreen)
![api](https://img.shields.io/badge/REST%20routes-139-0ea5e9)
![contracts](https://img.shields.io/badge/shared%20contracts-136%20types-8a63f6)
![deps](https://img.shields.io/badge/external%20runtime%20deps-6-blue)
![stack](https://img.shields.io/badge/stack-React%2018%20%C2%B7%20Express%20%C2%B7%20SQLite-8a63f6)

### 🚀 在线体验 · **[11wand.com](https://11wand.com)** —— 免安装，邮箱注册即用

> **studentbuddy —— 你的专属学习助手。** 本地优先的 AI 学习产品：**学 → 练 → 析 → 忆 → 反馈** 五环闭环，同一套代码既可**单机本地运行**，也可作为**多用户 Web 服务**部署。
>
> v2 是全新重写仓（v1 [`llwand1/studentbuddy`](https://github.com/llwand1/studentbuddy) 已冻结），按「需求为纲、简洁优先」六条 ADR 从零建成。
>
> ✅ **已上线**（`2.0.0-alpha.0`）：多用户 Web 形态运行于 **<https://11wand.com>**（2026-09-19 起）——上线阶梯 12 批全部交付、部署闸门全部清空；部署与运维清单见根目录 [《部署手册》](DEPLOY.md)，[§当前状态](#当前状态) 与 [§已知限制](#已知限制) 照常如实维护。
>
> 📌 本文所有定量数字为**快照**，取数口径与日期逐条标注；**权威口径**在 `docs/dev/test-plan.md` §3（测试基线）与 `docs/dev/launch-plan.md` §2（上线阶梯），冲突时以那两份为准。

## 目录

- [这是什么](#这是什么)
- [当前状态](#当前状态)
- [核心优势](#核心优势)
- [功能总览](#功能总览)
- [内容块协议](#内容块协议)
- [架构](#架构)
- [安全与隐私设计](#安全与隐私设计)
- [部署形态](#部署形态)
- [快速开始](#快速开始)
- [仓库结构](#仓库结构)
- [开发指南](#开发指南)
- [配置说明](#配置说明)
- [v1 数据迁移](#v1-数据迁移)
- [里程碑](#里程碑)
- [已知限制](#已知限制)
- [文档索引](#文档索引)

## 这是什么

studentbuddy 把「学习」做成一条可自动运转的闭环，而不是一个套了学习提示词的聊天框：

- **学** —— 流式对话 + 思考链 + 联网检索 + 文档模式（长文档 BM25 检索）
- **练** —— 自建出题引擎：结构化协议、自动判分、题型配比可配、AI 特化 SVG 配图
- **析** —— 逐题正确率、薄弱点定位、学习趋势
- **忆** —— AI 自学词条库 + 艾宾浩斯复习时钟 + 跨会话长期记忆
- **反馈** —— 事件总线驱动 XP / 连签 / 今日总结，外加 AI 主动督促

它同时管住了「模型不听话」这一整类工程问题：解析阶梯、丢图保题、流式超时、上游并发闸门、契约漂移回归锁——每条对策都对应一次真实故障的根因登记。

两种运行形态共用同一份代码（差异只在环境变量）：

| 形态 | 说明 | 状态 |
|------|------|------|
| **本地单机** | `api(Express :18791，默认仅绑 127.0.0.1) + web(Vite :5173)`，数据存 SQLite 单文件（WAL） | ✅ 已交付，日常开发形态 |
| **多用户 Web 服务** | 邮箱注册/登录（密码 + 邮件验证码 + GitHub OAuth）+ 按用户的数据归属 + 用量闸门，Caddy 反代 + systemd 守护 | ✅ **已上线**：<https://11wand.com>（2026-09-19 起） |

两种形态**共用同一份代码**，差异只在环境变量——且这条差异本身是**显式契约**：`server/auth/form.ts` 是形态的唯一事实源（`SB_REQUIRE_AUTH` 开 = cloud 线上多用户 / 关 = local 本地单人），前端据此分叉（local **免登录直进应用壳**，cloud 走落地页）。**将来「本地有、线上没有」的功能一律从这里判断，禁止再各自读 env。**

## 当前状态

> 本节是 [`docs/dev/launch-plan.md`](docs/dev/launch-plan.md) §2 的摘要，取数于提交 `5383a83`（2026-09-20）。**逐批证据、判据与「不改会怎样」的清单只在那份台账里。**

| 上线批次 | 内容 | 状态 |
|---|---|---|
| M1 | 邮箱 + 密码账号体系（`users` / `auth_sessions`，迁移 v21） | ✅ 已交付 |
| M1.5 | 邮箱验证码登录（`auth_codes` v27 + Resend 发信 + 五道限流） | ✅ 已交付 |
| M1.6 | 注册即验证 + 限流三桶作用域拆分 | ✅ 已交付 |
| M2a | 会话归属隔离（`sessions.user_id` v22 + SSE 隔离） | ✅ 已交付 |
| M2b | 长期记忆画像归主（`user_memory` 重建，v24） | ✅ 已交付 |
| M2c | 模型成本归属（`providers` / `role_bindings` 加 `owner_id`，v29）+ 两层并发闸门 | ✅ 已交付 |
| M2d-1 | 设置与反馈环归主（`app_settings` / `daily_activity` / `daily_summaries` / `user_stats`，v30） | ✅ 已交付 |
| M2d-2 | 词条库与领域归主（`term_library` / `term_domain` 重建 + `term_mention_log` 口径对齐，v31） | ✅ 已交付 |
| M2d-3 | 其余表加归属列：`quiz_*` / `flow_*` / `knowledge_*`（迁移 v33，八处加列） | ✅ 已交付（★ 同批收口 `knowledge_node`/`knowledge_edge` 的旧洞） |
| **M2 收口** | §3.1 五条代码闸门（`SB_TRUST_PROXY` / `SB_ALLOWED_ORIGINS` / `SB_HOST` / `SB_COOKIE_SECURE` / `SB_REQUIRE_AUTH`）落码 + 生产 env 组合强开过测 | ✅ 已交付 ⇒ **代码面完成** |
| **M3 部署上线** | Caddy + systemd + 五条部署 env + 域名 TLS + 发信 DNS | ✅ **已上线 2026-09-19**：`https://11wand.com`（RackNerd 1GB VPS · Caddy 反代 + 自动 TLS · systemd 守护 · GoatCounter 隐私友好统计 · 每日备份异地化 + 看门狗）。部署与运维清单见根目录 [《部署手册》](DEPLOY.md) |

★ 注意**两套编号不是一回事**：`M1/M1.5/M2a~d/M3` 是**上线阶梯**（本节），`M0~M6` 是**产品功能里程碑**（见 [§里程碑](#里程碑)）。功能里程碑不决定能不能上线。

## 核心优势

差别不在于有没有接大模型，而在于**闭环完整度、AI 输出可靠性、工程质量**三层是否同时做实。每条都给出可当场复验的证据。

| 优势 | 强在哪 | 可当场复验的证据 |
|------|--------|------------------|
| **学习域特化，不是模型传声筒** | 练是一台自建出题引擎：`[QUIZ]` 结构化自动判分、四题型配比可配、模型特化 SVG 配图（真机生产口径 5/6 组出图）、五级解析阶梯；忆是一个自学词条库：加权相关性注入 + 对话自动沉淀 + AI 整理 + 复习时钟 | 已落地项各有测试基线与真机统计（`CHANGELOG.md` 09-04 出题两批 / 09-01·09-04 词条库批）；未落地项在对应小节标题即标状态 |
| **AI 输出可靠性工程** | 模型不听话不塌系统：出题五级解析阶梯（补括号 → 剥图重试 → 截断逐题回退）、丢图保题、非法转义修复、SSE 屏上文本与库内文本逐字一致；**上游挂起不再让会话永久卡住**——流式空闲超时 120s / 一次性总时长 180s，超时抛可读错误；**并发闸门两层：每用户 2 路 + 全站封顶 N（占位 8）**（两路对话可并行，主链优先、后台让路，超额明确拒绝而非无限排队） | 每个对策都对应一次真实故障的根因登记与回归锁（[`docs/dev/bug-ledger.md`](docs/dev/bug-ledger.md) + CHANGELOG 09-04、09-17 两批） |
| **模型产出敢真跑** | ```html 围栏产出的网页在 `CSP: sandbox` + iframe 双层沙箱里运行，页面源为 `null`；SVG 净化剥 `<image>` 外链（防外链信标泄露 IP） | 真机实测沙箱页调写接口 / 读数据全被拒；净化有 `web/lib/svg-utils.test.ts` 锁 |
| **前端零第三方库** | 无 UI 库 · 无 Markdown 库 · 无图表库：Markdown 解析、代码高亮、数据图自绘 SVG、SVG 净化自愈全部自写——供应链攻击面与包体积同时趋零、行为完全可控 | `packages/web/package.json` 运行时依赖只有 `react` / `react-dom` / `@sb/shared` |
| **测试 + 机器强制门禁** | `npm run check` = tsc×3 + eslint + vitest + gates：单文件行数红线（server ≤400 / web ≤300）、禁 `any`、禁内联样式全部由脚本拦截，不靠自觉；交互层是**两层互补**——**10 个 `.test.tsx`**（jsdom 按文件 pragma 启用，锁交互逻辑）＋ **11 个真机探针脚本**（`tools/probes/*.mjs`，其中 8 个走 CDP 真点真渲染，锁 CSS 与真实浏览器行为） | 基线 **157 文件 / 2166 例（2165 passed + 1 skipped）**，Node 22 全量 vitest 实测；**逐文件不变量见 [`docs/dev/test-plan.md`](docs/dev/test-plan.md) §3**（本格数字仅为快照，勿据此判现状） |
| **契约先行的可维护性** | `@sb/shared` 是 SSE 事件 / 内容块 / REST / 领域模型的单一事实源，前后端不允许各写一套；先登记再实现 | shared 契约文件头注释即纪律；四条固定扩展模式见 [§开发指南](#开发指南) |
| **不锁定供应商** | OpenAI 兼容 + Anthropic 双适配；搜索三家按 key 并行聚合 + 免 key 兜底——换模型、换服务商只动设置页 | 适配器有出站请求体断言测试，且当场逮出过真缺陷 B-001（多条 system 在 Anthropic 型上静默丢失） |
| **多用户归属做得彻底** | 归属不是加个 `WHERE`：`providers.owner_id IS NULL` ＝平台通道（人人可用）、业务表 `owner_id = ''` ＝无主（谁都看不见），两种「没有主人」可见性刻意相反；读写按形状分别走 `ownerFilter` / `ownerForWrite` | 每批都配跨用户隔离锁 + 「故意改坏必红」的非空转取证（[`TENANCY-SPEC.md`](docs/TENANCY-SPEC.md) §8 + test-plan §7） |

> 一条隐性优势是**诚实的文档文化**：CHANGELOG 每批都有「未验（诚实记账）」段、推断不进验证列，[§已知限制](#已知限制) 明写哪些是缺陷、哪些是定档边界。

## 功能总览

### 学 · 对话核
- **SSE 流式输出**：token 级流式上屏，屏上文本与库内文本逐字一致；断线指数退避重连 + 事件序号回放去重 + 重连后 `/live` 快照对齐
- **回答呈现形态按服务商可配**：原生协议（Anthropic）走逐字流式全过程——**原生思考链**（流式上屏并随消息落库）+ 任务清单 + 工具卡片；兼容中转协议默认「思考中 UI + 一次性回答」；设置页按服务商切换（`stream_mode`）
- **思考中等待态**：三点弹跳 + **阶段感知状态行**（有工具在跑显示真实动作如「联网搜索：闭包」）+ 已用时计时
- **打字机平滑**：不管上游到达节奏多糙，上屏永远匀速逐字；**收口后过程折成一行摘要**（思考字数 · 工具次数 · 任务数），点开才展开
- **消息操作**：复制 / 重新生成（最后一条回答）/ **编辑重发**（最后一条提问，改完重跑、旧回答作废）
- **单轨工具循环**：原生 function-calling 循环（15 轮上限 / 14k 回灌截断 / 逐轮预算检查 / 工具轮原子落库，无孤儿 tool 消息）
- **联网搜索**：Exa / Tavily / 智谱按 key 并行聚合 + 跨家 URL 去重 + 24h 缓存；三家无 key 走免 key 通道兜底；出网带 SSRF 护栏
- **工具调用可视化**：`step` 事件三态进度芯片上屏（进行中 / 完成 / 失败），搜索溯源可见
- **文档模式（RAG）**：给会话绑定一篇资料（粘贴 / .txt / .md）；**短文档（≤ 60k 字）整篇直塞，长文档走真检索**——零依赖词法 **BM25** 切块（800 字 / 重叠 120）后按本轮提问取 Top-12 段落注入，**带【段 n】段号可溯源**；出题 / 抽词缺材料时自动回退用会话资料。实测：70 万字资料下旧直塞内容覆盖率 **0/13**、新检索 **13/13**，注入量从 60k 字降到 10.5k（契约 [`DOC-RAG-SPEC.md`](docs/DOC-RAG-SPEC.md)）

### 学 · 内置浏览器面板
- ```html 围栏产出可交互演示页：对话里只出卡片，点「侧栏预览」在应用右侧内置面板运行（或新标签页）
- 面板只挂模型产出（无地址栏），出页带 `CSP: sandbox` + iframe 双层 sandbox，页面源为 `null`

### 练 + 析 · 出题（自建出题引擎）
- **`[QUIZ]` 结构化协议**：模型按字段清单 + 格式示例输出题组（题干 / 选项 / 答案索引 / 解析 / svg）整块入库——判分靠结构化作答索引，自动批改、逐题可统计，不依赖模型逐次判卷
- **题型配比可配**：单选 / 多选 / 填空 / 解答四档各 0..10、总上限 20；编辑期钳位（所见即所存），服务端归一化兜底；模型没出够不补题、缺几题说几题（ADR-4 降级不崩 + ADR-5 不静默）
- **AI 特化配图**（默认关，总开关是服务端硬门不只靠提示词）：凡题干涉及图形 / 结构 / 装置 / 几何体 / 受力 / 电路 / 光路的题**必须**产出 SVG，每组最多 3 张限流对冲耗时；**真机实测产出率**：生产口径 5/6 组至少 1 张图（1.6~2.3 张/组），逐张浏览器目视为切题真矢量图
- **丢图保题，坏不连坐**：单图 8000 字符上限、缺闭合标记即丢弃——**残缺的几何图比没图更糟，会教错学生**；任何一条校验失败只删该题 `svg` 字段，题目照常交付
- **模型犯错不塌整组**：五级解析阶梯（无损补括号 → 原样 parse → 剥图重试 → 截断逐题回退 → 回退后再剥图），外加无损补 `]` 修复——该修复**在合法 JSON 上永不触发**，纯增益基底
- **如实上报**：`QuizImageReport{on, delivered, droppedSvg, truncated}` 四态贯穿 server→路由→前端，绝不拿「开关已开」冒充「图已交付」
- **题库与统计**：逐题正确率统计、薄弱点定位、golden dataset
- **现场搜集真题**（v0.2.57）：题库页「搜集题目」一条闭环——派生搜集词联网检索 → 受护栏抓页 → 模型从正文**逐字摘录**题目 → **verbatim 锚点锁**（题干锚点命不中原文即拒，宁漏真题不误收编题）→ preview/commit 两段人工确认才入库（外部结果永不直接写库）（契约 [`RESOURCE-SPEC.md`](docs/RESOURCE-SPEC.md)）
- **刷题笔记**：**提交答案即自动落一篇结构化笔记草稿**（题目 / 我的作答 / 对错 / 解析整题快照，每题一篇幂等 upsert），心得手写补全且重答永不覆盖；独立「笔记」一级页（全部 / 只看错题筛选）+ 题库页「本套笔记」直达；快照自洽不设外键——题库删除后笔记仍可读（契约 [`QUIZ-NOTES-SPEC.md`](docs/QUIZ-NOTES-SPEC.md)）

### 忆 · AI 词条库
- **双通道抽词**：回复后 `[TERMS]` 协议 fire-and-forget 自动抽取（不阻塞对话、失败降级空列表）+ 对话页「存入记忆」手动通道；入库按 `UNIQUE(owner, term, domain)` upsert 合并，并向模型注入已有领域 top-12 引导复用词表——防词条库分裂
- **加权相关性注入**：回复前按「子串命中 2.0 / 词元互含 0.5 + importance×0.8 + 最近使用×0.3」加权检索，命中词条作第二条 system 软性注入；回复后 usage 命中计数——**越用的词越容易被再注入**
- **AI 整理**：对话内自然语言触发 `tidy_terms` 工具——自动分组、同义词归一、领域归一，单事务应用；只合并不删除，被并同义词挂主条 `aliases` 防再分裂（契约 [`TERM-TIDY-SPEC.md`](docs/TERM-TIDY-SPEC.md)）
- **领域为一级实体**（迁移 v19）：`term_domain` 登记册支持**新建**（可零词条）、**改名**（该域词条批量随迁，撞唯一键自动并入）、**写说明**、**删除**（词条迁 `general`、一条不删）；AI 侧同步 `domain_add` / `domain_remove`
- **正文词条高亮 + 悬浮卡**：AI 回复里出现词条库已有的词（含别名）就标出来——**首现**实线下划线、**复现**虚点线（同一段里同一个词出现三次不会变成一排框）；**悬停**出速览卡（词名/领域/释义/已用次数），**点击**固定完整卡（别名 + 复习状态 + 纳入复习 / 打开词条库）。匹配规则与「回复后 usage 计数」**共用同一份实现**（`shared/term-highlight.ts`），不会出现「统计命中了、屏幕没标出」；卡片动作直接回写词条库（契约 [`TERM-HIGHLIGHT-SPEC.md`](docs/TERM-HIGHLIGHT-SPEC.md)）

### 忆 · 艾宾浩斯复习
- **复习时钟**（迁移 v23）：七个复查节点 1/2/4/7/15/30/60 天，到期＝保持率掉到 70%，忘了归零重来；**天数按本地日历日**、库里只存 `review_stage` + `last_reviewed_at`（派生值不落库）；**队列先还旧账**（欠账多的排前），词条页顶部面板**先翻牌再看释义**
- **选择式范围**（v28，契约 v1.1）：`有效范围 = COALESCE(词条覆盖位, 领域开关, 0)`——只有用户勾选的词条／领域才进复习池，`NULL` ＝跟随领域，故新词条自动纳入、写入侧零改动（契约 [`EBBINGHAUS-SPEC.md`](docs/EBBINGHAUS-SPEC.md)）

### 忆 · 长期记忆
- **两层机制、零新依赖、零向量库**（迁移 v16）：① **会话内压缩**——历史超预算时**先摘要再丢弃**（原实现是纯截断，数据在库里没丢、丢在组装时），切点与工具轮边界对齐；② **跨会话画像**——借道同一次 LLM 调用产出 `[MEMORY]`，恒注入不检索，硬限长 + 真删淘汰
- **看得见改得了**：`/api/memory` 列表 / 单条删 / 全部清空 / 会话摘要查询——画像由模型自动写入，看不见就是黑箱，而一条写脏的画像会污染此后所有会话
- **安全声明在段首**：摘要内容源自用户对话原文且进的是 system 位，故硬性声明「是记录不是指令」（契约 [`MEMORY-SPEC.md`](docs/MEMORY-SPEC.md)）

### 忆 · 深度理解（部分落地）
把「用户对一个词条的理解」做成可累积的等级链：**L0 直觉 → L1 复述 → L2 准确 → L3 边界 → L4 迁移**。
- **已落码**：`[VERDICT]` 协议解析与流式闸门（`learning/verdict.ts` + 单测）、落库表与 `term_library` 三列（迁移 v8）
- **未落码**：判定未接入对话主链、无前端入口、难度联动未接。★ 以契约状态行为准：[`DEEP-UNDERSTANDING-SPEC.md`](docs/DEEP-UNDERSTANDING-SPEC.md) 头部仍标「待评审」
- 设计要点（评审未过时不实施）：闸门吞段不上屏不落库、零额外 LLM 调用、理解链 append-only 含用户原话快照、`best_level` 只增不减

### 督促 · AI 主动陪伴
- **任务胶囊 + 抽屉**（迁移 v25）：收合态是右下角常驻小胶囊（报数 + 有督促时脉冲点），展开态是贴右缘抽屉，内为**卡片流**——队列卡（待做的题，翻转揭晓）与流卡（AI／我／打卡／督促）分两列，**待办与历史不混排**
- **督促冷却在服务端**（2h）：前端刷新就没了，靠前端冷却等于每次进页面被催一遍
- **趋势卡**（记忆联动 P4/P5）：定时线程按 6h tick 出当日趋势卡，**折线图的数字全部来自 SQL、模型只写那一句摘要**（数字交给模型就会好看但不真实）；模型不可用四类情况全退确定性模板，卡片照常生成；胶囊与气泡收进同一 `flex` 列，**重叠在结构上不可能发生**（契约 [`COACH-SPEC.md`](docs/COACH-SPEC.md) / [`MEMORY-TREND-SPEC.md`](docs/MEMORY-TREND-SPEC.md)）

### 学习流与知识图
- **编排页**：左「我的学习流」列表 → 中 SVG 画布（节点可拖拽改 `position` 并落库，受控视口缩放/平移）→ 右步骤面板（参数表单 + `next`/`correct`/`wrong` 三出口连线）→ 下运行面板（步进 + 逐步轨迹）；**有未保存改动时禁止开跑**（运行冻结的是库里那一版）
- **开箱模板**：三个预制流（四步课堂／错题重练／考前速通），参数与连线均已配好并逐模板过 shared 校验——「新建」不再一进门就是必填空着
- **知识图页**：统计 → 节点列表 → **邻域子图**（点任一节点即以它为新中心重画，顺着关系走下去）+ 节点详情（它指向谁／谁指向它、手工连边、删边）；边分 `user`/`ai`/`derived` 三档，推导边只整批清理（单删下次又冒出来）
- 几何与映射全抽成纯 `.ts`（79 例回归锁），交互接线由真机 CDP 探针核验（契约 [`STUDY-FLOW-SPEC.md`](docs/STUDY-FLOW-SPEC.md)）

### 对战（移动优先独立页）
- `#/pk` 上的独立页，与主应用五环并列；断点适配有 9 档视口真机探针锁（契约 [`PK-SPEC.md`](docs/PK-SPEC.md)）

### 账号与多用户
- **注册 / 登录**：邮箱 + 密码（`scrypt` 派生，参数随哈希落库 ⇒ 调参不必洗库）、邮箱验证码登录（`auth_codes` + Resend 发信）、注册即验证、**GitHub OAuth**（授权 → 拉**已验证邮箱** → **按邮箱自动归并**到既有账号，没命中才建号；入口画不画由 `/api/auth/providers` 探针决定 ⇒ 未配 client id 时自动隐藏，不会出现点了没反应的假按钮）
- **会话安全**：库里只存 `SHA-256(token)`（拖库拿不到可用会话）、`HttpOnly` cookie、登出幂等
- **限流三桶作用域两两不同**：间隔按 `用途:邮箱`、每小时封数按邮箱跨用途共用、IP 封数按 `用途:IP`
- **数据归属**：见 [§当前状态](#当前状态) M2 线；跨用户访问一律 404 不回 403（403 等于承认「这个 id 存在」）
- **成本归属与并发**：`providers.owner_id` 区分「用户自带 key」与「平台免费通道」；免费通道两层闸门＝**每用户 2 路 + 全站封顶 N**（N 仍是占位值 8，待业务值）
- ⚠️ **微信 / 短信登录未做**：两者均要求企业主体资质，个人无法申请；留作企业资质就绪后的增强，且必须映射到同一个 user（契约 [`AUTH-SPEC.md`](docs/AUTH-SPEC.md)）

### 反馈
- 学 / 练 / 忆的每个动作经事件总线 `publishEvent` 按费率表落 XP（归属必填，漏传是静默少算），驱动 XP 连签、今日总结、近 7 天趋势

### 回答方式偏好
- 四维偏好（详略 / 口吻 / 辅助 / 形状）：**L0** 设置页常驻卡 + **L1** 出题前没配过就先就地问一次（勾「记住」才落库）；默认档逐字等价原口径，老用户零感知（契约 [`ANSWER-STYLE-SPEC.md`](docs/ANSWER-STYLE-SPEC.md)）

## 内容块协议

助手正文的围栏白名单只有三种，其余语言一律按代码块转义渲染（禁裸注入）：

| 围栏 | 行为 | 实现 |
|------|------|------|
| ```svg | DOMParser 快路径 + 正则回退**净化**（剥 script / foreignObject / iframe / object / embed / image 外链），再自愈（补闭合 / 钳宽 / 主题色）后内联渲染；支持放大 / 下载 | `web/lib/svg-utils.ts` |
| ```chart | JSON 容错解析 + bar / line / pie **零依赖自绘 SVG** 数据图 | `web/lib/chart-utils.ts` |
| ```html | 对话内永不内联；点「侧栏预览」上传后在右侧面板的沙箱 iframe 运行，也可新标签页 | `server/routes/preview.ts` + `web/features/preview/` |

## 架构

```
浏览器  http://localhost:5173（Vite dev；生产态由 api 同源托管 dist/web）
    │  HTTP + SSE  /api/*（同源代理）+ 会话 cookie
    ▼
┌────────────────────────────────────────────────────────┐
│ packages/server — Express（本地形态 :18791 / 127.0.0.1） │
│   auth/           scrypt 口令 · 会话签发 · 验证码 · 限流 · 归属│
│   routes/         REST 分域路由（auth/chat/terms/quiz/…）│
│   chat/flow       一轮对话编排：多段 system 注入 + 预算收口│
│     ├ chat/tools      工具注册表（search_web/tidy_terms…）│
│     ├ chat/compact    会话压缩 + 跨会话画像               │
│     ├ learning/*      quiz / terms / review / tidy / document│
│     ├ coach/*         督促卡片 · 趋势 · 定时 tick         │
│     ├ flow/*          学习流编排 · 知识图                 │
│     ├ pk/*            对战赛局                            │
│     ├ search/*        三路聚合 → 免 key 兜底              │
│     ├ llm/*           openai / anthropic 双适配 + 两层闸门 │
│     └ sse-bus         事件序号回放 · 按 owner 分频道       │
│   security.ts     Origin 校验 / 密钥加密 / SSRF 护栏      │
└──────────────────────────┬─────────────────────────────┘
                           │ better-sqlite3（WAL，逐版本迁移 v1..v37）
                           ▼
        数据目录 / studentbuddy.db（SB_DATA_DIR 可覆盖）

packages/shared — 契约单一事实源：SSE 事件 / 内容块 / REST / 领域模型
tools/gates     — 工程门禁：行数上限 / 禁内联样式 / 禁 any / 测试登记
tools/probes    — 真机探针 11 个（CDP 真点 8 + 算法/隔离量测 3）
```

**三包职责**：`@sb/shared` 只放契约与纯函数（前后端共用一份，不允许各写一套）；`@sb/server` 承载全部业务域；`@sb/web` 是 React 18 前端，**零第三方运行时依赖**。

**一级视图八个**（`App.tsx` 的 `View` 联合）：对话 / 学习流 / 知识图 / 题库 / 笔记 / 词条 / 今日总结 / 设置；对战是 `#/pk` 独立页，督促是常驻胶囊 + 抽屉。

## 安全与隐私设计

按 ADR-2「安全做必要最小」，落了这几件：

- **Origin 校验**：写操作校验 Origin，**不放行 `'null'`**（sandbox 预览页的源就是字符串 null，放行等于让模型写的网页能调写接口）
- **口令与会话**：`crypto.scrypt` 派生且**参数随哈希自描述落库**；库里只存 `SHA-256(sessionToken)`；「邮箱不存在」与「密码错」回同一个错误码（分开等于提供注册查询接口）；连续 5 次失败 → 429，成功即清零
- **验证码**：码只以明文存在一瞬间（签发即哈希入库），一次性靠**原子认领**（`UPDATE … WHERE consumed_at IS NULL` 以 `changes` 为判据，先查后改会让同一个码用两次）；真正的防线是尝试上限 + 发送侧限流，哈希只防拖库
- **SVG 净化**：剥除外链 `<image>`（防外链信标泄露 IP）与全部脚本载体
- **html 沙箱双保险**：响应带 `CSP: sandbox`（无 `allow-same-origin`）⇒ 页面源为 `null`，读不到本应用数据也调不了写接口；前端 iframe 再叠一层 `sandbox`
- **密钥不出接口**：搜索 key AES-GCM 密文入库，响应只回布尔
- **SSRF 护栏**：搜索 / 抓取出网走护栏 + 白名单；抓页单页不遍历
- **外部结果永不直接写库**：现场搜集走 preview/commit 两段确认，服务端重算逐字锚点、不信模型上报
- **OAuth 登录**：state cookie 防 CSRF；只认 GitHub 返回的**已验证邮箱**（未验证邮箱不参与归并）；邮箱撞既有账号时**显式失败不顶替**；新号写随机不可知口令哈希 ⇒ 不能靠「没设过密码」反推登录方式
- **归属过滤按读形状分两把**：读「一批行」用 `ownerFilter`，读「一个值/聚合」用 `ownerForWrite`——豁免过滤时前者返回多余行、后者会返回**任意一行**（静默串台）
- **请求体 2MB 上限**；SQLite 落库，无上传目录、无路径穿越面

## 部署形态

本地形态开箱即用（见 [§快速开始](#快速开始)）；多用户 Web 形态已在 **<https://11wand.com>** 运行（2026-09-19 起：Caddy 反代 + 自动 TLS + systemd 守护）。`docs/dev/launch-plan.md` §3 保留四类闸门的逐条判据，其中**代码类五条已于 2026-09-19（M2 收口）全部落码**；下表是这五条 env 的现状与「不配的症状」：

| # | 闸门 | 状态 | 不配的症状 |
|---|---|---|---|
| 1 | `SB_TRUST_PROXY=1` + 反代下发 `X-Forwarded-For` | ✅ 已落码 | `req.ip` 恒为反代地址 ⇒ 全站共用一个 IP 桶 ⇒ 发码限流退化成全站上限（Caddy 下发 XFF 与 env 置 1 是同一配置的两处） |
| 2 | `SB_ALLOWED_ORIGINS` | ✅ 已落码 | 部署域名不在白名单 ⇒ 带真实域名的所有 POST 一律 403，**全站瘫痪** |
| 3 | `SB_HOST` | ✅ 已落码 | 缺省 `127.0.0.1`；容器内需置 `0.0.0.0`，否则只绑回环 ⇒ 反代连不上（本机开发无感，上线即挂） |
| 4 | `SB_COOKIE_SECURE=1` | ✅ 已落码 | HTTPS 站点下发非 Secure cookie ⇒ 会话可被明文链路截获 |
| 5 | `SB_REQUIRE_AUTH=1` | ✅ 已落码 | 不强制鉴权 ⇒ 任何人可读写全站数据 |

配置侧另有四条必验项（发信双变量、数据目录指持久卷、端口对齐、全站并发值 N），误配症状逐条写在台账 §3.2。**外部依赖类**（域名/DNS/服务器/邮件送达）与**人工验收类**只能由项目所有者推进。

## 快速开始

**不想装环境？** 直接打开 **<https://11wand.com>**（邮箱注册即用；多用户 Web 形态，数据存服务器）。**想完全本地、数据只留在自己机器上？** 按下文跑本地单机形态——两种形态**共用同一份代码**，差异只在环境变量。

> ⚠️ **Node 版本必须「装依赖」与「运行时」一致**（`engines: >=22.11.0`，仓库带 `.nvmrc`）：`better-sqlite3` 是原生模块，产物按**安装那一刻**的 Node ABI 编译；用 Node 20 装完再拿 Node 22 跑（或反之），涉库代码会全线 `ERR_DLOPEN_FAILED`，表现为所有 HTTP 接口 500、测试大面积红，**极易误判成新代码写错**。**换 Node 大版本必须重装依赖**（删 `node_modules` 后 `npm install`），只换运行时无效。

```bash
npm install          # workspaces 三包一次装齐（装依赖的 Node = 以后跑的 Node）
npm run check        # lint(tsc×3 + eslint) + test(vitest) + gates —— 全绿基线
npm run dev          # 一条命令并行拉起 api :18791 + web :5173（Ctrl+C 一起停）
npm run dev:server   # 只起 api :18791（端口被占时 SB_PORT=18792）
npm run dev:web      # 只起 web :5173（代理目标 SB_PROXY_TARGET 可配）
```

浏览器打开 **http://localhost:5173**（vite 监听 IPv6 `::1`，用 localhost 而非 127.0.0.1）。

首次使用：设置页添加 AI 服务商（OpenAI 兼容协议，`baseUrl` / `apiKey` / `defaultModel`）；要用联网搜索再配搜索 key（见[配置说明](#配置说明)）。

## 仓库结构

```
packages/
├─ shared/src/            契约单一事实源
│  ├─ sse-events.ts         SSE 事件契约（先登记再实现）
│  ├─ content-blocks.ts     内容块协议 + 题型配比契约
│  ├─ auth.ts / tenancy.ts  账号校验 / 归属工具（前后端同一份）
│  ├─ ebbinghaus.ts         复习判定唯一实现
│  ├─ doc-rag.ts            文档检索常量唯一事实源
│  └─ domain.ts             Session / Message / TermItem 领域模型
├─ server/src/
│  ├─ index.ts              Express 入口（安全头 / CORS / originCheck / 2MB）
│  ├─ auth/                 password / session / users / codes / code-limit / middleware / ownership
│  ├─ chat/flow.ts          对话编排：多段 system 注入 + 上下文预算收口
│  ├─ chat/compact.ts       会话压缩 + 跨会话画像
│  ├─ chat/tools/           工具注册表（search_web / tidy_terms / manage_terms …）
│  ├─ learning/             quiz(+json-repair) / terms / domains / review / tidy / document(+BM25) / verdict / knowledge-graph
│  ├─ coach/ · flow/ · pk/   督促卡片 / 学习流与知识图 / 对战赛局
│  ├─ search/               多路聚合 + 免 key 兜底 + 24h 缓存 + SSRF 护栏
│  ├─ llm/                  openai / anthropic 双适配 + router(归属) + upstream-gate(两层)
│  ├─ sse-bus.ts            帧序号 · 回放去重 · 按 owner 分频道
│  ├─ routes/               REST 分域路由（15 个域文件）
│  ├─ storage/              better-sqlite3 封装 / 逐版本迁移（v1..v37，按区间分文件）
│  └─ security.ts           Origin 校验（不放行 'null'）
├─ web/src/
│  ├─ app/App.tsx           应用壳：侧栏八视图导航 + 可折叠历史 + 用户框
│  ├─ features/chat/        ChatView / useChatStream / Markdown / Thinking / AskStyleCard / 像素吉祥物
│  ├─ features/{quiz,terms,notes,summary,coach,study-flow,pk,settings,preview}/
│  ├─ lib/                  svg-utils（净化+自愈）/ chart-utils（自绘图表）/ markdown / highlight（零依赖）/ api*
│  ├─ components/icons.tsx  SVG line-icon 基座（禁 emoji）
│  └─ styles/tokens.css     设计 token 唯一事实源
tools/
├─ gates/check.mjs         行数 / 内联样式 / any / 测试登记 四项门禁
├─ probes/                 真机探针 11 个（CDP 真点 8 + 算法/隔离量测 3）
└─ migrate-from-v1/        v1→v2 数据迁移
docs/                      契约与研发台账（25 份契约/SPEC + dev/ 四份 + metrics）
DEPLOY.md                  部署手册：服务器 / systemd / 五条部署 env / TLS / 备份 / 回滚
CHANGELOG.md               项目改动登记册（代码/文档/测试同批登记）
AGENTS.md                  施工手册：模块地雷图 + 工程红线 + 决策记录
```

## 开发指南

**门禁红线**（`npm run gates` 强制）：

- 单文件行数：server ≤ 400 行 / web 组件 ≤ 300 行（触线按仓规**拆文件**，不压注释换行数）
- 禁内联 `style={{…}}`（一律走 tokens.css 的 token）；禁 `any`；测试也禁 `!` 非空断言
- 每个测试文件必须在 `docs/dev/test-plan.md` 成行登记（未登记 = 门禁红）

**`npm run check` = tsc×3（shared/server/web）+ eslint + vitest + gates**，全绿才许提交。当前基线：**157 测试文件 / 2166 用例**（2165 passed + 1 skipped；**权威口径见 [`docs/dev/test-plan.md`](docs/dev/test-plan.md) §3**，此处仅为快照）。

交互层是**两层互补**，别指望任何一层单独覆盖：

| 层 | 覆盖什么 | 覆盖不到什么 |
|---|---|---|
| **`.test.tsx`（jsdom，8 个）** | 交互**逻辑**：点了之后状态对不对、调没调接口、条件渲染出现没有 | 真 CSS 布局、真实浏览器 API（`DOMParser` / `getBBox` / `elementFromPoint`）——jsdom 里这些要么没有、要么是桩 |
| **`tools/probes/*.mjs`（真机，10 个）** | 真浏览器里的**观感与布局**：CSS 断点、SVG 几何、点击链路、在途三态 | 组件内部逻辑分支的穷举（探针不驱动 React 状态） |

`.tsx` 的 jsdom **按文件 pragma 启用**（全局 environment 仍是 `node`），改交互时两层都要跑：

| 探针 | 验什么 | 前置 |
|---|---|---|
| `terms-layout-cdp.mjs` | 词条页布局三态 × 两视口（56 断言）——**改 `terms.css` 任何高度/`flex`/`overflow` 后必须重跑，门禁看不见 CSS** | 零前置（自带静态服务，不碰后端/库） |
| `coach-trend-cdp.mjs` | 趋势卡折线 + 胶囊旁气泡（33 断言）——**唯一在真浏览器里验 `prepareSvg` 的 DOMParser 路径的仪器** | 仅需 vite |
| `coach-cdp.mjs` | 督促小窗三态（默认档 38 断言，零 LLM） | 需 `npm run dev`；拷库做隔离时**记得把 `.mk` 一起拷**，否则 `decryptSecret` 解不开 key |
| `flow-canvas-zoom-cdp.mjs` | 编排画布缩放/平移（31 断言，含「滚轮锚点不漂」） | 需 `npm run dev` |
| `pk-breakpoint-cdp.mjs` | 对战页 9 档视口断点 | 仅需 vite |
| `doc-rag-bm25.mjs` | 切块/BM25 召回量测——**改 `shared/doc-rag.ts` 任何常量前必须重跑**，契约 §8 的每个数字出自它 | 零依赖 |
| `chat-composer-cdp.mjs` | 输入区「+」折叠菜单五项目 + 状态摘要「联网已开」挂没挂在触发器上 + 侧栏入口 | 需后端 18791 + vite 在 **5174**（端口写死） |
| `quiz-e2e-cdp.mjs` | 出题页「来源」行只在**答后揭晓**才渲染、`RefList` 默认折叠、`searchNote` 与来源清单的二选一 | 需后端 + vite 5174；★ **会真出题落库** ⇒ 必须对隔离实例跑 |
| `weak-analysis-cdp.mjs` | 薄弱点分析三态（含「后」态按钮复位）+ 多主题卡片全渲染 + 降级提示不冒充 AI | 需 `npm run dev`；**只读**但真花模型额度，不进 CI |
| `db-isolation-check.mjs` | 全量测试**前/后**各跑一次、逐字段比对一致 ⇒ 证明「测试不写真实数据目录」 | 零前置；以 `readonly` 打开库，全程无写 |

**提交纪律**：

- 三件套：代码 + 文档 + 测试同批提交；每批在 `CHANGELOG.md`「未发布」段追加一行，验证列只写实测结论（推断不进表）
- Conventional Commits；从 v1 搬运的件标注 `port from v1`
- 改 bug 前先读 [`docs/dev/bug-ledger.md`](docs/dev/bug-ledger.md)（收敛计数 3 = 禁止第 4 次同向尝试）
- 上线阶梯每完成一批：改 `launch-plan.md` §2 状态 + §5 追加一次总体进展汇报

**扩展模式**：

- 新增 SSE 事件 → 先在 `shared/src/sse-events.ts` 登记，同步 [`docs/SSE-CONTRACT.md`](docs/SSE-CONTRACT.md)
- 新增内容卡片 → `shared/src/content-blocks.ts` 登记 kind + web 注册渲染器
- 新增工具 → `chat/tools/` 加定义 + `step` 上报，flow 循环零改动
- 新增设置项 → `app_settings` 键名在 shared 登记，套路照 quiz-mix（load 归一化回落 / save upsert）；★ 该表已按 `owner_id` 归主，**新键必须带归属**

## 配置说明

| 配置 | 位置 | 说明 |
|------|------|------|
| AI 服务商 | 设置页（`providers` 表，按 `owner_id` 归属） | OpenAI 兼容协议；Anthropic 型走独立适配器（system 全量合并） |
| 搜索 key | 设置页（AES-GCM 密文入库）或环境变量 | 环境变量：`EXA_API_KEY` / `TAVILY_API_KEY` / `ZHIPU_API_KEY`；三者全缺走免 key 通道兜底，质量以配 key 为稳 |
| 发信 | `RESEND_API_KEY` **与** `SB_MAIL_FROM` | ★ **两个都配齐才真发信**；只配一个会静默走控制台兜底，症状是「点了发送、界面说成功、邮箱永远没有」 |
| GitHub 登录 | `SB_GITHUB_CLIENT_ID` **与** `SB_GITHUB_CLIENT_SECRET` | ★ 两个都配齐入口才画（`/api/auth/providers` 探针）；OAuth App 的 callback 必须与部署域名一致（`https://<域名>/api/auth/github/callback`） |
| 鉴权 | `SB_REQUIRE_AUTH`（默认关）、`SB_COOKIE_SECURE` | 强制鉴权必须与 M2 收口同批开；HTTPS 部署必须开 Secure |
| 上游并发 | `SB_UPSTREAM_SITE_MAX_CONCURRENT`（全站封顶，**缺省 8 为占位值**）、`SB_UPSTREAM_SITE_QUEUE_MAX`（缺省 20） | 只约束平台免费通道；队列满**明确拒绝**而非无限排队 |
| 端口 | `SB_PORT`（默认 18791）、`SB_PROXY_TARGET` | 端口被 v1 占用时切 18792，**不杀 v1 进程** |
| 数据目录 | `SB_DATA_DIR`（默认平台 AppData 下 `studentbuddy-v2`） | SQLite 单文件 `studentbuddy.db`（WAL），逐版本 schema 迁移；容器部署**必须指向持久卷** |

## v1 数据迁移

M4 自带全量迁移工具（ADR-6：**永不触碰 v1 原库**；v2 库先备份再动）：

```bash
node tools/migrate-from-v1/migrate.mjs --dry-run   # 只出报告，不落库
node tools/migrate-from-v1/migrate.mjs --run       # 备份 v2 库后执行
```

迁移 `sessions / messages / quiz_bank / memorize`（SRS 初值）与 providers；v1 早期 GBK 乱码标题自动重解码，不可恢复的保留原文并打标。

## 里程碑

**产品功能线**（与上线阶梯无关，见 [§当前状态](#当前状态)）：

| 阶段 | 状态 |
|------|------|
| M0 地基（workspaces 三包 / 四项门禁 / 设计 token / SVG 图标基座 / 安全中间件） | ✅ 2026-08-23 |
| M1 对话核（SSE / 单轨工具循环 / 模型路由 / 内容块流 / 内置浏览器面板） | ✅ 2026-08-28 |
| M2 练+析（出题引擎 / 题型配比 / SVG 配图 / 逐题统计） | ✅ 2026-09-04 |
| M3 忆（AI 词条库 + AI 整理） | ✅ 2026-09-03 |
| 文档模式（短文档直塞 + 长文档 BM25 检索） | ✅ 2026-09-02，检索改造 2026-09-06 |
| 长期记忆（会话压缩 + 跨会话画像） | ✅ 2026-09-15 |
| 对战（PK 独立页） | ✅ 2026-09-13 |
| 学习流 + 知识图（编排 / 模板 / 画布视口） | ✅ 2026-09-17 |
| 复习时钟（艾宾浩斯 + 选择式范围） | ✅ 2026-09-17，范围选择 2026-09-18 |
| 督促小窗 + 趋势卡（记忆联动 P1~P5） | ✅ 2026-09-18 |
| 现场搜集真题（逐字锚点锁 + 两段确认） | ✅ 2026-09-18 |
| 深度理解（判定链完整闭环） | 🔶 闸门件与落库表已就位，主链未接线 |
| M4 定稿（反馈环收口 + v1 迁移实跑） | 🔶 反馈与迁移工具已落，定稿未做 |
| M5 工具生态（MCP / 文件工具 / 确认门） | 🔶 S1 内核与 S2 确认门/词条三工具已落码（契约 v1.4.1，2026-09-19）；S3 MCP 接入未开工 |
| 全站搜索（FTS5 三族索引：消息 / 词条 / 错题本） | ✅ 已入库 2026-09-20（契约 `docs/FTS-SPEC.md`；迁移 v37；`GET /api/search`）★ 真机端到端待目检 |
| 词条英文发音（卡片喇叭 · 浏览器本地语音） | ✅ 已入库 2026-09-20（契约 `docs/TERM-HIGHLIGHT-SPEC.md` v1.1；`web/src/lib/speech.ts`）★ 真机听音待目检 |

## 已知限制

- **部署形态是「ssh 直传 + systemd」，不是容器**：仓内**没有 Dockerfile / Caddyfile**（服务器侧配置见 [《部署手册》](DEPLOY.md)）；`tools/deploy.sh` 是一键发布脚本（`check` → `build` → 上传 → 重启 → 健康检查，任一步失败即停）。★ 边界：`evolution_*` 与 `scenario_demo` 未加归属列（契约未点名，触达均经已归主父表的闸门）
- **`security.ts` 的 Origin 白名单**：`SB_ALLOWED_ORIGINS`（逗号分隔）已在 M2 收口落码，部署域名配进白名单即可；**localhost 兜底正则刻意保留**（本机开发不因忘配 env 而挂）。配错 env 的症状是「合法域名也 403」——宁可显式失败不放宽（不收通配符）
- **上游并发闸门是进程内 `Map`**：多实例部署下容量 × 实例数，全站封顶只在单进程内成立
- **行内公式不渲染**：`$…$` 按原文显示（未引 katex，保持 `@sb/web` 零第三方依赖）；`mermaid` / `echarts` 围栏降级代码块（刻意不引库，数据图由自绘 ```chart 覆盖）
- **预览页只活内存**：服务重启即失效，无分享链接（内置面板无地址栏、宽度不可拖拽，是定档边界不是缺陷）
- **文档模式：词法检索，不是语义检索**：≤ 60k 字整篇直塞；> 60k 才切块 + BM25 取段落。**没有 embedding 向量／跨会话资料库／持久化索引／pdf-docx 解析／可点击溯源**。已知天花板：用户**不用资料里的原词**改写提问时，70 万字规模下召回收敛在 **8/13 ≈ 62%**（词法路线的性质，只能靠向量路线突破）；且**不靠分数阈值判「资料没写」**——两种阈值方案都被实测否掉（真命中区间与干扰项区间重叠），识别不到的权力交给模型如实说（契约 `DOC-RAG-SPEC.md` §3.3）
- **渲染层覆盖仍不完整**：10 个 `.test.tsx` 覆盖了最高频的几页（对话主视图 / 词条库 / 落地页 / PK / 输入区 / 确认卡等），**其余页面仍无 jsdom 测试**；且 jsdom 里没有真 CSS、也没有 `DOMParser` / `getBBox` / `elementFromPoint` 这类真实浏览器 API ⇒ 布局与观感类症状仍只能靠真机探针 + 人工目检，覆盖率数字对交互层不适用
- **全站并发值 N 仍是占位值 8**：待业务值确定后调整，沿用上线会收到「当前免费通道繁忙」

★ 覆盖率与历史基线的逐文件对账见 [`docs/metrics.md`](docs/metrics.md)（**2026-09-06 全量采集，未随近期批次刷新**，引用时注意口径日期）。

## 文档索引

`docs/` 是本仓的**权威技术文档面**。分两类：`*SPEC*.md` 是行为契约（改行为先改契约），`dev/` 是研发台账。

| 文档 | 内容 |
|------|------|
| [`SSE-CONTRACT.md`](docs/SSE-CONTRACT.md) | SSE 事件与 HTTP 接口契约（前端对接核心） |
| [`AUTH-SPEC.md`](docs/AUTH-SPEC.md) | 账号契约（注册/登录/验证码/限流/后续批次划分） |
| [`TENANCY-SPEC.md`](docs/TENANCY-SPEC.md) | 多租户归属契约（M2a~M2d 改造准绳） |
| [`MEMORY-SPEC.md`](docs/MEMORY-SPEC.md) | 长期记忆契约（会话压缩 + 跨会话画像） |
| [`MEMORY-TREND-SPEC.md`](docs/MEMORY-TREND-SPEC.md) | 记忆联动契约（提及流水 → 偏好领域 → 督促趋势卡） |
| [`EBBINGHAUS-SPEC.md`](docs/EBBINGHAUS-SPEC.md) | 复习时钟契约（间隔序列 / 日历日口径 / 选择式范围） |
| [`COACH-SPEC.md`](docs/COACH-SPEC.md) | 督促小窗契约（胶囊与抽屉 / 卡片合并 / 冷却在服务端） |
| [`STUDY-FLOW-SPEC.md`](docs/STUDY-FLOW-SPEC.md) | 学习流契约（步骤注册表 / 控制流 / 知识数据图；「图静态、流动态」） |
| [`DEEP-UNDERSTANDING-SPEC.md`](docs/DEEP-UNDERSTANDING-SPEC.md) | 深度理解契约（★ 状态：**待评审**，实施范围以其头部为准） |
| [`QUIZ-IMAGE-SPEC.md`](docs/QUIZ-IMAGE-SPEC.md) | 出题配图契约（字段加法 / 丢图保题 / 提示词口径） |
| [`QUIZ-SEARCH-SPEC.md`](docs/QUIZ-SEARCH-SPEC.md) | 出题联网检索契约（素材不是指令 / 失败不阻断不静默） |
| [`QUIZ-NOTES-SPEC.md`](docs/QUIZ-NOTES-SPEC.md) | 刷题笔记契约（提交即落草稿 / 快照自洽不设外键） |
| [`QUIZ-WEAK-SPEC.md`](docs/QUIZ-WEAK-SPEC.md) | 薄弱点分析契约 |
| [`RESOURCE-SPEC.md`](docs/RESOURCE-SPEC.md) | 现场搜集契约（逐字锚点锁 / 两段确认入库） |
| [`DOC-RAG-SPEC.md`](docs/DOC-RAG-SPEC.md) | 文档检索契约（常量取值依据与被否掉的两条阈值方案） |
| [`TERM-TIDY-SPEC.md`](docs/TERM-TIDY-SPEC.md) | 词条库 AI 整理契约（归一规则 / 别名防分裂） |
| [`TERM-HIGHLIGHT-SPEC.md`](docs/TERM-HIGHLIGHT-SPEC.md) | 正文词条高亮 + 悬浮卡契约（匹配口径唯一事实源 / 两态卡片 / 数据路线取舍） |
| [`ANSWER-STYLE-SPEC.md`](docs/ANSWER-STYLE-SPEC.md) | 回答方式偏好契约（L0/L1 行为、默认档等价性） |
| [`ASK-CHOICE-SPEC.md`](docs/ASK-CHOICE-SPEC.md) | 就地提问契约（出题前问一次 / 队列与落库） |
| [`PK-SPEC.md`](docs/PK-SPEC.md) · [`PK-DEMO-SPEC.md`](docs/PK-DEMO-SPEC.md) | 对战契约与演示脚本 |
| [`SCENARIO-SPEC.md`](docs/SCENARIO-SPEC.md) | 场景卡契约 |
| [`TOOL-ECOSYSTEM-SPEC.md`](docs/TOOL-ECOSYSTEM-SPEC.md) | 工具生态契约（工具内核 / MCP / 确认门 / 计时口径） |
| [`metrics.md`](docs/metrics.md) | 定量基线采集口径（⚠️ 2026-09-06 快照） |
| [`dev/test-plan.md`](docs/dev/test-plan.md) | **测试基线权威口径** / 逐文件不变量 / 挂账清单 |
| [`dev/launch-plan.md`](docs/dev/launch-plan.md) | **上线台账**：阶梯进展 + 部署闸门清单＝「什么时候能上线」的答案 |
| [`dev/bug-ledger.md`](docs/dev/bug-ledger.md) | 反复 bug 台账（收敛计数驱动换根因假设） |
| [`dev/manual-test.md`](docs/dev/manual-test.md) | 真人验收记录 |
| [`DEPLOY.md`](DEPLOY.md) | **部署手册**：服务器 / systemd / 五条部署 env / TLS / 备份 / 回滚 |

★ 更高层的元规则与个人开发规范不随本仓分发；仓内以 `AGENTS.md`（施工手册）与本目录为权威面，二者与代码冲突时**以代码 + 测试为准**。
