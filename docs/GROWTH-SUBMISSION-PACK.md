# GROWTH-SUBMISSION-PACK — 对外提交资产包（渠道 C7）

> 版本：**v0.1.2** | 状态：[活跃] | 更新：2026-09-26（★ 本题库整族下线批：§2 一句话 A/C ＋ §3a/3b/3c 正文共 **7 处**在替已删功能背书（逐题正确率／薄弱点定位、概念图与知识图谱、每日总结），另有 **3 处**滞后账（§3a 出处那句「TERM_SPINE 五条」、§6.1 的侧栏项数与截图分档计数），本批 **10 处**全改成现查仍在的事实，总登记见本块下方那条 ★★；★ 前任 **v0.1.1**（2026-09-24 08:4x，批次 G-3）的表头**原样留在下一行未回改**——那行里有一个 G-3 留下的未闭合「（」（全文件净差 1，09-24 即如此，本批不碰他人行）。）
> 版本：v0.1.1 | 状态：[活跃] | 更新：2026-09-24 08:4x（**批次 G-3 让本包一条判据当场过期，同批改口**：★ §1「我们没有什么」那一格原先写的是「`/privacy` 等地址返回 **2548 字节** SPA 壳」——那个字节数记的是**首页壳**的大小，而 G-3 把壳里的 5 条施工注释清掉了，发版之后它会变成 **1888 B**。⚠️ **此刻线上仍是 2548**（本批未发版），所以那格不是错，是**易碎**：一条要靠「今天构建出来的壳刚好多少字节」成立的判据，下次改文案就会碎。⇒ 判据已改成按**内容**读（「那一页的正文在不在里面」），数字只作为「换没换壳」的旁证留着。★ 这条与 `SEO-SPEC.md` §5 第 12 条同源：**本站不存在的地址返 200 壳，状态码与字节数都不是判据**。｜前值 v0.1.0 原表头逐字：| 状态：[活跃] | 更新：2026-09-24 00:3x（批次 G-2 新建）
> ★★ **本包只解决一件事**：把「提交到导航站／清单站」这件**老板本人的动作**的前置成本降到「复制粘贴」。
> 提交、注册账号、填表单**一律由老板做**（`GROWTH-CHANNELS.md` §0 总口径第 1 条：「做能力」＝做进产品，不是 AI 代做动作）。
> ★ **本包的立身红线＝不新造事实**：§2／§3／§5 里每一段可对外的话，右边都有一格「出处／复验」；
> **写不出处的话就不进本包**。凡把握度非「高」者，抄出去前自己再验一次。
> ★ 老板原话（2026-09-23，本批的派发依据）：「我们的推广计划还没有搞完吧，还有其他推广途径那就是继续。」
> ⚠️ **本文件是内部文档，不随站点发布**；从本文件复制出去的只能是各节「可粘贴」栏内的正文。
> ★★ **2026-09-26 全包扫假话改口（题库整族下线批，抄出去前请先读这条）**：包里有六格替**已经不存在的功能**背书，本次全部改成仍在的事实——「逐题正确率／薄弱点定位」（本批随题库断线）、「概念图／知识图谱」「每日总结」（前两批随学习流与今日总结下线，★ 是本包**迟了两天的账**，不是本批删的）。⚠️ **同四处假话在落地页与 OG 卡片文案里仍在**（`packages/web/src/app/landing-data.ts` 的 `知识图谱` 卡 + `TERM_SPINE` 的 `连成图谱` + `INTRO_THREE` 的 `每日总结`、`packages/web/src/seo/og-card.ts` 的 `alias`）——那四处属**产品对外面**，改文要老板目检、且**要发版才生效**，故本批未动，只在此登记。

## 0. 三句话用法

1. 表单要「一句话简介」→ §2 挑一条（中／英各三候选，已标注建议档）。
2. 表单要「描述／关于」→ §3 按它的字数上限挑 240／600／1200 字档，**不要自己另写**。
3. 表单要「隐私／数据说明」，或你在评论区替这个项目答质疑 → §5 **只用那十条的原话**，
   其中第 5 条（**内容要发给模型服务商**）是**必须主动说**的那一条，被问出来再说是失败。

---

## 1. 身份与链接（所有表单的公共字段）

| 字段 | 值 | 出处／复验 | 把握度 |
|---|---|---|---|
| 产品名 | `studentbuddy`（应用内与侧栏 logo 用这个）／`StudentBuddy`（对外首字母大写的写法） | `packages/web/src/lib/brand.ts`（`BRAND_NAME`）；`packages/web/index.html` 的 `og:title` | 高 |
| 官方站点 | <https://11wand.com> | `GET /api/health` 返 `{"ok":true}`（09-24 现读） | 高 |
| 免注册体验 | 首页 hero 的「免注册，直接体验」按钮（服务端开关，现为开） | `GET /api/auth/providers` → `{"providers":{"github":true,"demo":true},"form":"cloud"}`（09-24 现读） | 高 |
| 源码仓库 | <https://github.com/llwand1/studentbuddy-v2>（**PUBLIC**） | `gh repo view --json visibility` 实测 `PUBLIC` | 高 |
| 许可证 | **MIT** | 仓根 `LICENSE`；`gh repo view --json licenseInfo` → `mit` | 高 |
| 形态 | ①自托管服务端（Docker／裸机）②本地单机（`npm run dev`）③官方托管实例（就是 11wand.com） | README §部署形态 | 高 |
| 技术栈 | TypeScript · React 18 · Express · SQLite（better-sqlite3）· Vite 5 | README §架构；`package.json` | 高 |
| 运行时依赖数 | **6**（外部运行时依赖），前端**零第三方 UI／Markdown／图表库** | `node tools/metrics.mjs`；`packages/web/package.json` | 高 |
| 自动化测试 | **2,800+ 例**（截至 2026-09-24 为 2817 例／204 文件） | `node tools/metrics.mjs --tests`（★ 这个数字会漂，抄之前现读一次） | 高 |
| 价格 | **免费**：MIT 开源、无付费档、无内购、无广告 | 全仓 grep `stripe\|alipay\|subscription\|付费` 无计费代码（09-24 现查） | 高 |
| 维护者 | **一个人**（llwan），非企业、无公司主体 | 事实；表单问 `company` 就填 solo developer | 高 |
| 首次公开上线 | 2026-09-19（11wand.com 上线日） | README §当前状态 M3 行 | 高 |
| 当前版本 | `2.0.0-alpha.0`（★ 诚实标：alpha 不是 stable） | `package.json` `version` | 高 |
| 语言 | 落地页中英双语；**应用壳与词条页目前只有中文** | `landing-copy.ts`／`landing-data.ts`（双语）；`FOOT_TERMS.en` 明写 `Glossary (Chinese only)`；应用内 `App.tsx` 文案为中文 | 高 |
| ⚠️ 我们**没有**的 | 隐私政策页、服务条款页、状态页、邮件列表、移动端原生 app | ★ **判据是「响应里没有那一页该有的正文」，不是状态码也不是字节数**（本站对不存在的地址一律兜回首页壳并返 200；09-24 现读 `/privacy`、`/terms-of-service`、`/legal` 各 2548 B，⚠️ 这个数随首页壳改动而变，别拿它当凭据） | 高 |

---

## 2. 一句话简介（三候选，全部由既有公开文案重组）

> 素材来源：`packages/web/index.html` 的 `meta description`／`og:description`、`landing-copy.ts` 的 `HERO.sub` 与 `INTRO.def`、README「这是什么」。
> **没有一句是新写的**——所以每一条都能被站内既有文案证。

### 中文（表单常给 ≤140 字，三条都远小于）

| # | 可粘贴正文 | 字数 | 侧重 |
|---|---|---|---|
| **A（建议）** | StudentBuddy：把学过的东西抽成你自己的词条库，词条自己长出复习排期、出题判分、正文高亮和跨会话记忆。开源、可自托管，也可以直接用我们上线的那一份。 | 79 | 差异化＝**词条是主体**（09-22 老板点单的主轴）；★ 09-26 现查：末项原写「概念图和每日总结」，两者所在功能已下线，换成仍在的两件（原 77 字） |
| B | 自托管的 AI 学习助手：学→练→析→忆→反馈一条闭环自己转，用你自己的模型 Key，数据留在你自己的服务器上。 | 56 | 差异化＝**自托管＋自带 Key**（自托管导航站吃这一口） |
| C | 不是一个套了学习提示词的聊天框。它以你自己的词条库为中心：一个词进了库，出题、复习、对战都围着它转。 | 50 | 差异化＝**跟「聊天框」划清**（中文社区向）；★ 09-26 删掉「概念图、每日总结」两项已下线的能力，原 56 字（字数＝码点数，与 B 行同一算法现数） |

### 英文（清单站的 tagline 一般给 60 字符以内，三条均 ≤55）

| # | 可粘贴正文 | 字符 |
|---|---|---|
| **A（建议）** | Self-hosted AI study copilot built around your terms | 52 |
| B | Your term library drives quizzes, review and graphs | 51 |
| C | Local-first AI study assistant: learn, practise, recall | 55 |

---

## 3. 长简介三档（按表单字数上限取一档）

### 3a · 约 240 字（中文，短表单）

> studentbuddy 是一个开源、可自托管的 AI 学习助手。它把「学 → 练 → 析 → 忆 → 反馈」做成一条自动运转的闭环：你只管提问，讲解、出题、判分、复习排期、AI 主动督促自己往下走。核心是一份**你自己的词条库**——对话里学到的概念自动入库，一个词进了库就会驱动出题、决定复习时机（1/2/4/7/15/30/60 天）、在回复里被高亮标出、还能拿去对战。用你自己的模型 Key，数据存在你自己的服务器（一个 SQLite 单文件，备份＝拷一个目录）。MIT 开源，也可免注册直接体验。

**出处**：`landing-data.ts` 的 `INTRO.def` ＋ `TERM_SPINE` 四条（★ 2026-09-26 现查：原写「五条」是批次 K 删掉「沉淀总结」之后的滞后账；★ **那四条里的「连成图谱」本身是假话**——`knowledge_edge` 的每轮自动连边随学习流于 09-25 删除，见 `chat/post-turn.ts:14` 注——所以 3a 这段抄出来时**不许带图谱那半**，本段已按此改写）＋ `PRIVACY_ITEMS` 第一条；逐条对得上 README「功能总览」。

### 3b · 约 600 字（中文，标准表单）

> studentbuddy 想解决的是「AI 学习产品＝套了学习提示词的聊天框」这件事。它的答案是**把词条做成主体**：
>
> - **学**：流式对话 + 思考链 + 联网检索 + 文档模式（长文档 BM25 段落检索、带段号可溯源）
> - **练**：自建出题引擎——结构化协议、四题型配比可配、自动判分、模型特化 SVG 配图
> - **析**：题卡在对话里当场判分、逐题给解析，AI 主动督促带学习趋势
> - **忆**：AI 自学词条库 + 艾宾浩斯复习时钟（1/2/4/7/15/30/60 天，到期自己进队列）+ 跨会话长期记忆
> - **反馈**：XP、连签，外加 AI 主动督促（★ 2026-09-25：原列的「今日总结」整页已下线删除，对外素材里**不许再写**——落地页那格同步换成了「AI 主动督促」）
>
> 两个工程取向值得单说。一是**AI 输出可靠性**：模型不听话不该塌系统，所以出题有五级解析阶梯、配图遵循「丢图保题、坏不连坐」、流式有空闲超时、上游有并发闸门，每条对策都对应一次真实故障的根因登记。二是**依赖克制**：前端零第三方 UI／Markdown／图表库（Markdown 解析、代码高亮、数据图、SVG 净化全部自写），外部运行时依赖只有 6 个——供应链攻击面和包体积同时趋零。
>
> **数据与隐私的形状**：同一份代码可跑成本地单机，也可跑成多用户服务；数据是一个 SQLite 单文件，备份＝拷一个目录。模型 API Key 加密入库、永不出接口；会话令牌库里只存哈希；整站只有一枚 HttpOnly 会话 cookie；访问统计用自托管 GoatCounter，不发追踪 cookie；自己的访客计数**不落裸 IP**（只存 `sha256(盐+IP)` 的前 16 位）。
>
> MIT 开源 · 免注册可直接体验 · 也可以 `docker`／裸机自托管。

### 3c · 约 1200 字符（英文，selfh.st / AlternativeTo / Product Hunt）

> studentbuddy is an open-source, self-hostable AI study copilot. The point isn't to wrap a chat model in a study prompt — it's to make **your own term library** the center of everything.
>
> The loop runs on its own: **learn → practice → grade → remember → feedback**. You ask questions; explaining, quiz-making, grading, review scheduling and the AI coach's nudges keep going by themselves.
>
> What that means in practice, once a concept is filed into your library:
>
> - it **drives quizzes** — questions generated around the term, four question types with a tunable mix, auto-graded by structure rather than by asking the model to mark its own homework
> - it **schedules its own review** on spaced intervals (1/2/4/7/15/30/60 days); due terms enter the queue on their own
> - it **shows up where you read** — terms from your own library are marked inside the reply, hover for the definition and its review state
> - it **feeds the study-trend card** the AI coach quotes, whose numbers all come from SQL, never from the model
> - and it can be taken into **1v1 battles** where both screens answer the same question
>
> Two engineering bets are the reason this is more than a prompt:
>
> 1. **Dependability of AI output.** Model misbehaviour must not take the system down: a five-stage parse ladder for structured output, "drop the image, keep the question" degradation, idle timeouts on streaming, and a two-layer upstream concurrency gate. Every one of those counters traces back to a logged real incident.
> 2. **Restraint on dependencies.** The frontend ships zero third-party UI / Markdown / chart libraries — Markdown parsing, syntax highlighting, data charts and SVG sanitising are all hand-written. Six external runtime dependencies in total, which keeps the supply-chain surface and the bundle small at the same time.
>
> **Data and privacy.** One codebase, two shapes: a local single-user app, or a multi-user web service. Your data is one SQLite file — backing it up means copying a directory. Model API keys are encrypted at rest and never returned through the API; session tokens are stored only as hashes; the whole site sets a single HttpOnly session cookie; analytics is a self-hosted GoatCounter that sets no tracking cookie; our own visit counter never stores raw IPs (only a salted `sha256(IP)` prefix).
>
> MIT licensed. Try the hosted instance with no sign-up, or run it on your own box.

**⚠️ 这段英文里刻意**没写**的四件事**（写出去就是新造事实）：不是 "Anki alternative"（无对比实测）· 没有 mobile app（只有对战页移动优先）· 没有 "unlimited free AI"（免费通道有并发上限）· 没有 "semantic search"（文档模式是词法 BM25，不是向量检索）。

---

## 4. 标签与分类（贴哪条都要贴得起）

| 标签 | 中英 | 为什么贴得起（出处） | 把握度 |
|---|---|---|---|
| 教育／学习 | Education / Learning | 整个产品的定位句 | 高 |
| 自托管 | Self-Hosted | README §部署形态；`DEPLOY.md` | 高 |
| 开源 | Open Source / MIT | `LICENSE` | 高 |
| AI／LLM 工具 | AI / LLM | OpenAI 兼容 + Anthropic 双适配（README §配置说明） | 高 |
| 间隔重复／SRS | Spaced Repetition / SRS | `EBBINGHAUS-SPEC.md`，7 个节点 1/2/4/…/60 天 | 高 |
| 本地优先 | Local-first | 同一份代码的本地单机形态；页脚 `FOOT` 那句 | 高 |
| ~~记忆／笔记~~ | ~~Memory / Notes~~ | ⚰️ **2026-09-25 收成「记忆」**：刷题笔记功能整族下线（issue #21），现只剩**词条库 + 跨会话画像**——对外填表别再写 Notes，那会被当成有笔记产品 | 高（记忆那一半） |
| ~~知识图谱~~ | ~~Knowledge Graph~~ | ⚰️ **2026-09-25 作废（批次 K）**：知识图页与 `knowledge_node`/`knowledge_edge` 已随学习流整族下线删除（迁移 v44）——**对外清单别再贴这个标签**，产品现在没有可看的图。（原文：知识图页（`STUDY-FLOW-SPEC.md`；★ 是**数据图**不是图库那类图，措辞别拔到 "graph database"）） | — |
| ~~Anki 替代~~ | — | **不贴**：与 Anki／Mochi 无任何实测对比，贴了就是碰瓷；表单强制要 "alternatives" 时填**同类产品名**而不是「比它们好」 | — |
| ~~多模态~~ | — | **不贴**：出题配图是模型产 SVG，图片输入未做逐模型实测 | — |

---

## 5. 隐私与安全口径（本包最硬的一节：十条全部当场可验）

> 用法：**只抄「可粘贴正文」栏**。右边的「复验」列是给我们自己看的——任何人质疑，当场跑那条命令。

| # | 可粘贴正文 | 复验方式 | 把握度 |
|---|---|---|---|
| 1 | 整站只有一枚会话 cookie：`HttpOnly` ＋ `SameSite=Lax` ＋（HTTPS 部署下）`Secure`；没有第三方广告／追踪 cookie。 | `packages/server/src/auth/middleware.ts` 的 `sessionCookieOptions`；`curl -sI https://11wand.com/` 响应无 `Set-Cookie`（09-24 现读） | 高 |
| 2 | 访问统计是**同域自托管的 GoatCounter**，其脚本响应不下发 cookie。 | `curl -s -D - -o /dev/null https://11wand.com/stats/count.js \| grep -i set-cookie` → 空（09-24 实测）；脚本挂载见 `packages/web/index.html` | 中（★ 统计服务端如何聚合是 GoatCounter 的实现，不由本仓代码担保） |
| 3 | 我们自己的访客计数**不落裸 IP**：桶是 `sha256(盐+IP)` 前 16 位，同一来源同一自然日只算一次。 | `packages/server/src/growth/counters.ts:80` ＋ 迁移 v41（盐由 `randomblob` 现生成存库）；`GROWTH-SPEC.md` §2 | 高 |
| 4 | 数据是一个 **SQLite 单文件**，备份＝拷一个目录；跑在自己的服务器上就是**物理意义上的数据自持**。 | `SB_DATA_DIR` 与 `studentbuddy.db`（README §配置说明） | 高 |
| 5 | ★ **必须主动说**：提问内容要发给模型服务商才能得到回答——用自带 Key 时发给你配置的那家；用官方免费通道时发给平台配置的 upstream。我们不拿你的对话做训练。 | 服务商可配（README §配置说明）；免费通道的两路 upstream 域名 README「已知限制」里已公开写；「不拿对话训练」这句**是我们的承诺不是代码性质**，措辞要按承诺说 | 高（前半）／中（后半＝承诺） |
| 6 | 模型 API Key **AES-GCM 加密入库、永不出接口**（接口响应只回布尔）。 | README §安全与隐私设计；`security.ts` | 高 |
| 7 | 会话令牌库里**只存 `SHA-256(token)`**，脱库拿不到可用会话；口令用 `scrypt` 派生、参数随哈希自描述。 | README §安全；`auth/password`、`auth/session` | 高 |
| 8 | 跨用户数据互不可见（多租户归属按读／写两把过滤），越权访问一律 404 不回 403。 | `TENANCY-SPEC.md` §8 ＋ 逐批跨用户隔离锁 | 高 |
| 9 | 无广告、无付费档、无内购；MIT 开源，可自行审计与二次分发。 | 全仓无计费代码（09-24 现查 grep）；`LICENSE` | 高 |
| 10 | ⚠️ **自助注销与数据导出目前未做**：删账号要联系维护者。共享体验池的内容全站可见，所以应用内两处（中／英）都写明「请勿输入个人信息」。 | 实测：`packages/server/src/routes/auth.ts` 只有 register／login／logout／me／send-code／login-by-code／demo-login，**无删除路由**；警示文案 `landing-copy.ts` 的 `DEMO_BTN.warn` | 高 |

### 5.1 三条「不许说」（说了就是新造事实，被懂行的人一戳就塌）

| 不许说 | 为什么 | 事实该怎么写 |
|---|---|---|
| 「端到端加密」「零知识」 | 没有任何 E2E 实现；除 provider key 外数据在库里是明文 | 说「密钥加密入库、会话令牌只存哈希」这一层就够，且都是真的 |
| 「GDPR 合规」「符合 XX 法规」 | 没有隐私政策页（§1 末行实测返壳）、没有 DPA、没有数据处理者清单；「不发追踪 cookie」≠ 合规 | 说「设计上不依赖 cookie 追踪、数据可自托管」，合规判定交给律师 |
| 「你的数据 100% 不离开你的设备」 | 只有本地／自托管形态成立；用 11wand.com 时数据在我们那台 VPS 上，且第 5 条那次外发无论哪个形态都存在 | 分形态说：「自托管＝数据在你手里；用官方实例＝数据在我们自己的单台服务器上，AI 调用会发给你选的模型服务商」 |

---

## 6. 截图与素材清单

### 6.1 现成可用（在册 6 张，全部真机截图、已提交在仓内。★ 2026-09-25 批次 K 逐行复核：**1 张作废（学习流）、1 张待重拍（侧栏已从八项变六项）** ⇒ 现在真能对外用的 4 张。★ **2026-09-26 本题库断线批逐行重数（口径：6 张文件都在 `docs/images/`，按「有没有前提」分档）**：⚰️ **1 张作废**（`app-study-flow.png`）＋ ⚠️ **2 张带前提**（`app-chat.png` 侧栏已从「六项」变**三项**、`landing-hero.png` 演示窗演的动作已不存在）⇒ **无前提能直接对外的是 3 张**（settings／app-pk／landing-pk）。上一条 09-25 的「六项／4 张」是**当时的账**，未回改，留着作沿革）

| 文件 | 尺寸 | 内容 | 用于 |
|---|---|---|---|
| `docs/images/landing-hero.png` | 1440×900 | 落地页首屏（品牌牌 + 知识图演示窗） | 首图／封面（★ 但对外首图更推荐 `packages/web/public/og/home.png` 1200×630，清单站缩图友好）。⚠️ **2026-09-25 批次 K：画面里那个演示窗现在演的是一个产品里已不存在的动作**（知识图＋追问自动连边已下线，hero 只是还没换）⇒ **换掉 hero 之前别拿它当"产品现在长这样"的证据** |
| `docs/images/app-chat.png` | 1440×900 | 应用壳·对话（八视图侧栏 + 督促胶囊） | **主截图第 1 张**（一眼看得出是产品）。⚠️ **待重拍**：侧栏导航项 **2026-09-26 起只剩三项**（`packages/web/src/app/nav.ts:27` 现查＝对战／词条／设置，对话由 logo 承担），这张图里的八项已是三个批代之前的旧壳 |
| ~~`docs/images/app-study-flow.png`~~ | ~~1440×1000~~ | ⚰️ **2026-09-25 作废（批次 K）**：学习流编排（SVG 画布 + 步骤面板）——**功能与页面都已删除**。图片文件仍留在 `docs/images/`（本仓"作废留登记不静默删"的规矩），但**对外一律不得提交**：那是一张不存在功能的截图 | — |
| `docs/images/app-settings.png` | 1440×1180 | 设置·一键默认绑定模型角色 | 主截图第 3 张（差异化：自带 Key／BYOK 一眼可见） |
| `docs/images/app-pk.png` | 1440×900 | 对战大厅（移动优先独立页） | 备选（讲「对战」才用） |
| `docs/images/landing-pk.png` | 1440×900 | 落地页对战双屏节 | 备选 |

⚠️ **这三条前提要如实带着**：
1. 6 张拍的是**本地单机形态**、日期 2026-09-21（`ls -l docs/images` 可证），不是线上那台的截图；
2. 采集时**零演示数据、不调任何模型 ⇒ 空态就是空态**（没有为了好看摆拍）——好处是可复现，代价是**画面里没有词条库内容**，讲「词条是主体」时说服力打折；
3. 截图里是中文界面（§1 语言那格同样口径）。

### 6.2 缺口（要补的 4 张，按性价比排序）

| # | 缺哪张 | 为什么非补不可 | 怎么拍（口径） |
|---|---|---|---|
| 1 | **词条页有内容的一屏**（词条列表 + 复习时钟队列） | §2 三条简介全部主打「词条是主体」，而素材里没有它 ⇒ 货不对板 | 本地形态 + `SB_DATA_DIR` 指临时目录（干净池必灌 8 条种子），走对话页存入词条后截 |
| 2 | **一张手机竖屏**（≤720px） | 清单站访客一半在手机上看图；本包现在六张全是桌面 | 桌面形态窄口或浏览器设备仿真截，★ 但要先自查窄口下有没有溢出（见 §7 那张卡） |
| 3 | **出题判分那一屏**（题卡 + 对错回显） | 「练／析」是闭环的两环，现在无图 | 本地形态，★ 会真烧模型额度 ⇒ 用平台免费通道或自带 key，拍完如实记是哪档模型 |
| 4 | 一张浅色／深色主题各一份的对照 | 有主题偏好的站会问；现在只有默认主题 | 设置页切主题后截 |

★ **补拍一律在本机做，不许用浏览器自动化打 11wand.com**（总口径：探针流量不许污染真人计数，且线上端口 18791／5173 不许扰动）。可参考仓内 `tools/probes/landing-demo-cdp.mjs` 的做法（它把运行形态改成 cloud 才进得去落地页）。

---

## 7. 逐平台卡（提交动作＝老板本人）

> ⚠️ **诚实标注**：各家**表单到底要哪几个字段，本会话没能实测**——本机网络抓不到这些站的提交页正文（09-24 试过，只拿到页面标题级内容）。
> 所以下面每张卡只写「我们手上哪节资产对得上哪类字段」，**字段名以你打开的提交页为准**，不要按本卡猜。
> ★ 提交完请回到 §8 登记一行：C7 的验收判据就是「提交列表成文」。

### 7.1 selfh.st（自托管清单，最对口）
- 对口资产：§1 全部（尤其「形态」「许可证」）＋ §3c 英文档 ＋ §5 第 1／2／3／4 条 ＋ §6 前 3 张。
- **它大概率会问的字段与我们的真实答案**：`Docker` ⇒ 仓内有 `Dockerfile`／`docker-compose.yml`，但**从未实机跑通**（README §已知限制明写，`docker-compose.yml` 还挂着一个仓内不存在的 `Caddyfile`）⇒ **答「有文件、未验证」，别答「支持」**；`Reverse proxy` ⇒ 现网用 Caddy；`ARM` ⇒ 未测；`SaaS` ⇒ 有（11wand.com）。
- 提交前唯一要先决定的事：把它登记成「学习类」还是「笔记／知识管理类」（影响它出现在哪个列表页）。

### 7.2 AlternativeTo（同类替代清单）
- 对口资产：§1（含「价格＝Free/Open Source」）＋ §2 英文 A ＋ §4 标签（Education／Self-Hosted／Open Source）＋ §6 首图。
- ★ 这类站的机制是「你是哪几个产品的替代」⇒ 可以列**同类产品名**（Anki／Mochi／Quizlet／Notion 之类）作为「被替代项」，**但不许带任何优劣断言**（§4 那条划线就是为这一步守的）。
- 要现填：平台归属（Web／Windows／Linux…）。真实答案：Web ＋ 任何能跑 Node 22 的系统；**没有原生 app**。

### 7.3 Product Hunt（发布式，一次性的声量）
- 对口资产：§2 英文 tagline ＋ §3c 当 maker comment 的骨架 ＋ §6 图集（★ PH 图集 6 张为佳 ⇒ 用 §6.1 的 6 张刚好凑满，但要接受 §6.1 那三条前提）。
- ⚠️ **发布前要想清楚的两件事**（不是文案问题，是应答问题）：① 「AI 免费吗」→ 按 §5 第 5 条答，且**「免注册体验」与「有并发上限的免费通道」两句话要一起说**；② 「谁在做」→ 一个人（§1 维护者那格）。PH 的评论区会把含糊处逐条问出来。
- 时机建议（★ 中把握度，判据是「有东西可看」而不是「有帖子可发」）：等 §6.2 缺口 1／2 补上，且 C9（站长平台 sitemap 手动提交）由老板做完再发——否则首波访客里想看词条页的那批会落到只有 12+2 个中文页面的公开面。

### 7.4 中文自托管／效率工具导航站
- 对口资产：§2 中文 A ＋ §3a／§3b ＋ §5（中文十条）＋ §6 前 3 张。
- ⚠️ 候选清单**本包不给**（没实测过哪些站还活着、还收投稿）。要的话由老板点名，我再逐站读提交页并把字段对成本包 §1–§5。

---

## 8. 提交登记（★ C7 的验收判据就是这张表被填上）

| 提交日 | 平台 | 用了哪节资产 | 我们的条目链接 | 状态 | 来源分布里出现该域名了吗（Caddy 日志，按 §排除清单剔探针） |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

⚠️ 最后一列的取数口径沿用 `GROWTH-CHANNELS.md` §3：**先剔 `studentbuddy-probe`／`curl/`／自家测试号**，否则第一条数据就是我们自己造的。

---

## 9. 已知代价与未做（诚实账）

| # | 代价／未做 | 说明 |
|---|---|---|
| 1 | 平台字段规格未实测 | 本机网络抓不到 selfh.st／AlternativeTo／PH 的提交页正文 ⇒ §7 只给「资产 ↔ 字段类型」的对应，不给字段名。这是**能力边界不是偷懒**，老板提交时以页面为准 |
| 2 | 没有隐私政策页与服务条款页 | §1 末行实测。清单站多数不强制，但 PH 这类站可能被问；要补就是**一次真批次**（可复用 C1 的构建期静态页机制，与 C8 同一族） |
| 3 | 素材缺「词条有内容」那一屏 | §6.2 缺口 1；这是本包文案主打点的配图，**当前是最不像的一句** |
| 4 | 全桌面宽截图、零手机截图 | §6.2 缺口 2 |
| 5 | 「不拿对话训练」是承诺不是代码性质 | §5 第 5 条已这样标；若要变成可审计事实，需要在本地形态文档里明写「你自己跑就 100% 在你手里」 |
| 6 | 本包是**一次性资产不是产品能力** | 按 §0 总口径第 1 条，「做能力」应做进产品——C7 的产品侧只到「文案与截图有权威出处」为止；真正做进产品的是 C8（公开更新页）与隐私页（未立项）。★ §0.14 一问「三个月后这文件会被删掉吗」：不会，但**它会被 §2 的文案搬进产品「关于」页**——那才是它的去处 |

---

## 10. 维护口径

1. **本节以外的任何一处改了公开文案（README／`landing-copy.ts`／`landing-data.ts`／`index.html` 的 og 块），回来对账 §2／§3／§5**，别出现「站内说 A、提交页说 B」。
2. 数字类字段（测试数、依赖数、接口数）**一律现读 `node tools/metrics.mjs` 再抄**，本包不养旧数字（§1 那两格已标「抄之前现读」）。
3. §8 那张表**只有老板填**（提交动作是他的），AI 侧代登记须带来源凭据（链接或截图），不许凭对话记忆写「提交过了」。
4. 加新平台＝在 §7 加一张卡，同时回 `GROWTH-CHANNELS.md` C7 那行注一句，**不在别处另建一份提交文案**。
