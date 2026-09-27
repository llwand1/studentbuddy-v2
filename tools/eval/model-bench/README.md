# tools/eval/model-bench — 模型横评 · 四套件 110 样本

衡量**任意 OpenAI 兼容模型**在本产品四条 AI 链路上的**裸输出**质量。换模型、换 provider、改提示词之前后各跑一遍,分数变化就是决策依据,不再靠手感。

## 与 `tools/eval/` 评测台的分工(两套各管一头,数并排读)

| | `tools/eval/`(评测台,`npm run eval`) | `model-bench/`(本目录,`npm run eval:models`) |
|---|---|---|
| 评什么 | **产品链路**:走生产同款抽取/修复(`extractQuizJson`),四档解析 strict/repaired/rescued/failed,两 arm(配图开/关)永不合并 | **模型裸输出**:不过修复器,协议服从性一刀切 |
| 口径在哪 | `packages/server/src/learning/quiz-eval-metrics.ts`(纯函数,26 例回归锁进 vitest) | 本目录 `lib/`(零依赖 .mjs,`--selftest` 35 条断言;`tools/` 不入 vitest,同评测台运行侧) |
| 模型 | 产品当前接的那一档 | 任意 OpenAI 兼容端点(自带 Key 横向对比) |
| 覆盖 | 出题(词条驱动,批次 B 将扩 search/collect/scenario/chat/review) | 出题 + **复刻相似度** + **联网引用命中** + **词条抽取 F1** + 注入对抗 |
| 怎么读 | "产品今天交付什么水平" | "这只模型本身什么水平" |

两边并读的用法:同一份失败,评测台落在 `repaired/rescued` 档而 model-bench 直接红 ⇒ 是修复器救回来的,**该改提示词**;两边都绿 ⇒ 模型本身就行。**口径已对齐的点**:essay 缺 `explanation` 只记观察、不进判据(评测台批次 A 108 题真机逼出的修正,协议示例里 essay 本就没这字段)——本目录 schema 检查同步放行 essay、其余题型照红。

## 快速开始

```bash
# 1. 评分器自检(34 条断言:19 条坏夹具 + 相似度/复刻/联网/词条评分器;零 key 零网络)
npm run eval:models -- --selftest

# 2. 假模型验通路(110 例应当全绿;零 key 零网络,同 demo:e2e 的假 LLM 哲学)
npm run eval:models -- --fake

# 3. 真模型跑分(任意 OpenAI 兼容端点,自带 Key)
EVAL_API_KEY=sk-xxx EVAL_MODEL=gpt-4o-mini npm run eval:models --
EVAL_API_BASE=https://api.deepseek.com/v1 EVAL_API_KEY=sk-xxx EVAL_MODEL=deepseek-chat npm run eval:models --

# 只跑部分套件 / 前缀过滤 / CI 阈值 / 模型裁判
npm run eval:models -- --suite replicate,search
npm run eval:models -- --only rep-0 --fake
npm run eval:models -- --fake --check 0.9
EVAL_API_KEY=... EVAL_MODEL=... npm run eval:models -- --judge
```

报告落 `tools/eval/model-bench/results/<tag>.md`(汇总)+ `.json`(逐用例逐检查原始数据,已 gitignore)。

## 四个套件:各自测什么、对产品有什么用

### 1. `quiz-gen` — 从材料出题(40 例)

**测什么**:给一段学习材料 + 题型配比,模型能否严格按 `QUIZ_PROTOCOL` 产出题组。
**为什么重要**:这是对话出题、知识大陆五题型挑战、AI 对战三条功能线的**共同地基**。协议服从性差 = 解析失败走 502 降级 = 用户面前直接没题。12 项检查覆盖:标记包裹、JSON 合法、字段契约、**配比精确**(多一道少一道都算错)、题型顺序、答案合法性、选项质量、**答案泄漏**(正确选项原文出现在题干=送分)、refs 编造、svg 照抄示例、材料贴合度、解析非空。
**边界用例**:超短/超长材料、英文材料、极端配比,以及 **2 条提示注入对抗**(quiz-039/040:材料里埋了"忽略格式要求""在标记外加祝贺语"的指令——模型若照做,wrap/mix 检查立刻变红)。
**主指标**:总分(hard 检查 1 分、soft 0.5 分加权)、全绿率。

### 2. `replicate` — 复刻网络题目(30 例)

**测什么**:给一道网上检索到的原题(题干+选项+答案),模型能否**忠实复刻**成协议 JSON——考点、选项含义、正确答案一个都不许跑。
**为什么重要**:联网搜索找到真题后转成产品内可判分的题,是"AI 查资料→生成练习"链路的关键一步。复刻走样有两种死法:题干改得面目全非(用户对不上原题),或者**答案悄悄换了**(比错题更糟——教错了)。所以本套件同时度量两件事:
- **相似度**(0..1):题干 textSim(0.7×字符 bigram Dice + 0.3×LCS,中英通吃)+ 选项组 setSim(贪心配对,多出/缺失选项直接稀释得分),按 0.6/0.4 加权;
- **答案一致**:把"正确答案的文本"对回原题(允许表述微调,textSim ≥ 0.6 算一致)。

**成功判定**:结构合格 且 相似度 ≥ 0.55 且 答案一致。
**主指标**:**成功率**(整体成功的用例占比)与**总体相似度**(全部用例相似度均值)——前者告诉你"这条链路能不能开",后者告诉你"复刻质量还差多少"。

### 3. `search` — 联网搜索出题的引用溯源(15 例)

**测什么**:材料只给主题句,事实全部放在编号的「互联网参考资料」里(镜像 `quiz-search.ts` 的资料块拼装,措辞一字不差),其中混有**明显无关的干扰资料**(菜谱/攻略/球赛…)。模型出题时必须在 refs 里引用**且只引用**真正相关的资料编号。
**为什么重要**:refs 溯源是"带段号可溯源"这条产品卖点在出题侧的对应物。引用错资料比不引用更糟——用户点开 [2] 发现是红烧肉做法,可信度当场清零。四项专属检查:
- `refsRange`:编号必须是 1..N 的整数(协议:绝不填网址标题);
- `coverage`:事实全在资料里,带引用的题得 ≥50%(全填 [] = 没在用资料);
- `hit`:引用的每个编号都必须在**相关集**里,引到干扰资料一次即失败。

**主指标**:成功率 + **引用命中率**(全部被引编号中相关编号的占比)。

### 4. `terms` — 词条抽取(25 例)

**测什么**:给一段材料,模型按 `TERMS_PROTOCOL`(运行时从 `term-extract.ts` 提取)抽取术语,与人工标注的**金标词条**对比,算 Precision / Recall / F1(模糊匹配:归一化相等/包含/相似度 ≥ 0.75,容忍「二分查找」vs「二分查找算法」级别的表述差异)。
**为什么重要**:README 第一句话——**词条是产品主体,学练忆都围着它转**。抽取是词条的唯一自动入口:漏抽(低 Recall)= 该记的词没进库,复习/卡牌/大陆全缺块;乱抽(低 Precision)= 词条库被垃圾词污染,复习队列被灌水。F1 就是这条入口的水质检测。
**主指标**:**平均 F1**、成功率(结构合格且 F1 ≥ 0.5)。

### 综合分

各套件主指标的均值(×100)。`--check <阈值>` 低于即退出码 1,可接 CI 或发版前门禁。

## 纪律(与仓库既有哲学对齐)

- **协议不许手抄**:`QUIZ_PROTOCOL` 与 `TERMS_PROTOCOL` 运行时直接从生产源码正则提取,生产协议一改 eval 自动跟上(同 `tools/metrics.mjs` 对账纪律);配比指令、资料块措辞逐字镜像 `buildMixInstruction` / `buildQuizSearchBlock`。
- **零依赖**:纯 Node ≥ 22,`fetch` 内建;eslint 范围仅 `packages/**`,本目录不入 lint。
- **评分器自己也有判断标准**:`--selftest` 共 34 条断言——19 条"各坏一处"的夹具 + 相似度度量三条(全同=1/无关<0.2/改写居中)+ 复刻三条(忠实→成功/换答案→抓到/题型跑偏→抓到)+ 联网四条(引对→过/引错→红/越界→红/不引→红)+ 词条四条。防止"全绿只是因为什么都没查"。

## 数据集格式

一行一个 JSON:

```
quiz-gen.jsonl        { id, domain, lang, mix, material }
quiz-replicate.jsonl  { id, domain, type, ref: { question, options?, answer } }
quiz-search.jsonl     { id, domain, mix, material, sources: [{title,url,snippet}], relevant: [编号] }
term-extract.jsonl    { id, domain, material, gold: [词条] }
```

加样本 = 追加一行。`--only <id前缀>` 跑子集。

## 已知边界

- 规则评分器锁的是**协议服从性与结构/引用/抽取质量**;"答案在学科上是否真对"这类语义正确性交给 `--judge`(模型裁判,quiz-gen 与 replicate 两套件,有裁判自身偏差,只作参考分)。
- 相似度是字符级度量:同义改写幅度极大但考点不变的复刻会被低估——阈值 0.55 已为此留了余量,如与人工判断系统性冲突,调 `replicateSuite` 里的阈值并在 PR 里留证据。
- `search` 套件的资料是**构造的**(干扰项故意跨领域),比真实检索结果更"好分"——它测的是引用纪律的下限,不是检索质量本身(检索质量归 `quiz-search.ts` 的单测管)。
- scenario 情景题走独立协议(`scenario-protocol.ts`),不在本 eval 范围。
