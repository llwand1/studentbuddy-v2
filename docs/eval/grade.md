# AI 阅卷评测（`quiz.grade`）

量的是 Step 2 的量规阅卷：填空/解答题交给模型判 correct / partial / wrong，并诊断误区。

- **数据集**：`tools/eval/datasets/grade-v1.json`，24 条人工标注（12 correct / 3 partial / 9 wrong）。
  填空侧重等价判断（化学式、单位、英文名、千分位），解答侧重要点齐全与典型误区（暗反应＝夜间、惯性是力……）。
- **口径**（`packages/server/src/learning/grade-eval-metrics.ts`，有单测）：
  - 三分类准确率、二分类准确率（对 / 不对）；
  - **误放率**：标注 wrong 判成 correct 的比例，最该压低的指标（学生带着误解被告知「对了」）；
  - 误区检出率：非 correct 样本里给出误区的比例；
  - 调用失败留在分母里，按判错计。
- **运行**：`npm run eval -- grade`（24 次真调，需要本机真实库里有 solver 角色的 provider）；
  `npm run eval -- grade --replay tools/eval/reports/grade-*.json --check` 零额度重算。

## 指标

还没有真调记录（沙箱里没有模型 key）。在有 key 的机器上跑一次，下面这块会被自动覆写。

<!-- eval:grade:begin -->
（待首次运行）
<!-- eval:grade:end -->
