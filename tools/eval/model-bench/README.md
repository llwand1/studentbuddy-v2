# tools/eval/model-bench — 模型横评 · 七套件(自建 110 样本 + 公开集 + 现场真题)

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
# 1. 评分器自检(82 条断言:坏夹具「该抓的抓到」+ 合法夹具「该放的放行」+ 相似度/复刻/联网/词条/公开集/采集 QC/计量;零 key 零网络)
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

# 4. 公开学术集(MMLU + C-Eval,首跑联网拉取,之后读缓存)
npm run eval:models -- --suite public --public-per-config 5
npm run eval:models -- --suite public --public-offline      # 只用缓存/仓内冻结件,不联网

# 5. 现场真题:两条通道各采一次,再比稳定性(见下文「两跑协议」)
npm run eval:harvest -- --channel free                       # 免 key,走 Bing RSS
EXA_API_KEY=... npm run eval:harvest -- --channel keyed       # 带 key,走 exa/tavily/zhipu
npm run eval:models -- --suite live-replicate --live harvests/<快照>.json

# 6. 横评两个/多个模型(时延·成本·质量三栏一起读)
npm run eval:compare -- results/a.json results/b.json
npm run eval:compare -- results/a.json results/b.json --doc   # 同时写进 docs/eval/model-bench.md
npm run eval:compare -- --harvest harvests/free-*.json harvests/keyed-*.json
```

### 时延与成本怎么量(读数前必看)

| 量 | 口径 | 什么情况下**不可比** |
| --- | --- | --- |
| `latencyMs` | **最后一次成功**那笔的墙钟；补跑的等待时间单独记 `retryWaitMs`/`wastedMs` | 「慢」和「被限流」是两回事,合在一起就分不清该换模型还是该加配额 |
| `ttftMs` | 仅 `--stream` 下量得到；非流式记 `null` 显示 `—(非流式)` | **绝不记 0** —— 0 会被读成「快到没有首字延迟」 |
| p50/p95 | **最近秩**,不插值 | 样本常只有 15～40 个,插值出来的 p95 是谁也没测到的数；最近秩至少能翻回那一次的原文 |
| 并发 | 每份报告都记；`--serial` 可串行 | 并发下 p50/p95 含排队时间。**各轮并发不同 ⇒ 时延栏整栏不可比**,`eval:compare` 会直接打 ⛔ |
| token | 来源分 `api` > `stream` > `estimated`(需 `--estimate-tokens`) > `none`,四类计数必须加起来等于样本数 | 估算误差 ±25%,只能读量级 |
| 成本 | token × `tools/eval/pricing.json`(带 `asOf`/`source`/过期标记) | 价表没有该模型 ⇒ `—`,**永远不是 $0** |
| 每分成本 | `总花费 ÷ 综合分` | **换模型时唯一该看的那一列**:总花费单看会选出便宜到不能用的,质量单看会选出用不起的 |

价格会变。`pricing.json` 里每条都带抄录日期与出处链接,超过 `staleAfterDays` 自动在报告里标「⚠ 价表过期」——不会悄悄拿去年的价算今年的账。

### 公开集:为什么只冻结一小撮进仓

| 集 | 许可 | 进仓的是什么 | 为什么 |
| --- | --- | --- | --- |
| MMLU (`cais/mmlu`) | MIT | `datasets/public/frozen-mmlu.jsonl` —— 24 道**含题面全文** | 与本仓 MIT 相容,可以直接放 |
| C-Eval (`ceval/ceval-exam`) | CC BY-NC-SA 4.0 | `datasets/public/pointers-ceval.json` —— 只有 `dataset/config/split/rowIdx` + 内容 sha256,**一个字题面都没有** | NC(禁商用)与本仓 MIT **冲突**,原文不能进仓;指针只是「第几行」,不构成再分发 |

- 首跑联网拉到 `datasets/public/cache/`(已 gitignore),之后默认读缓存；`--public-refresh` 强制重拉。
- 断网/无缓存时:MMLU 回落到仓内冻结件照常跑；C-Eval 取到 0 条,并在报告里**写明是许可原因**,不静默少一半样本。
- 指针的 sha 对不上 ⇒ 报告点名是哪一条漂了(上游数据集改过了),不当没看见。
- 取的是每个 config 的**前 N 条**(可 `--public-offset` 平移),**不是随机抽样** ⇒ 这个正确率**不能拿去和公开榜单比**,它只用于同一把尺子下的模型间横评。
- 维护:`node tools/eval/model-bench/freeze-public.mjs --per-config 4` 重新生成两个冻结件,该脚本本身就是这两个文件的出处记录。

### 现场真题:两跑协议

公开集几乎必然在模型的训练语料里,所以它给的是**能力上界**。现场题是刚从网上搜来的,没被背过。两者的差值≈污染程度。

采集链路复用产品自己的 `searchWeb`/`fetchSafe`(SSRF 护栏一并复用),所以 `harvest.mts` 是 TypeScript、要 `tsx` 跑；而**打分侧仍是零依赖 `.mjs`,只读冻结快照** —— 与 `--replay` 同一条纪律:采集可以依赖产品,评分不可以。

```bash
npm run eval:harvest -- --channel free    # 第一跑:零配置
npm run eval:harvest -- --channel keyed   # 第二跑:带 key 的检索商
npm run eval:compare -- --harvest harvests/free-*.json harvests/keyed-*.json
```

> **若两份快照的题目重合率 < 0.6,两次跑分的分数差不许相减** —— 那是「换了一批题」,不是「模型变了」。`eval:compare --harvest` 会直接给出这个判定。

抽题这一步本身用的是 LLM,这是个真实的混淆项,用三条来压:① 规则 QC 逐条记丢弃原因(`needs-media`/`no-answer`/`extract-unparsed`/`fetch-failed`/`page-too-thin`…),产出率低时先看分布再决定是改查询词还是换抽题器;② 快照记录 `extractor`,一旦等于被测模型,报告直接打「**自产自销**」警告;③ 快照是人能读的 JSON,带 `source_url` 与 `fetched_at`,可以自己去翻原页。

报告落 `tools/eval/model-bench/results/<tag>.md`(汇总)+ `.json`(逐用例逐检查原始数据,已 gitignore)。

## 套件:各自测什么、对产品有什么用

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

### 5. `public-solve` / `public-replicate` — 公开学术集

`public-solve` 盲解 MMLU/C-Eval 选择题,量的是**零裁判的学科水平上界**(也正是生产 `quiz-verify.ts` 那道保险丝的能力天花板 —— solver 答不对的题,保险丝也保不住)。solver 不出答案或自相矛盾记「不可解」:**不可解 ≠ 答错,但仍然进主分母**,因为对用户来说都是没用。
`public-replicate` 拿真题做复刻保真度 —— 真题有长题干、LaTeX、「以下说法正确的是」这类句式,比自建的手写 `ref` 难得多。

### 6. `live-replicate` — 现场搜来的真题

同复刻口径,但题目来自 `eval:harvest` 的快照。公开集测不到「没被背过的题」这一面。

### 综合分

各套件主指标的均值(×100)。`--check <阈值>` 低于即退出码 1,可接 CI 或发版前门禁。

⚠ 它是**跑了哪几个套件**的均值 ⇒ 两轮跑的套件集不同,综合分就是两个不同的数,不能直接比(`eval:compare` 会打 ⛔ 并要求逐套件比)。

### `--verify` — 盲解验算效果(对应生产 `quiz-verify.ts`)

量的是那道**保险丝**:生产侧出题后 solver 盲解验答案、不一致丢题。加 `--verify` 后,quiz-gen 套件每道选择类题会被同一模型盲解一遍(只喂题干+选项,与生产 `buildSolvePrompt` 同款无泄漏),报四个数:**验算一致率**(标注与盲解一致的占比)、**拦截数**(会被丢弃的题)、**不可解数**(solver 答不上/矛盾,保守放行)、**answers 红 前→后**(把被拦的题丢掉后重跑 answers 检查)。解析纪律与生产实现逐字一致:只认字母、单选答出多个字母=矛盾不猜。假模式下 solver=理想应答,用于验通路。

## 纪律(与仓库既有哲学对齐)

- **协议不许手抄**:`QUIZ_PROTOCOL` 与 `TERMS_PROTOCOL` 运行时直接从生产源码正则提取,生产协议一改 eval 自动跟上(同 `tools/metrics.mjs` 对账纪律);配比指令、资料块措辞逐字镜像 `buildMixInstruction` / `buildQuizSearchBlock`。
- **零依赖**:打分侧纯 Node,`fetch` 内建;eslint 范围仅 `packages/**`,本目录**既不入 lint 也不入 tsc** ⇒ 正确性只能靠 `--selftest` 与真跑,不能指望仓库的门禁。唯一的例外是 `harvest.mts`(采集要复用产品的检索与 SSRF 护栏,用 `tsx` 跑)。
- **评分器自己也有判断标准,而且是双向的**:`--selftest` 共 82 条断言。一个方向是"各坏一处"的夹具必须被抓到(防止"全绿只是因为什么都没查");另一个方向是 `LEGIT_FIXTURES` —— **合法输出必须被放行**。后者是接公开集时补的:一道选项为 `AaBb/Aabb/AAbb/aabb` 的真实遗传题曾被判成"选项重复"(查重的归一化做了 `toLowerCase`),而当时的自检只查前一个方向,**评分器过严这类缺陷没有任何一道闸拦得住**。

## 数据集格式

一行一个 JSON:

```
quiz-gen.jsonl        { id, domain, lang, mix, material }
harvest-queries.json  { queries: [搜索词], notes }  ← 现场采集的查询词,产出率低时先改这里
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
- **公开集分数不可与公开榜单比**:取样是「每 config 前 N 条」的确定性切片、样本量两位数、提示词是本仓自己的。它只在「同一把尺子下比不同模型」时有意义。
- **公开集几乎肯定被训练过**(MMLU/C-Eval 公开多年)⇒ 它给的是能力**上界**。真实水平要看 `live-replicate`,两者的差值是污染程度的粗估。
- **现场题的样本量小、且随时间漂**:今天采到的题和下周采到的不是同一批,所以现场题只能「同一份快照内横评模型」,不能拿上周的分数比这周的。快照因此必须留档。
- **抽题器是 LLM**:三条缓解见上文「两跑协议」,但这个混淆项**消不掉**,只能让它可见。
- 时延与成本受端点地域、限流档位、当日负载影响很大;**不同时间跑的两轮不构成严格对照**,要比就同一时段跑完。
