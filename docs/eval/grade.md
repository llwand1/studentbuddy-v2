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

首轮真调（2026-09-29，`agnes-2.5-flash`，走 `SB_EVAL_BASE_URL/API_KEY/MODEL` 覆写通道）：

- **误放率 0/9**：没有一条错答被判成对；所有非 correct 样本都给出了具体误区。
- 仅有的 2 处不一致**都偏严**（标注 correct → 判 partial，分数 0.8 / 0.75）：
  - `e01`：学生写「把 ADP 和 NADP+ 还回去」，漏了 Pi，模型指出了这一点。严格按参考答案，模型是对的，这条标注本身偏宽；
  - `e11`：用例子讲对了，但没说「其他条件不变」这个前提。算不算扣分见仁见智。
  - **标注没有事后改**：跑完再改标注等于给自己刷分。是否调整留给人工复核，改了要在这里记一笔。
- 首跑踩坑：免费档限流（429）一分钟内连撞 7 次，原来的补跑是立即重试，于是全挂。现在 429 退避 15s×次数，全量跑推荐 `--retry 3 --throttle 3000`（24 条约 5 分钟）。

<!-- eval:grade:begin -->
**2026-09-29**｜模型 `agnes-2.5-flash`｜数据集 `grade-v1`｜真调｜n=24，失败 0

| 指标 | 值 |
|---|---|
| 三分类准确率 | 91.7% |
| 二分类准确率（对 / 不对） | 91.7% |
| 误放率（wrong→correct，越低越好） | 0.0% |
| 误区检出率 | 100.0% |

| 标注 \ 判定 | correct | partial | wrong | 失败 |
|---|---|---|---|---|
| correct | 10 | 2 | 0 | 0 |
| partial | 0 | 3 | 0 | 0 |
| wrong | 0 | 0 | 9 | 0 |
<!-- eval:grade:end -->
