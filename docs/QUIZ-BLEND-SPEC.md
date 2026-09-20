# 出题来源合流契约（QUIZ-BLEND-SPEC）

> 版本：**v1.0（已实现）** | 状态：[已落地·shared 28 + server 31 + web 4 例全绿] | 更新：2026-09-20
> 定位：把既有的**两条出题管道**在配比层合流——用户按题型分别指定「AI 出几道 / 真题几道」，
> 一次出题同时产出两种来源的题，**混装成一个题组**入库。
> 先立契约再改码（AGENTS.md「已知约束」：超出既有能力预算必须先改契约）。
> 上游契约：`docs/RESOURCE-SPEC.md`（真题搜集管道——本契约**消费**它，不重造）、
> `docs/QUIZ-SEARCH-SPEC.md`（联网参考段先例）、`docs/TENANCY-SPEC.md` §8.2（`app_settings` 归主）。

> **本契约的存在理由（一句话）**：`RESOURCE-SPEC.md §9「本次不做」`白纸黑字划界的
> **「自动配比（AI 题与搜集题混套）」**——搜集管道批1 已落地（检索→抓页→摘题→verbatim 锁→
> 人工勾选入库），但它与 AI 出题是**两条互不相通的管道**：想"这套题里一半真题一半 AI"，
> 用户得出两次再手工拼，且真题那半必须逐题勾选。本契约补齐的就是这一层。

## 0 问题陈述

| 缺什么 | 后果 | 证据（行号实测 2026-09-20） |
|---|---|---|
| 两条管道无合流点 | 一次出题只能产单来源题组 | `routes/quiz.ts:108`（只调 `generateQuiz`）／`routes/quiz.ts:168`（collect 独立端点） |
| 配比只有「题型」一维 | 无法表达"单选 2 道 AI + 1 道真题" | `shared/content-blocks.ts:75` `QuizMix = Record<QuizMixKind, number>` |
| 真题进组必经人工勾选 | 出题流程无法无人值守混入真题 | `RESOURCE-SPEC §2` 硬约束①「外部结果永不直接写库」；`CollectPanel.tsx:63` |
| `quiz_bank.source` 无「混合」取值 | 库里分不出哪组含真题 | `routes/quiz.ts:132` 恒写 `'ai'`（列无 CHECK，纯加法可加 `'blend'`） |

**与 `RESOURCE-SPEC` 的分工（不得混淆）**：RESOURCE-SPEC 管「**怎么把网上的题收回来并证明它是原文**」；
本契约管「**收回来的题怎么与 AI 题拼成一个题组**」。搜集管道本契约**一行不改逻辑**，只新增调用方。

## 1 老板拍板（2026-09-20，逐条对应）

| # | 决策点 | 拍板结果 | 对既有约束的影响 |
|---|---|---|---|
| **D1** | 真题进组的人工确认闸门 | **自动进组**——真题经 verbatim 机验通过即入题组，**不走** preview/commit 人工勾选 | ★ **破 `RESOURCE-SPEC §2` 硬约束①**，必须显式记账（见 §8） |
| **D2** | 配比控件形态 | **按题型分别配 AI 道数 / 真题道数**（二维：题型 × 来源），不是一维总比例 | 改造现有题型配比卡，不新建卡 |
| **D3** | 真题没摘够时 | **报缺不补**——不 AI 补齐、不重试，如实上报"要 2 摘到 1" | 与 ADR-5「不静默」一致 |
| **D4** | 总题数上限 | **合并上限 20**——`sum(AI 题) + sum(真题) ≤ MAX_QUIZ_TOTAL` | 改变 `MAX_QUIZ_TOTAL` 语义（原只约束 AI 侧） |
| **D5** | 落库形态 | **混成一个题组**，`quiz_bank.source = 'blend'`，每题靠 `source.kind` 区分来源 | `'blend'` 为新写入值，无 CHECK 约束，零迁移 |

## 2 产品形态（设置页）

改造现有「出题题型配比」卡（`QuizMixCard.tsx`）为**双列**：

```
出题题型配比
决定每次出题各题型各来几道。真题从互联网现场搜集，逐字摘录、带出处链接；
网上摘不到的题型如实报缺，不用 AI 顶替。

                      AI 出题              网络真题
单选题          [−] 2 [+]  [·]      [−] 0 [+]  [·]
多选题          [−] 0 [+]  [·]      [−] 0 [+]  [·]
填空题          [−] 1 [+]  [·]      [−] 0 [+]  [·]
解答题          [−] 1 [+]  [·]      [−] 0 [+]  [·]
情景题          [−] 0 [+]  [·]         —（网上摘不到可玩 demo）

共 4 / 20 题（其中真题 0 题）          [保存配比]  [恢复默认]
```

三条形态约定：

1. **情景题无真题列**——情景题是整页可玩 demo，网页上不存在可摘录的同类物，列出来只会永远 0。
2. **每题型的 AI 与真题各占一个数字框**，共用现有 `−/直输/+` 交互（`QuizMixRow` 同款）。
3. **合计行同时显示总数与真题数**——`共 4 / 20 题（其中真题 2 题）`，让"上限被谁占掉"一眼可见。

## 3 契约内容

### 3.1 数据结构（`@sb/shared`，纯加法）

```ts
/** 每题型的真题道数（键与 QuizMix 同族；scenario 恒 0——网上摘不到可玩 demo） */
export type QuizSourceMix = Record<QuizMixKind, number>;

export const DEFAULT_QUIZ_SOURCE_MIX: QuizSourceMix =
  { single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 };

/** 落 app_settings 的键名（与 quiz_mix 并列；M2d 口径：owner 隔离必填） */
export const SETTING_KEY_QUIZ_SOURCE_MIX = 'quiz_source_mix';

/** 单题型真题上限：比 AI 侧 10 更紧——网上同题型可用题有限，且 collect 单次摘题上限本就 10 */
export const MAX_QUIZ_REAL_PER_TYPE = 5;

/** 归一化：与 normalizeQuizMix 同族，但**联合钳位**（见 §3.2） */
export function normalizeQuizSourceMix(input: unknown, aiMix: QuizMix): QuizSourceMix;
```

- **不合并进 `QuizMix`**：把 `Record<kind, number>` 改成 `Record<kind, {ai, real}>` 会同时打穿
  `normalizeQuizMix` / `stepQuizMix` / `setQuizMix` / `applyQuizMix` / 设置页卡 / 6 处调用点与既有测试，
  违背仓库「纯加法」纪律。两个平行结构 + 一个联合钳位函数，改动面小一个量级。
- **`QuizQuestion.source.kind` 零改动**：`'ai' | 'web' | 'collect'` 已存在（`content-blocks.ts:44`），
  `'ai'` 是现成空槽位——AI 题标 `'ai'`（现由 `generateQuiz` 不填，本契约补填），真题标 `'collect'`。

### 3.2 联合钳位（D4 的落点，本契约唯一的算法变更）

现有 `MAX_QUIZ_TOTAL = 20` 只钳 AI 侧（`normalizeQuizMix:139`、`stepQuizMix:160`、`setQuizMix:172`）。
D4 拍板合并上限后，**两侧的编辑态与落库态都必须联合计算**：

| 场景 | 规则 |
|---|---|
| 编辑态加真题 | 新上限 = `min(MAX_QUIZ_REAL_PER_TYPE, MAX_QUIZ_TOTAL - sum(aiMix) - 其他题型真题)` |
| 编辑态加 AI 题 | 现有上限基础上再减 `sum(realMix)`（AI 侧不能把真题的额度吃掉） |
| 落库归一化 | 先 `normalizeQuizMix(aiMix)`，再按剩余额度削 `realMix`；**AI 侧优先保额**（先配先得） |
| 合计 = 0 | 回退 `DEFAULT_QUIZ_MIX`（照现有 `normalizeQuizMix:147` 口径，真题侧不单独回退默认） |

**为什么 AI 侧优先保额**：AI 出题是**必定成功**的路径（模型配好就能出题），真题是**尽力而为**的路径
（摘不到就报缺）。若让真题先占额，会频繁出现"真题没摘到、AI 额度也被挤掉"的双输——用户配的题数凭空消失。

### 3.3 服务端合流编排（新文件 `learning/quiz-blend.ts`）

```
generateQuiz(aiMix)  ──┐
                       ├─→ blendQuiz(aiQuiz, realQuestions, ...) ─→ QuizPayload（混装）
collectQuiz(realMix) ──┘
```

管线（每条都**尽力而为、失败不阻断**，ADR-4）：

1. **AI 侧**：若 `mixTotal(aiMix) > 0` → 照现有 `generateQuiz(topic, material, aiMix, ...)` 出题；
   全 0 则跳过（纯真题组，不调 AI 出题模型，省一次调用）。
2. **真题侧**：若 `mixTotal(realMix) > 0` → 调 `collectQuiz(topic, report, {ownerId})`，
   取 `ok:true` 的候选，**按题型配额筛选**（每题型不超过 `realMix[type]`）。
   - ★ 复用既有管道（检索/抓页/verbatim 锁/来源回填/可判分校验全在 `collect.ts` 内），**零新检索能力**。
   - ★ 搜集提示词需带上**题型配额**（"本题型最多摘 N 道"，扩 `COLLECT_PROTOCOL` 的配额行）——
     否则模型不知道用户要的是哪类题，会按它自己的偏好全摘选择题。
3. **拼装**：AI 题在前、真题在后（来源分组，便于用户分辨）；标题沿用 AI 题标题。
4. **落库**：`saveQuiz(quiz, 'blend', ownerId)`——一个题组，一次写入。

**调用点放置（门禁红线所迫）**：`learning/quiz.ts` 实测 **375/400 行，仅剩 25 行**，
**不得**把合流逻辑塞进去。合流编排全部落在新文件 `quiz-blend.ts`；`routes/quiz.ts:108` 改调
`generateBlendedQuiz(...)`（blend 层内的薄封装），`generateQuiz` 原函数**保持可用**（PK、单测等 6 处调用点零改动）。

### 3.4 报告（D3「报缺不补」的落点，ADR-5 不静默）

```ts
interface QuizBlendReport {
  ai: QuizMixReport;                       // 复用既有报告（请求/实际/是否出齐）
  real: {
    requested: QuizSourceMix;              // 用户要的真题配额
    actual: QuizSourceMix;                 // 实际摘到的（逐题型）
    missing: { type: QuizMixKind; want: number; got: number }[];  // 只列没摘够的题型
  };
  collect: CollectReport;                  // 原样透传：搜集词/逐页抓取/逐题拒绝真因
}
```

前端文案（`mix-report.ts` 追加 `blendNote(report?)`，与 `shortfallText` 同族）：

| 情形 | 文案 |
|---|---|
| 没配真题 | `null`（不提示） |
| 真题全摘够 | 「真题：单选 2/2、填空 1/1（共 3 道，来自 2 个网页）」 |
| 部分摘不到 | 「真题：单选 1/2（少 1 道）、填空 0/1（少 1 道）——网上没摘到，未用 AI 顶替」 |
| 一条都没摘到 | 「真题：本次一道都没摘到（原因见下方逐页报告），题目全部由 AI 出」 |

**「未用 AI 顶替」必须写出来**——否则用户看到"配了 3 道真题只来 1 道"，会以为是 bug（ADR-5）。

### 3.5 前端呈现

| 位置 | 改动 |
|---|---|
| 设置页配比卡 | 双列改造（§2）；`QuizMixCard.tsx` 现 **227 行**，加真题列会触 300 红线 → **拆出 `QuizMixRow`/新 `QuizSourceRow` 到独立文件**，卡片本体只留编排 |
| 题库页 / 对话页 | 出题结果渲染 `blendNote`；真题题卡沿用既有 `source` 渲染（`QuizCard.tsx` 已有「来源：」可点击行，**零改动**） |
| 题库列表 | 徽标三分扩展为四分：AI / 情景 / 搜集 / **混合**（`source='blend'`） |

## 4 改动范围（逐文件）

| 文件 | 动作 | 现 → 预计行数 | 红线 |
|---|---|---|---|
| `docs/QUIZ-BLEND-SPEC.md` | **新建**（本文件） | 0 → ~200 | — |
| `docs/RESOURCE-SPEC.md` | §2 硬约束① 加 D1 破例记账；§9 划掉「自动配比」改指向本契约；§11 死因对冲更新 | 181 → ~195 | — |
| `shared/content-blocks.ts` | `QuizSourceMix` + `SETTING_KEY_QUIZ_SOURCE_MIX` + `MAX_QUIZ_REAL_PER_TYPE` + `normalizeQuizSourceMix` + 联合钳位的 `stepQuizMix` 重载 | 328 → ~400 | ⚠️ 400 |
| `server/src/learning/quiz-blend.ts` | **新建**：合流编排 + `generateBlendedQuiz` | 0 → ~180 | 400 |
| `server/src/learning/collect.ts` | `buildCollectQueries`/`COLLECT_PROTOCOL` 支持题型配额（纯加法，默认行为不变） | 293 → ~320 | 400 |
| `server/src/routes/quiz.ts` | `/generate` 加 `sourceMix` 入参 → 改调 blend 层；响应带 `blend` 报告 | 258 → ~300 | 400 |
| `server/src/learning/quiz.ts` | **只加不改**：AI 题回填 `source.kind='ai'`；`generateQuiz` 主体不动 | 375 → ~380 | ⚠️ 400 |
| `server/src/storage/quiz-mix.ts`（若需） | 读写 `quiz_source_mix`（照 `loadQuizMix`/`saveQuizMix` 口径） | 0 → ~60 | 400 |
| `web/src/features/settings/QuizMixCard.tsx` | 双列改造 + 拆行组件 | 227 → ~250 | 300 |
| `web/src/features/settings/QuizSourceRow.tsx` | **新建** | 0 → ~120 | 300 |
| `web/src/features/quiz/mix-report.ts` | 加 `blendNote(report?)` | ~60 → ~110 | — |
| `web/src/features/quiz/QuizBankPage.tsx` / `features/chat/ChatView.tsx` | 请求带 `sourceMix`；渲染 `blendNote` | 261/— → +20 | 300 |
| `web/src/lib/api-settings.ts` + `lib/api.ts` | `quizMix()` 同族加 `quizSourceMix()` 读写 | — | — |
| `docs/dev/test-plan.md`、`AGENTS.md`、`CHANGELOG.md` | 基线登记与同步 | — | — |

**契约先行顺序**：本文件批复 → 修 RESOURCE-SPEC 记账 → 改 shared 契约 → 服务端 → 前端 → 门禁 → 文档同步。

## 5 本契约默认决定（待老板复议，未反对即执行）

| # | 决定 | 理由 |
|---|---|---|
| E1 | 情景题无真题列 | 情景题＝可玩 demo，网页无同类物可摘，列出恒 0 只增困惑 |
| E2 | 单题型真题上限 5（AI 侧 10） | 网上同题型可用题有限；`MAX_COLLECT_QUESTIONS=10` 单次摘题上限也兜着 |
| E3 | 真题不参与 `applyQuizMix` 裁剪 | 裁剪是「模型多出了按配比裁」，真题本就按配额筛过，再裁会重复计数 |
| E4 | 不新增「摘录」专用模型角色 | 沿用 `quiz-generator`（`collect.ts:225` 现有口径），避免多一个要配的角色 |
| E5 | 真题进组后**不缓存** | 沿用 `searchWeb` 既有缓存；跨次去重不做（`RESOURCE-SPEC §9` 已划界） |
| E6 | AI 题回填 `source.kind='ai'` | 让前端徽标与统计能分来源；纯加法，历史题无此键则不渲染 |

## 6 失败与降级（ADR-4 / ADR-5）

| 层 | 失败表现 | 处置 |
|---|---|---|
| 检索全挂 | `collect.failed` 列源 | 真题 0 道，如实报「一道没摘到＋原因」，AI 题照常 |
| 抓页全挂 | `collect.pages` 逐页记账 | 同上 |
| 摘题全被 verbatim 拒 | `rejected` 计数 + 逐题真因 | 同上（这是**设计内**结果，不是 bug） |
| 某题型摘不到 | `missing[]` 有该题型 | D3 报缺不补，UI 写明「未用 AI 顶替」 |
| 模型未配 | `collect.failure='no-model'` | AI 侧同样会 no-model → 整体 502 走既有文案 |
| 真题全 0 而 AI 侧也 0（全 0 配比） | — | 照现有口径回退 `DEFAULT_QUIZ_MIX`（`normalizeQuizMix:147`） |
| collect 整体抛错 | — | 合流层 catch，`real` 记 0 + 原因，**绝不上抛 502**（真题是增益不是依赖） |

## 7 测试计划

| # | 层 | 测什么 |
|---|---|---|
| T1 | 纯函数 | `normalizeQuizSourceMix` 联合钳位（单题型上限／总上限／AI 侧优先保额／负值非数字／scenario 恒 0）；`blendNote` 四态文案 |
| T2 | server 合流 | AI+真题按题型配额拼装；真题超配额被截；真题 0 时退化为纯 AI（行为与改动前一致）；纯真题配比不调 AI 出题；collect 抛错不阻断；`source='blend'` 落库；真题不参与 `applyQuizMix` |
| T3 | server 路由 | `/generate` `sourceMix` 透传；`blend` 报告回传；`sourceMix` 省略时行为与改动前逐字一致（**向后兼容锁**） |
| T4 | 前端 | 双列卡编辑态联合钳位（加真题挤不动 AI 额度）；合计行显示"共 N 题（其中真题 M 题）" |
| T5 | 真机探针 | 隔离实例（`_probe/data-*` + 18797~18801）跑一次"2 AI + 1 真题（单选）"，截图断：真题带出处链接、`source.kind='collect'`、报缺文案正确 |

**既有测试影响面**：`shared/quiz-mix.test.ts`、`routes/quiz-mix.test.ts`、`learning/quiz.test.ts`、
`routes/quiz-search.test.ts` 需确认**零回归**（本契约对 `generateQuiz` 是"只加不改"，理论上不改它们，
若红则为真实回归，不得改测试迁就）。

## 8 风险与对冲（诚实记账，不得当已验收）

1. **★ D1 拆掉了现有质量对冲**：`RESOURCE-SPEC §11`（三个月删除测试）写的死因是
   「搜到的多是内容农场，摘出来的题残缺错版，用户被垃圾题坑两次就不用了」，其列的对冲为
   *「逐题来源可回查 ＋ **预览必经人工确认**」*。D1 选自动进组 = **拆掉后者**，verbatim 锚点锁
   成为唯一防线。
   **对冲（本契约新增）**：① 真题剂量收紧（单题型 ≤5，E2）；② UI 强制显示"未用 AI 顶替"与逐页报告；
   ③ 真题**必须**带 `source.url`（`collect.ts:266` 已保证），题卡可点回源；
   ④ **补题库页「剔除单题」入口**（现只有 `deleteQuiz` 删整组，`routes/quiz.ts:215`）——
   让自动进组留下的错题可事后剔除，即「事后可恢复」而非事前拦截。
2. **★ verbatim 严格度的基础假设未验证**：`RESOURCE-SPEC §10` 挂着欠账
   「T3 真机探针未跑，开放题集**正文可达率**未实测，D1 严格度是**假设不是结论**」。
   本契约在此欠账未清的前提下上线自动进组，**可达率直接决定真题命中率**——
   若实测可达率极低（如 <20%），D3「报缺不补」会表现为"真题几乎永远摘不到"，功能形同虚设。
   **处置**：T5 真机探针必须**顺带记录可达率数字**，作为该欠账的部分清偿；数字难看则回老板复议 D1。
3. **耗时叠加**：collect 单次 = 检索 + 抓 ≤3 页 + 一次摘题 LLM 调用（`COLLECT_TIMEOUT_MS=15s` 单页），
   与 AI 出题串行 → 出题总时长可翻倍。现有 collect 首版**无 SSE 进度**（`RESOURCE-SPEC §3.5` 明确"首版同步"）。
   **处置**：本批**不做**（划界，见 §9）；前端沿用现有 `出题中…` 三态，但提示文案要如实说"含真题搜集，可能更久"。
4. **题型配额与网上实况可能错配**：网上真题绝大多数是选择题，填空/解答题真题命中率低。
   D3 已拍板报缺不补，故这是**预期行为**而非缺陷；UI 提示需写明（§2 卡内 hint 已含）。
5. **版权口径**（沿用 `RESOURCE-SPEC §2` 第 4 条）：单人本地工具、用户主动指意的个人学习用途；
   来源 URL + 标题随题落库，前端徽标 + 可点回源——署名与可追溯是硬要求，本契约不放松。

## 9 本次不做（显式划界）

- **不做 SSE 进度推送**（真题搜集阶段仍同步 + loading 三态；要进度另立契约）；
- **不做真题去重/缓存层**（沿用 `searchWeb` 既有缓存；跨次同题去重不做）；
- **不做「真题优先填坑」策略**（D2 选了独立配额，不做占用式）；
- **不做真题的自动难度标注/质量打分**（verbatim + 可判分是唯一机验）；
- **不做图片题/PDF/`.apkg` 摘录**（沿用 `RESOURCE-SPEC §9` 划界）；
- **不做真题与 AI 题的交叉排序**（真题统一排在题组末尾，按来源分组）。

## 10 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-20 | v0.1 | 草案首立。承接 `RESOURCE-SPEC §9` 划界项「自动配比（AI 题与搜集题混套）」；老板拍板 D1~D5（自动进组／题型×来源二维配比／报缺不补／合并上限 20／混成一组）；默认决定 E1~E6；风险记账含「D1 拆掉人工确认对冲」与「verbatim 可达率欠账未清」两条硬风险 |
| 2026-09-20 | v1.0 | **实现落地并升版**。shared `quiz-source.ts`（联合钳位）＋ server `quiz-blend.ts`/`quiz-source-mix.ts`/`quiz-edit.ts`（合流编排/读写/剔除单题）＋ 路由接线（`/generate` 合流、`/settings/quiz-source-mix`、`DELETE /bank/:id/questions/:index`）＋ 前端双列配比卡（`QuizMixRow` 拆分）／blendNote 四态／题库徽标四分。实现期对契约的两处**实现口径补充**：① `blendNote(report?, questions?)` 加可选第二参——「来自 N 个网页」按真题逐题 `source.url` 去重（准确口径），省略时退回抓取成功页数（上限口径）；② 请求**不带** `sourceMix`（与 `mix` 同口径，服务端读设置），§3.5 改动范围表里「请求带 sourceMix」以此为准。T5 真机探针（含可达率数字，风险 2 的部分清偿）**未跑**，如实挂账 |
