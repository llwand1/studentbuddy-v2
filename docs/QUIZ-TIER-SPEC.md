# 出题分级与真题优先契约（QUIZ-TIER-SPEC）

> 版本：**v1.0（已实现）** | 状态：[已落地·shared 7 + server 41 + web 1 例全绿] | 更新：2026-09-29
> 定位：回答「AI 出题到底怎么保证有用」这个核心问题——**不是让 AI 出得更像考题，而是把每道题的"目的"如实标出来，
> 并让真正有功利效果的题（公开题源上的真题）优先进组、可核验、可溯源、带原图。**
> 上游契约：`docs/RESOURCE-SPEC.md`（真题搜集管道，本契约**加强**它的辨别层）、`docs/QUIZ-BLEND-SPEC.md`（合流，本契约在其上叠一层「真题优先」）、
> `docs/QUIZ-SEARCH-SPEC.md`（联网参考段——决定 AI 题是「模拟」还是「基础」）、`docs/QUIZ-IMAGE-SPEC.md`（`photo` 字段复用）。

## 0 问题陈述

| 缺什么 | 后果 | 证据 |
|---|---|---|
| 题面上分不出「真题 / 变式 / AI 自编」 | 用户不知道这题做了有没有用；AI 自编题冒充考题 | `QuizQuestion.source.kind` 只在解析里显示，题卡头部无任何标注 |
| 真题默认不出 | `DEFAULT_QUIZ_SOURCE_MIX` 全 0 ⇒ 绝大多数用户从没见过真题档 | `quiz-source.ts`「全 0＝不出真题，是最常见配置」 |
| 搜集只校验题干前 20 字 | 弱模型「首句抄、后半编」「题干抄、选项编」全部放行 | `collect.ts` 原 `verbatimHit` 只比头锚点 |
| 搜到什么抓什么 | 内容农场排在题源站前面；练习博客被当真题 | `collectQuiz` 按搜索引擎原序抓前 3 页 |
| 真题页配图被剥掉 | 「如图所示」的题没有图 | `htmlToText` 丢 `<img>`，摘录模型看不到图 |

## 1 三档分级（`@sb/shared/quiz-tier.ts`）

| tier | 徽标 | 推导依据（**服务端按事实推，模型自报不算**） | 对用户的建议 |
|---|---|---|---|
| `real` | 真题·必刷 | `source.kind === 'collect'`：网页逐字摘录、过 verbatim 锁（§3）、来源 URL 回填 | 先做 |
| `simulated` | 模拟题·建议做 | `source.kind === 'web'`：AI 参考联网检索到的真题/资料出的变式 | 时间允许就做 |
| `basic` | 基础题·可选做 | 其余：AI 只凭材料/主题出；提示词**明令按基础题写**（§2） | 查概念用 |

- `QuizQuestion.tier?: QuizTier` 纯加法字段；前端一律 `tierOf(q)`（历史题无键 ⇒ 按 `source.kind` 兜底），**不迁移数据**。
- 判分 / 对战 / 复习一律不读它。
- 题卡：每题标徽标（悬停给「为什么这么标」的一句话 `QUIZ_TIER_HINTS`）；卡头汇总「本组：真题 N · 模拟 N · 基础 N」；
  `generate_quiz` 工具回灌同样带分级摘要，并明令模型**不得把基础题说成真题**。

## 2 AI 侧：基础题就说是基础题（`learning/quiz-tier.ts#buildTierInstruction`）

- **有联网参考段** ⇒ 提示词写「模拟题：以参考资料里的真题为范本出变式（换数据/情境/问法），refs 如实填」。
- **无参考段** ⇒ 提示词写「基础题：不模仿考卷腔、不杜撰"某年某地真题"字样；一题一考点、题干短、解析点到概念」。
- 理由：模型对考点分布的想象不可信，「装真题」比「明说基础题」误导更大；功利效果留给真题档去承担。
- `quiz.generate` purpose version 3 → **4**（提示词变更）。

## 3 搜集辨别层（`learning/collect-quality.ts`）

| 闸 | 规则 | 挡什么 |
|---|---|---|
| 头锚点（既有） | 题干 normalize 后前 20 字必须在某页命中 | 整题编造 |
| **尾锚点（新）** | 题干 ≥ 40 字时，末 16 字也必须在同一页命中 | 首句抄、后半编 |
| **选项命中率（新）** | 选择题去掉 `A.` 前缀后 ≥ 50% 选项在页面命中 | 题干抄、选项编 |
| 可判分（既有） | 缺答案 / 越界 ⇒ 拒 | 不可判的题 |

- 保守方向是**少杀**：短题不做尾锚点、无选项不做命中率；误杀真题比漏一道更伤信任。
- **考试信号** `classifyExamSource`：标题/URL/正文前 400 字里的考试词（高考/中考/考研/期末/四六级/…）+ 年份 + 已登记 exam 题源，**≥ 2 票**才判「考试真题页」；
  判中的页在 `CollectPageRecord.exam/signals` 回显，来源标题追加「（考试真题页）」。判不中的仍是真题档（摘录经过 verbatim 锁），只是不加考试标签。
- **题源登记表** `KNOWN_QUESTION_SOURCES`：配置不是白名单——只影响 `rankPicks` 的抓页顺序（登记题源 → 带考试信号 → 其余，组内稳定）与 exam 一票。
  入选标准：公开可访问、正文含完整题干与答案、不是纯 SPA 壳。每一行都应能在 `tools/eval/` 里单独跑一遍摘录成功率（§7 待办）。
- 搜集词多一条 `「主题 真题」`（首位）。
- 锚点三件套（`normalizeForAnchor` / `pickAnchor` / `verbatimHit`）迁入本文件，`collect.ts` 原路径 re-export（旧调用点与测试零改动）。

## 4 真题优先（`learning/quiz-blend.ts` + `learning/quiz-tier.ts`）

- 设置 `quiz_real_first`（`app_settings`，owner 归主），**缺省开**；`GET/PUT /api/settings/quiz-real-first`；设置页「真题优先」卡。
- 生效条件 `realFirstApplies`：开关开 **且** 用户没自己配真题配比（配了就照 QUIZ-BLEND 的显式语义走）**且** AI 侧有可被顶替的题 **且** 主题不是占位词（「综合」「根据当前对话内容出题」）。
- 配额 `realFirstQuota(aiMix)`：**每题型 = AI 配比**（封顶 `MAX_QUIZ_REAL_PER_TYPE`），scenario 恒 0——「能换成真题的都换」，**不加总题数**。
- **与 AI 出题并行**：`Promise.all([generateQuiz, collectQuiz])`，真题侧永不抛、失败只记报告 ⇒ **不额外等待**（代价：AI 侧仍出满配比，顶替掉的题是浪费的 token——换来的是零延迟）。
- 合并 `mergeRealFirst`：同题型每来一道真题，从 AI 题**从后往前**削一道；真题在前。`QuizBlendReport.realFirst.displaced` 记被顶替数。
- 报告文案（`mix-report.ts#blendNote`）：真题优先下「要 N 摘到 M」**不是缺口**，念成「摘到 M 道真题并顶替了同题型 AI 题」；一道没摘到 ⇒ 「本组全部由 AI 出（档位已在每题标注）」。
- `generate_quiz` 工具点名 `count` 时：总数仍是 `count`，真题优先照样生效（顶替不加数）。
- 关掉 ⇒ 行为与改动前逐字一致（`routes/quiz-blend.test.ts`「向后兼容」组锁着）。

## 5 题源配图：本节已撤，改由 `docs/QUIZ-COMPLETE-SPEC.md` §5 承担

本批原自带一套搬运机制（`learning/collect-images.ts`：抓页时把题源页 `<img>` 列成编号清单 → 模型只填编号 → 服务端按编号下载挂 `photo`）。
并入时它与「题目自包含」那一套（`learning/collect-figures.ts`：正文保留 `[图N]`、材料逐字校验、原图搬运）**是同一件事的两套机制**，
同写 `question.photo` ⇒ 同一题会被下载两次、且给摘录模型的协议键互相打架。

⇒ **已撤下本套，配图以自包含那套为准**（2026-09-30 并入时决定）：抽取、限额、下载上限、署名与「失败只是没图」的纪律全部见
`docs/QUIZ-COMPLETE-SPEC.md` §5；本文件不再定义配图协议。题源配图的用户可见行为不变（题照样带原图与署名）。

## 6 落点清单

| 层 | 文件 | 改动 |
|---|---|---|
| shared | `quiz-tier.ts`（新） | `QuizTier` / 徽标文案 / `tierOf` / `countTiers` / 真题优先键与归一化 |
| shared | `content-blocks.ts` | `QuizQuestion.tier`、`CollectPageRecord.exam/signals` |
| shared | `quiz-source.ts` | `QuizBlendReport.realFirst` |
| server | `learning/collect-quality.ts`（新） | 加强 verbatim / 考试信号 / 题源登记表 / 抓页排序 / 锚点三件套 |
| server | `learning/quiz-tier.ts`（新） | 分级提示词 / `fillTiers` / 真题优先开关读写 / 配额与顶替算法 |
| server | `learning/collect.ts` | 接入辨别层与自包含层；协议加「抄到句末」规则；搜集词加「真题」 |
| server | `learning/quiz.ts` | 提示词插分级段；`fillTiers` |
| server | `learning/quiz-blend.ts` | 真题优先编排（并行 + 顶替）；`realFirstApplies` |
| server | `learning/quiz-search.ts` | `isPlaceholderTopic` |
| server | `routes/settings.ts` | `/quiz-real-first` GET/PUT |
| server | `chat/tools/generate-quiz-format.ts` | 回灌带分级摘要与「不得把基础题说成真题」 |
| server | `ai/purposes.ts` | `quiz.generate` v4、`collect.draft` v2、新增 `quiz.selfcontain` v1（自包含补全） |
| web | `features/quiz/QuizQuestionItem.tsx` / `QuizCard.tsx` / `quiz.css` | 徽标 + 卡头汇总 |
| web | `features/quiz/mix-report.ts` | 真题优先文案 |
| web | `features/settings/QuizRealFirstCard.tsx`（新）/ `SettingsView.tsx` / `lib/api-settings.ts` | 开关卡 |

## 7 本次不做 / 待办（如实）

1. **题源逐站评测**：登记表里的站点都是按公开可访问性挑的，**没有逐站实跑摘录成功率**——`tools/eval/` 下应加一条「按题源分桶的 collect 成功率」评测，跑出来再增删登记表；反爬强的站（菁优网等）大概率要从表里摘掉。
2. **结构化题源适配器**：有 JSON API 的开放题源（如 Open Trivia DB）可以绕过网页抓取 + verbatim 锁直接进 `real` 档；接口位留在 `collectQuiz` 之前，本次未写。
3. **真题优先的 token 浪费**：AI 侧出满再削。若真题命中率上来，可改成「先摘后出、AI 只补缺」——代价是串行等待，需要真机数据再定。
4. **配图泄露**：题源页配图目前不过视觉模型（口径见 `docs/QUIZ-COMPLETE-SPEC.md` §5）；若线上看到「图里印着答案」的样本，把 `verifyImage` 的泄露检查接进自包含那套的取图步骤。
5. **搜集辨别的误杀率**：尾锚点在页面正文被 `PAGE_TEXT_CHARS`（25k）截断时可能误杀页尾的题——保守方向是漏、不是错，但要在 eval 里盯数。
