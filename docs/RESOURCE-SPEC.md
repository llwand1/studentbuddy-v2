# 学习资源现场搜集契约（RESOURCE-SPEC）

> ## ⚰️ 状态：**人工入口已下线（墓碑）** — 2026-09-26，本契约的「两段确认入库」那半闭环不再存在
>
> ★ **一句话（哪半死、哪半活）**：死的是**闭环⑤⑥**——题库页那块「搜集题目」面板
>   （`CollectPanel.tsx` + `collect-view.ts`）、两条端点 `POST /api/quiz/collect/{preview,commit}`、
>   以及 `saveQuiz(quiz,'collect')` 这一步（**搜集产物自此不落库**）。
>   ★ **活着的是闭环①~④**：`learning/collect.ts` 的 `collectQuiz`（派生搜集词 → 复用 `searchWeb` →
>   `fetchSafe` 逐页抓 → 模型**逐字摘录** → verbatim 锚点锁）**一行未改**，现在是混合出题
>   `learning/quiz-blend.ts:147` 的真题侧，有 `learning/collect.test.ts` 钉着。
>   ⇒ 本契约「**摘录不是创作**」这条分界线与「verbatim 锚点锁：宁漏真题不误收编题」的取舍**仍是现役准绳**；
>   只有「preview/commit 两段人工确认才入库」不再是事实。⚠️ 文中「题库页『搜集题目』」等 UI 口径同理。
>
> **为什么删（老板判决逐字，2026-09-26）**：「studentbuddy的题库功能也去删了,现在只要剩下内核和对战以及词条」；规划轮选档 B「整族断线」。
>   判据＝这条腿单独没人用它：它服务的是已下线的题库页，而**出题**这条主链走的是另一台引擎。
>
> **本批零迁移（判决＝本批不碰表）**：`quiz_bank` 留库等独立的删除型迁移逐次点名（与 `quiz_stats`／`quiz_notes` 并批）。
>
> **被这条牵连的资产（同批改）**：
>  · `components/OnlineToggle.tsx`（+ `.css`）——★ 它其实**早就零消费者**（唯一调用方就是题库页那行），随批删除；
>  · `normalizeCollectedQuiz`（commit 那步「不信客户端」的复校验）自此**零生产调用方**，只剩测试在钉
>    ⇒ 本批现查新增的尾巴 ⑤，挂 issue #32 不修；
>  · `docs/QUIZ-BLEND-SPEC.md` 的「混装**入库**、`quiz_bank.source = 'blend'`」失去落点（合流本身仍在，只是不落库）；
>  · 专属真机探针 `tools/probes/quiz-e2e-cdp.mjs` 随族删除（真点的是已下线的「题库」nav）。
>
> **回收路径**：锚点锁与 preview/commit 两段的实现留在 git 历史
>   （`git show a087e67^:packages/web/src/features/quiz/CollectPanel.tsx`）；
>   若将来给「真题库」重做入口，**本契约的六步闭环与四条硬约束可原样复用**，缺的只是 UI 与落库那两步。
>
> 版本：**v0.3（批1 已落地 · 批2「出题合流」已另立 `docs/QUIZ-BLEND-SPEC.md`）** | 状态：[契约生效·批1交付待验] | 更新：2026-09-20
> 定位：**给 studentbuddy 装"现场搜集"这条腿**——用户在学习时，产品自己完成
> 「检索 → 抓页 → AI 摘题/摘要 → 预览确认 → 入库」的运行时闭环，
> 让真实题源与 AI 出题结合，而不是全靠模型即兴编题（ADR-1 服务学习闭环）。
> 先立契约再改码（AGENTS.md「已知约束」：超出既有能力预算必须先改契约）。
> 上游契约：`docs/QUIZ-SEARCH-SPEC.md`（检索词派生/来源标注先例）、
> `docs/TOOL-ECOSYSTEM-SPEC.md` §结果治理（★ **外部结果永不直接写库**——本契约的确认闸门由此继承）。

> **本契约的存在理由（一句话）**：现状题目 100% 由 `generateQuiz` 产生（`routes/quiz.ts:128`
> 是唯一落库点），`searchWeb` 只给 AI 出题喂参考、从不把网上**已有的题**收回来；
> `quiz_bank.source` 列自建库起就预留了写入位（无 CHECK 约束，`migrations-list-v1-9.ts:82-88`），
> 搜集能力缺的是管道，不是 schema。

## 0 问题陈述

| 缺什么 | 后果 | 证据 |
|---|---|---|
| 无运行时搜集管道 | 用户无法把开源题集/刷题站点的真实题收进题库 | `routes/quiz.ts` 全文无 collect/import 路径 |
| `QuizQuestion.source.kind` 只有 `'web' \| 'ai'` | 即使摘到真题也无法标"搜集"出处 | `shared/content-blocks.ts:43` |
| `searchWeb` 只产"参考段" | 检索到题也不会被结构化收割，用完即弃 | `learning/quiz-search.ts:58-110` |
| 无"摘题 vs 编题"防线 | 若直接让模型"从网页出题"，它会以搜集之名继续编 | 新风险，本契约 §3.4 立锁 |

## 1 运行时闭环（本契约本体）

```
触发（题库页「搜集」／对话工具，见 D2）
  → ① 检索：searchWeb(派生搜集词)          [复用，零新检索能力]
  → ② 抓页：fetchSafe 逐 URL 单页抓取       [复用 ssrf-guard；超时自设，见 §2.3]
  → ③ 摘取：模型从页面正文【逐字摘录】题目   [routeRole('quiz-generator')]
  → ④ 校验：verbatim 锚点检查——题干必须能在原文命中，命不中即拒（防"以搜代编"）
  → ⑤ 预览：两段式 preview/commit，逐题带来源链接 + 逐题拒绝真因（ADR-5）
  → ⑥ 入库：saveQuiz(quiz, 'collect')，quiz_stats/判分全链路自动接住（★ 原清单里的「笔记」一环随刷题笔记功能于 2026-09-25 下线，issue #21）
```

**「摘录不是创作」是本契约与 QUIZ-SEARCH 的分界线**：QUIZ-SEARCH 用检索结果**启发 AI 出题**；
本契约用检索结果**收割网上已存在的题**，模型只当结构化解析器，§3.4 的 verbatim 锁负责证明这一点。

## 2 硬约束（决定方案形状）

1. **外部结果永不直接写库**（TOOL-ECOSYSTEM §结果治理 先例）：⑤ 预览确认是人机界面必经步骤，
   对话工具入口（D2 批2）也只准返回候选块，「选题库」按钮才 commit。
   ★ **2026-09-20 定向破例（老板拍板，见 `docs/QUIZ-BLEND-SPEC.md` §1 D1）**：**出题合流**场景
   ——用户在设置页按题型配了「真题几道」，则该批真题经 `verbatimHit` 逐字锚点 +
   `checkCollectable` 可判分**两道机验通过后直接进题组**，**不走** ⑤ 的人工勾选。
   破例的代价与对冲已在 `QUIZ-BLEND-SPEC.md` §8 逐条记账（verbatim 成为唯一防线 ⇒ 真题剂量收紧到
   单题型 ≤5 ＋ 强制携带 `source.url` 可回查 ＋ 由题库侧「事后可剔除单题」接住误收）。
   **破例范围严格限定在此场景**：`/api/quiz/collect/preview` → `/api/quiz/collect/commit`
   这条独立搜集入口的确认闸门**原样保留**，一行未放松。
2. **单页、不遍历**：只抓 ① 返回的 URL（每源 top `MAX_PAGES=3`，常量可调），
   不追站内链接、不登录、不绕反爬、UA 不改装——搜集＝用户指名意图的延伸，不是建爬虫。
3. **出网全部经 `fetchSafe`**，且本批给页抓**自设超时 15s**（★ 现状"单工具超时未设"是
   TOOL-ECOSYSTEM:383 已记账风险，本契约新管子不得扩大它）。
4. **版权口径**：单人本地工具、用户主动指意的个人学习用途；来源 URL + 页面标题随题落库
   （`source {kind:'collect', title, url}`），前端徽标 + 链接可回源页——署名与可追溯是硬要求。
5. **纯加法**：`QuizQuestion.source.kind` 并集追加 `'collect'`；`quiz_bank.source` 新写入值
   `'collect'`（无 CHECK，零迁移）；若资源清单（D3）需要新表才动迁移，**只准追加
   `migrations-list-v22.ts` 尾部**（现最高 v28 → v29）。
6. **门禁**：搜集域层独立新文件 `learning/collect.ts`（≤400 行），不挤 `quiz.ts`；
   解析/校验层纯函数化以便单测。

## 3 契约内容

### 3.1 数据结构（@sb/shared，纯加法）

```ts
type CollectCandidate = { question: QuizQuestion; ok: boolean; reason?: string };
interface CollectReport {
  on: true;
  queries: string[];               // 实际用的搜集词（派生结果如实回显）
  providers: string[]; failed: string[];   // 检索层，沿用 QuizSearchReport 口径
  pages: { url: string; title: string; fetched: boolean; reason?: string }[]; // 逐页记账
  total: number; accepted: number; rejected: number;
  rejectedList: { n: number; reason: string }[];        // 1 基，含 verbatim 未命中
}
// QuizQuestion.source.kind: 'web' | 'ai' → 追加 'collect'
```

### 3.2 搜集词派生（quiz-search 同款三规则）

主题 → `{主题} 练习题 及答案` / `{主题} 题库` / `{主题} 历年真题`（占位主题表沿用
`quiz-search.ts:32`）；前端如实回显派生结果——用户看见搜了什么（ADR-5）。
> ★ 批1 落地偏差（2026-09-18 回填）：实装 **2 条**搜集词（`{主题} 练习题 答案`＋`{主题} 题库`，
> `buildCollectQueries`，主题钳 100 字）——第三条「历年真题」刻意未上：三条并列会更容易命中
> 整卷下载站（内容农场重灾区，§11 死因的前排），先按两条跑真人使用再定要不要加。

### 3.3 模型摘题提示词协议

- 输入：页面正文截断（复用 `MAX_DOC_CHARS` 口径）+ 题目 JSON 协议（复用 `QUIZ_PROTOCOL` 四字段）；
- 硬令：**只准摘录原文中存在的题**；每题附「题干前 20 字锚点」；不得补全网上没有的选项；
- 输出：`QuizQuestion[] + anchors`；温度 0.2（比出题 0.4 更低——解析者不该有创造力）。

### 3.4 verbatim 锚点锁（本契约的核心不变量）

`normalizeForAnchor(s)`（去空白/全半角标点）后，题干锚点必须在对应页原文中 `includes` 命中；
未命中 → `ok:false, reason:'疑似非原文题目'`。
**已知误杀面（如实记账）**：SPA 页正文抓不全、图片题、公式转义——这些整页/整题被拒并报因，
**不放水**：宁漏真题，不误收编题（对齐 choice-nudge「宁可漏不可误」红线）。

### 3.5 接口与前端

| 端点 | 行为 |
|---|---|
| `POST /api/quiz/collect/preview` | `{topic, material?}` → `CollectReport + candidates[]`，**不落库**，SSE 推进度（复用 chat 频道模式另议，首版同步 + 前端 loading 三态） |
| `POST /api/quiz/collect/commit` | 勾选后的 `QuizQuestion[]` → `saveQuiz(quiz,'collect')`，回 `quizId` |

题库页新增「搜集」入口 → 预览表（通过/拒绝两态、逐题来源链接、逐页抓取结果）→ 确认入库。
题库列表徽标三分：AI / 情景 / **搜集**。

## 4 拍板点（待老板逐条批复）

| # | 决策点 | 推荐 | 备选/排除 |
|---|---|---|---|
| D1 | 锚点锁严格度 | ✅ **默认采纳 2026-09-18：严格版已实现**（批1 按 §3.4 落地，误杀率待 §10 T3/真人使用后判） | 无锁直接信模型＝放弃本契约存在理由，排除 |
| D2 | 触发入口分期 | ✅ **已批 2026-09-18：题库页先行**——批1 只做题库页专用入口；对话工具（返回候选块，写库仍走 commit）放批2 | 两入口同批：排除（R1 避让 tools.ts + 对话大候选表体验差） |
| D3 | 「资源」要不要也收 | ✅ **已批 2026-09-18：两段式**——批1 只收题；批2 加「资源清单」（开源教材/课程/笔记链接 → 新表 `resource_shelf`，v29 迁移），复用同一条 ①②③ 管线的第 ①② 步 | 同批做＝战线拉长，题与资源的确认界面完全不同 |
| D4 | 源域注册表 | 首版**不设白名单**（用户指意搜索的返回域即授权域）；观测到垃圾域扎堆再按 search provider 维度加排除表 | 预置白名单会把"能力"做成"几个源的功能"，违背通用性原则 |

## 5 改动范围（批1，逐文件）

| 文件 | 动作 | 批1 落地实况（2026-09-18 实测回填） |
|---|---|---|
| `packages/shared/src/content-blocks.ts` | `Collect*` 类型 + `source.kind` 并集（纯加法） | ✅ 328 行：`CollectPageRecord`/`CollectCandidate`/`CollectReport`+`emptyCollectReport()`；`source.kind` 追加 `'collect'` |
| `packages/server/src/learning/collect.ts` | **新建**：①~④ 全管道（≤400 行，含 verbatim 锁纯函数） | ✅ 新建 292 行（含 `verbatimHit`/`normalizeForAnchor`/`checkCollectable`/`COLLECT_PROTOCOL`/`collectQuiz`/`normalizeCollectedQuiz`）+ 测试 24 例 |
| `packages/server/src/routes/quiz.ts` | 挂 preview/commit 两薄端点 | ✅ 208→**254** 行（+46，两枚端点 + `no-model` 真因映射）+ 路由测试 8 例 |
| `packages/web/src/features/quiz/CollectDialog.tsx` + css | **新建** 预览确认界面 | ✅ 定名 **`CollectPanel.tsx`**（154 行）+ `collect-view.ts` 纯函数层（28 行，测试 6 例）+ `quiz.css` 追加 `.collect-*` 整套 |
| `packages/web/src/features/quiz/QuizBankPage.tsx` | 入口按钮 + 「搜集」徽标 | ✅ 261 行：「搜集题目/收起搜集」按钮 + 面板挂载 + 入库回执写进既有 `note` 通道（不新开文案口）；列表徽标**未做**——`source` 列本就原样显示 `collect`，三分徽标留待真人验收后看是否值得加 |

**开工前待核实现状（已核实，2026-09-18 回填）**：① HTML→正文提取件 **存在**——`search/index.ts` 的 `htmlToText`（脚本/样式剥离 + 实体还原 + 空白归一），本批转 `export` 复用，`collect.ts` **未**自带剥离器（零新依赖兑现）；② 行数实测见上表，全部在门禁红线内。

## 6 门禁与行数预算

| 文件 | 现 | 预计 | 门禁 |
|---|---|---|---|
| `collect.ts` | 0 | ~300 | 400 |
| `routes/quiz.ts` | 实测后填 | +≤50 | 400 |
| `QuizBankPage.tsx` | 实测后填 | +≤30 | 300 |
| `CollectDialog.tsx` | 0 | ~250 | 300 |

## 7 测试计划（三件套，新测试文件须登记 `docs/dev/test-plan.md`）

| # | 层 | 测什么 |
|---|---|---|
| T1 | 纯函数 | 锚点 normalize/命中判定（含误杀样本锁：改写一个词的题必须被拒）/ 搜集词派生 / 页截断 |
| T2 | server 路由 | preview 不落库锁；commit 只收 `ok:true`；`source='collect'` 列表透传；fake 上游离线跑全管道（复用 `fake-provider.mjs` 生态，**不碰真库真网**） |
| T3 | 真机探针 | 隔离实例（`_probe/data-*` + 18797~18801）真搜真摘一个开放题集页，截图入 `tools/probes/`；**逐页可达率实测数字回填 §10** |

## 8 失败与降级（ADR-4/ADR-5）

检索全挂 → `CollectReport.failed` 如实列源，界面说"一条没搜到 + 为什么"；
某页抓不到/超时 → 逐页记账跳过，不毁整批；模型全摘废 → 200 + 全拒报告；
preview 成功 commit 前用户关窗 → 无副作用（这就是两段式的理由）。

## 9 本次不做（显式划界）

- 站内遍历/分页抓取/登录态站点；
- `.apkg`、PDF、图片题解析（模型可摘网页，不啃二进制——要啃另立契约且破零依赖需拍板）;
- ~~自动配比（AI 题与搜集题混套）~~ → **2026-09-20 撤销该划界，已另立 `docs/QUIZ-BLEND-SPEC.md` 实现**
  （老板点单：「选择从网络上搜集真实的题目，并且可以调节真实题目和 ai 出题的配比」）；
- 跨库去重（**仍未做**，由上一条契约继承）；
- 资源清单 shelf（D3 批2）；
- 任何默认开启的后台定时搜集。

## 10 状态与验证

- ✅ **批1 已落地（v0.2.57，2026-09-18）**：D1~D4 批复/默认采纳齐（见 §4），代码+测试+文档同批——
  T1/T2 全交付（`learning/collect.test.ts` 24 + `routes/collect.test.ts` 8 + `collect-view.test.ts` 6，
  全量 vitest 1742 例绿、gates 全绿，明细见 `CHANGELOG.md` 18:08 行与 `test-plan.md` §3）。
- ⬜ **T3 真机探针未跑**（须在隔离实例 18797–18801 + `_probe/data-*`，不写生产库）。
- 未验边界（诚实记账，不得当已验收）：
  - [ ] 开放题集页面的**正文可达率**未实测（T3 出数前，D1 严格度是假设不是结论）；
  - [x] server 侧 HTML→正文提取件已核——复用 `search/index.ts#htmlToText`（§5 回填）；
  - [ ] 预览表观感与入口位置（判定权在老板，**MT-01 真人测试单已派**，见 `docs/dev/manual-test.md`）；
  - ⚰️ ~~[ ] 薄弱点分析/深度理解对无 `explanation` 搜集题的行为未实测。~~ ★ **2026-09-26 就地作废：这一格永远不会再被测了**——薄弱点分析随题库整族下线（issue #32），深度理解更早（issue #27）。原句留着不删，是为了记「这两件没实测过就死了」。

## 11 §0.14 三个月删除测试

最可能死因：**搜到的多是内容农场**——检索层管不了返回域质量，摘出来的题残缺错版，
用户被垃圾题坑两次就不用了。对冲：逐题来源可回查（§2.4）＋预览必经人工确认＋
D4 预留排除表路径；若真实使用中误收率高到确认界面成为负担，死掉的应是 D2 对话入口
与 D4 无白名单决策，锚点管道本体（纯加法）可整体摘除不伤既有功能。

★ **2026-09-20 追加（合流场景，见 `docs/QUIZ-BLEND-SPEC.md`）**：上面那句「预览必经人工确认」
这条对冲**在出题合流路径上不再成立**——该路径按老板拍板 D1 自动进组（§2 硬约束①的破例说明）。
于是合流路径的失效面**前移**到 verbatim 锁的严格度上，而该严格度的真机可达率**至今未实测**
（§10 T3 欠账仍在）。对冲相应改成四条：① 真题剂量收紧到单题型 ≤5；② UI 强制显示
「真题 N/M，未用 AI 顶替」＋逐页报告；③ 真题必带 `source.url`；④ 题库侧可剔除单题（事后可恢复）。
**若 T3 实测可达率过低（如 <20%），合流会表现为「真题永远摘不到」**——彼时应回退的是合流的
**自动进组**决策（D1，改回人工确认或降剂量），而**不是**锚点管道本体（纯加法，可整体摘除）。

## 12 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-18 | v0.1 | 草案首立（方向＝文件导入 + 题源调研），已废——见下 |
| 2026-09-18 | v0.2 | **方向改判**（老板原话：「我不是想要你来搜集，而是给 studentbuddyv2 这个能力，让他能做到现场搜集」）：主线改为运行时搜集闭环（检索→抓页→摘题→verbatim 锁→确认→入库），文件导入降级为 §9 不做外的备选路；v0.1 的拍板表 D1~D4 全部作废重写。§8 题源候选表删除——产品自己现场搜，预置清单不再是方案本体 |
| 2026-09-18 | v0.2 批1 落地 | **状态 草案→批1 已落地（v0.2.57）**：§4 D1/D4 默认采纳注记；§5 逐文件回填实况（含 `CollectDialog` 定名为 `CollectPanel`、提取件核实复用 `htmlToText`）；§3.2 回填"实装 2 条搜集词"偏差及理由；§10 刷 T1/T2 已交付、T3 与 MT-01 待验。零新表零迁移兑现（`quiz_bank.source='collect'` 直落） |
| 2026-09-20 | v0.3 | **撤销 §9「自动配比」划界 ＋ 对 §2 硬约束① 做定向破例**：出题**合流**场景（用户按题型分配合几道真题）下，真题经 verbatim ＋ 可判分两道机验通过即入题组，不走人工勾选——破例范围（仅此场景，独立搜集入口的闸门原样保留）、代价与四条对冲逐条记在 §2 与 §11；实现契约另立 `docs/QUIZ-BLEND-SPEC.md`。**本文件本次未改任何代码路径** |
