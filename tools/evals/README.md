# tools/evals — 出题能力评测(eval)

衡量**真模型**在本产品核心场景(按 `QUIZ_PROTOCOL` 出题)上的输出质量。与 `packages/**` 的 2997 个确定性单测互补:单测锁"代码对不对",eval 锁"模型好不好"——换模型、换 provider、改提示词之前后各跑一遍,分数变化就是决策依据。

## 快速开始

```bash
# 1. 评分器自检(19 条坏夹具逐一必须被抓到;零 key 零网络)
node tools/evals/run.mjs --selftest

# 2. 假模型验通路(应当全绿;零 key 零网络,同 demo:e2e 的假 LLM 哲学)
node tools/evals/run.mjs --fake

# 3. 真模型跑分(任意 OpenAI 兼容端点,自带 Key)
EVAL_API_KEY=sk-xxx EVAL_MODEL=gpt-4o-mini node tools/evals/run.mjs
EVAL_API_BASE=https://api.deepseek.com/v1 EVAL_API_KEY=sk-xxx EVAL_MODEL=deepseek-chat node tools/evals/run.mjs

# 可选:再让模型当裁判打质量分(正确性/清晰度/干扰项 1..5)
EVAL_API_KEY=... EVAL_MODEL=... node tools/evals/run.mjs --judge

# 接 CI:总分低于 0.9 退出码 1
node tools/evals/run.mjs --fake --check 0.9
```

报告落在 `tools/evals/results/<tag>.md`(汇总)与 `.json`(逐用例逐检查原始数据)。

## 纪律(与仓库既有哲学对齐)

- **协议不许手抄**:提示词里的 `QUIZ_PROTOCOL` 运行时直接从 `packages/server/src/learning/quiz.ts` 源码提取——生产协议改了,eval 自动跟着改(同 `tools/metrics.mjs` 的对账纪律)。配比指令镜像 `buildMixInstruction` 措辞。
- **零依赖**:纯 Node ≥ 22,`fetch` 走内建。
- **评分器自己也有判断标准**:`--selftest` 用 19 条"各坏在一处"的夹具断言每个检查器都抓得到自己的目标缺陷,防止"评分器全绿只是因为它什么都不查"。

## 数据集 `datasets/quiz-gen.jsonl`

20 例,一行一个 JSON:`{ id, domain, lang, mix, material }`。覆盖 12 个学科领域 + 边界:超短材料(quiz-018)、超长材料(quiz-020)、英文材料(quiz-019)、单题型/无选择题/判断题堆叠等极端配比。`mix` 只含五种生产题型(`single/multiple/fill/essay/judge`,与 `QUIZ_TYPES` 同序);scenario 走独立协议(`scenario-protocol.ts`),不在本 eval 范围。

加用例:追加一行即可;`--only quiz-0` 可只跑前缀匹配的子集。

## 检查项(依据 = QUIZ_PROTOCOL 规则段 + normalizeQuiz/applyQuizMix 实际行为)

| 检查 | 层级 | 锁什么 |
| --- | --- | --- |
| wrap | hard | 恰好一对 `[QUIZ]...[/QUIZ]`,标记外零多余文字 |
| json | hard | 标记体是合法 JSON |
| schema | hard | title/questions;每题 type/question/answer/explanation/svg/refs 一个不省 |
| mix | hard | 各题型数量与要求**精确**一致,自造题型算失败 |
| order | hard | questions 按题型顺序排列 |
| answers | hard | single/judge 单下标、judge 选项恒 `["正确","错误"]`、fill 空位数=答案数、essay 有参考要点 |
| options | hard | 选择题 ≥3 项、非空、不重复、下标不越界 |
| leakage | hard | 正确选项原文不出现在题干(送分题) |
| refs | hard | 无检索资料场景下 refs 必须为 `[]`(编造引用=失败) |
| svg | hard | 给了就得是 `<svg>`;照抄协议示例方框=失败(协议原话) |
| grounding | soft | 题干与材料字符 bigram 重叠 ≥0.22(「必须源于材料」粗启发) |
| explanation | soft | 非 essay 题解析非空 |

得分:hard 每项 1 分、soft 每项 0.5 分,用例得分=拿到/满分,总分=用例均值。soft 是启发式(尤其 grounding 对改写幅度大的好题可能误报),所以只减半计分——看报告时先看 hard 红了什么。

## 已知边界

- 评的是**协议服从性与结构质量**;"答案在学科上是否真对"这类语义正确性,规则查不了,交给 `--judge`(模型裁判,有裁判自身偏差,只作参考分)。
- eval 的提示词装配(协议+配比+材料)是生产链路的简化镜像:不含检索资料块与配图要求块——所以 refs 必须为空、svg 不强制产出。要评带检索/配图的链路,加数据集字段扩展 `buildPrompt` 即可。
