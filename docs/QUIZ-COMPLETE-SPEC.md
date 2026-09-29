# 题目自包含契约（QUIZ-COMPLETE-SPEC）

> 版本：v1.0.0 | 状态：[已落地] | 更新：2026-09-29 | Issue：#109
> 定位：**出题与搜集两条管道的完整性闸门**——学生看到的每一道题，题干里指向的材料、图、表**必须在同一张题卡上**。
> 先立契约再改码（docs/ENGINEERING.md）。评测口径与读数见 `docs/eval/complete.md`。

## 1. 问题（用户看得到、AI 看不到）

学生会碰到这样的题：

> 阅读材料可知，洋务运动的目的是（　）　A. …　B. …

**没有材料**。题有题干、有选项、有答案，判分链路上完全「合法」，所以此前没有任何一道闸会拦它——而对学生它无从作答。
这个缺口在两条管道里的成因不同，都查到了源码：

| 管道 | 成因 | 位置 |
|---|---|---|
| 现场搜集（真题摘录） | `htmlToText` 把 `<img>` 连标签一起删，模型只看到文字，题图在抓页这一步就丢了；材料常在题干**上方**的另一个段落，模型只抄题干；verbatim 锁只校题干前 20 字在不在页面里，所以「带着悬空引用的题」照样通过；`checkCollectable` 只查答案是否合法 | `search/bing-channel.ts`、`learning/collect.ts` |
| AI 出题（联网） | 模型只看到 6 条 ≤300 字的搜索摘要，却被要求出「源于材料」的题——它没看过全文，就写「根据材料」；出题协议没有任何「必须自包含」的规则，出完也没有检查 | `learning/quiz.ts`、`learning/quiz-search.ts` |
| 盲解验算 | solver 只看 `question`+选项，不知道材料的存在 | `learning/quiz-verify.ts` |

## 2. 三条纪律

1. **不静默**（ADR-5）：检出几道无头题、怎么处理的（补全 / 搬图 / 剔除），如实进报告；全剔光时 502 说真因，不回「解析失败」。
2. **宁缺勿给无头题**：补不全就整题剔除。与盲解验算「验算失败**放行**」相反——那边放行的代价是「可能错」，这边放行的代价是「用户亲眼看到坏题」。修复调用本身失败也按剔除处理。
3. **搬运，不发明**：材料只能取自联网参考资料或题目自身；图只能是**真实存在**的图（原页面配图 / Commons 检索），绝不让模型凭空「描述一张图」当图用。URL、署名只由服务端填，模型只给编号。

## 3. 数据形状（纯加法，旧题零变化）

```ts
// @sb/shared/content-blocks.ts
interface QuizQuestion { …; material?: string }        // 题干依赖的材料原文（≤4000 字）
interface QuizPhoto    { …; essential?: boolean }      // 题干依赖这张图（区别于「不看也能答」的装饰配图）
function stemOf(q): string                             // 完整题干 = 【材料】+【题目】
```

- `material` 只能是**纯文本**；表格用换行分行、`|` 分列。判分不读它。
- **所有把题干交给别的模型 / 别的界面的地方必须走 `stemOf`**：盲解验算、AI 阅卷（前端 `AiGradeNote`）、对战出题（`foldMaterial` 把材料折进 `question`，因为对战界面只认它）。
- `photo.essential=true` 的图渲染在题干**之前**；普通配图仍在题干之后。
- `normalizeQuiz` 现在会**丢弃模型自造的 `photo`**（这是服务端字段）；只有搜集 commit 复校验以 `keepPhoto` 保留，并且 `sanitizePhoto` 要求 `src` 必须是本站缓存图 `/api/images/<hash>.<ext>`——客户端不能借 commit 塞外链图或跟踪像素。

## 4. 审查：`learning/quiz-completeness.ts`（纯函数、零 IO）

`findDependencies(q)` 找题干与选项里指向外部内容的固定说法，分三类：

| 类别 | 命中（例） | 刻意不命中（例） |
|---|---|---|
| passage | 阅读/根据/结合/依据+材料/文段/短文/对话；`材料一中`；`由材料可知`；`the passage` | 「根据牛顿第三定律」；「下列材料中，属于导体的是」（物理材料题） |
| figure | `如图`（排除「如图书馆」）；`图中`；`下图`；`读图`；`the diagram` | 「地图学的代表人物」；「表面积」 |
| table | `下表` `表中` `如下表` `上述数据` | — |

`assessQuestion(q)` 再判这些引用**是否已随题给出**：

- passage：`material` ≥12 字；或题干去掉引用句后还剩 ≥40 个汉字当量（英文 120 字符）。
- figure：有 `svg` / `photo`；或 `material` 以「图…：」「漫画描述：」开头的文字转述；或题干内联足够内容。**一段普通文段不算图。**
- table：`material` 里有数据（≥3 个数字或多行）；或有 svg/photo。

★ 取舍：**宁可放过、不要误杀**。正则只认「指向外部内容」的固定说法，不认泛泛的「材料」「图」二字。它的盲区是**没有显式引用词的隐式依赖**（例：「该班成绩在 80 分及以上的占…」，数据表在别处）——这类由评测里的 LLM 卡面评审员兜底衡量，不放进产线闸门（否则误杀面不可控）。

## 5. 处置

### 5.1 AI 出题：`learning/quiz-selfcontained.ts`

`generateQuiz` 在 `mapQuizSources` 之后、`attachQuizPhotos` 之前调 `enforceSelfContained`：

1. 全组用 `assessQuestion` 过一遍。**全部干净 ⇒ 零 LLM 调用**（常态零成本）。
2. 有无头题 ⇒ **一次批量**修复调用（用途 `quiz.selfcontain`，出题角色，每次最多 6 题，超出的直接剔除）。模型对每题只能选：
   - `rewrite`：给 `material` + 改写后的 `question`。**不许动选项与答案。** 材料只能取自联网参考资料或题目自身。
   - `image`：缺的是图 ⇒ 交给既有 `findImages({requireVerified:true})`（Commons/Bing → 下载闸门 → 视觉模型核验 → 不泄露答案），成功则挂 `photo{essential:true}`。对战（`verify=true`）与「出题配图」开关关闭时不可用。
   - `drop`。
3. **再审一遍**：模型说「补好了」不算数，`assessQuestion` 通过才放行；配图后仍缺文段/表格的，图也撤掉、整题剔除。
4. 全部剔光 ⇒ `generateQuiz` 返回 `null` 且 `report.failure='incomplete'`，路由 502「这一批题都依赖没能取到的材料或图」。
5. 出题协议（`QUIZ_PROTOCOL`）与检索参考段同步加规则：不得出现「根据材料 / 如图 / 下表」，除非材料已**逐字**放进 `material`（参考资料原文可搬，不许改写编造）或图画进 `svg`；没把握就换题。

### 5.2 搜集：`learning/collect-figures.ts`

1. **抓页保图**：`markImages` 在 `htmlToText` 之前把正文里的 `<img>` 换成 `[图N]` 标记（N 跨页全局递增，服务端记 N→{url, alt}）。支持 `data-src/data-original` 懒加载、相对地址按页面 URL 解析、仅 http(s)；跳过 data URI、svg/gif、小于 60px、logo/icon/二维码/广告类命名、nav/header/footer 内的图，每页 ≤10 张。标记**不参与 verbatim 锚点**（`stripMarkers` 后再算 `normText`，否则夹在题干里的标记会打断锚点）。
2. **协议**：`COLLECT_PROTOCOL` 新增 `material`（逐字抄）与 `figures:[N]`（只能填**同一页**里出现过的编号，一题一张）；材料找不到、图也没标记时**跳过这道题**。
3. **服务端复核**（`resolveCandidate`，不信模型）：
   - `material` 必须与命中页原文**逐字**对上（12 字分块，覆盖率 ≥85%）；对不上就丢掉 material——「概述式改写」等于编造。
   - 图只认命中页登记过的编号；下载走既有 SSRF 闸门；有视觉模型时看一眼**只为取替代文字**（题图与题干的关系不是「图展示主题」，不拿 match 卡它——搜集本来就有预览页由人确认）；落本站缓存后挂 `photo{credit:"图源：<域名>（原题页面配图）", pageUrl, essential:true}`。
   - **复审**：仍然悬空的候选标 `ok:false` + 说明原因，预览里用户看得到为什么没收，不静默。
4. **版权口径**：与既有搜集一致——只在用户本地预览、确认后入库；图片只存本机缓存；署名链接指回原页面。

### 5.3 报告

- `QuizImageReport.completeness?: { checked, dangling, repaired, imaged, dropped, reasons[≤5] }`
- `CollectReport.completeness?: { figuresSeen, figuresAttached, figuresFailed, withMaterial, rejectedIncomplete }`
- `failure` 新增 `'incomplete'`（聊天工具 `generate_quiz` 的失败提示同源）。

## 6. 前端

`QuizQuestionItem`：`material` 渲染为 `blockquote.quiz-q-material`（保留换行，长材料限高滚动），`essential` 图排在题干前；无 `material`/`photo` 的旧题不多出任何节点。样式全在 `quiz.css`，无内联样式。

## 7. 评测（怎么证明它管用）

见 `docs/eval/complete.md`。要点：

- **自建评测集** `tools/eval/datasets/complete-v1.json`：33 题（13 文段依赖 / 9 图依赖 / 6 表依赖 / 5 无依赖对照），每题有作者**人工检索、人工编写的参考题**（含出处或「自编」标记），6 张真实图片（全部自由许可，署名见 `figures/ATTRIBUTION.json`）。
- **搜索快照**：评测沙箱出口在境外，产品的 Bing RSS 通道对它返回与查询无关的结果，所以由人工为每题挑真实习题页、冻结成 `complete-v1.search.json`，评测时在 fetch 层回放（`tools/eval/lib/search-replay.mts`，两臂共用、产品代码零改动；网页正文仍实时抓取）。17/33 题有习题页，其余题的搜集通道两臂都拿不到页面——所以搜集通道读数只对这 17 题成立，且是「搜对了页面」的乐观情形。
- **两臂**跑真实产品代码（`generateQuiz(online)` + `collectQuiz`）：**基线**＝修复前的提交，**本分支**＝本契约。
- **评分器不在产品代码里**：一个独立模型作「卡面评审员」（只看用户会看到的内容：题干、材料、图、选项，判「学生不看别处能不能作答」）＋一个冻结的正则检测器。对照组专门量误杀率。
- 我们手写的参考题用**同一个评审员**打分——这是评审员自身的标尺：参考题应当全部自包含。

## 8. 不做（如实）

- 不做「隐式依赖」的产线检测（§4 盲区）。
- 不为搜集页里的图做 OCR：图内文字由学生自己看图。
- 不保证联网出题**总能**补出材料——补不出就剔除，代价是题数偏少（报告里如实说）。
- 评审员与被测模型同厂商，存在偏好风险，读数里注明。
