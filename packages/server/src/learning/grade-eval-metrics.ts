/**
 * learning/grade-eval-metrics — `quiz.grade`（AI 阅卷）离线评测的**评分口径**（纯函数，进单测，CI 可跑）。
 *
 * ★ 指标：
 *   · 三分类准确率：verdict 与人工标注完全一致；
 *   · 二分类准确率：只看「算不算对」（correct vs partial/wrong）——界面上色与 FSRS 评级都先按这一刀切；
 *   · **误放率**：标注为 wrong 却判成 correct 的比例。这是最伤的错：学生带着误解被告知「对了」，
 *     误区也就不会进学习者模型。反方向（对的判错）会惹人烦，但学生能申诉、能看到参考答案；
 *   · 误区检出率：标注非 correct 的样本里，模型给出了 misconception 的比例（诊断是 Step 2 的卖点）；
 *   · 失败率：调用或解析失败。失败**留在分母里**，按「判错」计入准确率——丢掉失败会让准确率虚高。
 */
import type { GradeVerdict } from '@sb/shared';

export interface GradeEvalRecord {
  id: string;
  expected: GradeVerdict;
  /** null ⇒ 调用/解析失败 */
  got: GradeVerdict | null;
  score: number | null;
  misconception: string | null;
}

export interface GradeEvalSummary {
  n: number;
  failures: number;
  accuracy: number | null;
  binaryAccuracy: number | null;
  /** 标注 wrong 的样本里判成 correct 的比例；没有 wrong 样本 ⇒ null */
  falsePass: number | null;
  /** 标注非 correct 的样本里给出误区的比例 */
  diagnosis: number | null;
  /** confusion[expected][got|'fail'] */
  confusion: Record<GradeVerdict, Record<GradeVerdict | 'fail', number>>;
}

const V: GradeVerdict[] = ['correct', 'partial', 'wrong'];
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function summarizeGrade(records: GradeEvalRecord[]): GradeEvalSummary {
  const confusion = Object.fromEntries(
    V.map((e) => [e, { correct: 0, partial: 0, wrong: 0, fail: 0 }]),
  ) as GradeEvalSummary['confusion'];
  let exact = 0;
  let binary = 0;
  let failures = 0;
  let wrongN = 0;
  let falsePass = 0;
  let notCorrect = 0;
  let diagnosed = 0;
  for (const r of records) {
    confusion[r.expected][r.got ?? 'fail'] += 1;
    if (r.got === null) failures += 1;
    if (r.got === r.expected) exact += 1;
    if (r.got !== null && (r.got === 'correct') === (r.expected === 'correct')) binary += 1;
    if (r.expected === 'wrong') {
      wrongN += 1;
      if (r.got === 'correct') falsePass += 1;
    }
    if (r.expected !== 'correct') {
      notCorrect += 1;
      if (r.got !== null && r.misconception?.trim()) diagnosed += 1;
    }
  }
  const n = records.length;
  return {
    n,
    failures,
    accuracy: ratio(exact, n),
    binaryAccuracy: ratio(binary, n),
    falsePass: ratio(falsePass, wrongN),
    diagnosis: ratio(diagnosed, notCorrect),
    confusion,
  };
}

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** 指标块（markdown）。分母一律写出来：没有分母的百分比不可对质 */
export function renderGradeSummary(s: GradeEvalSummary, meta: { model: string; dataset: string; date: string; replay: boolean }): string {
  const rows = V.map((e) => `| ${e} | ${V.map((g) => s.confusion[e][g]).join(' | ')} | ${s.confusion[e].fail} |`);
  return [
    `**${meta.date}**｜模型 \`${meta.model}\`｜数据集 \`${meta.dataset}\`｜${meta.replay ? '离线重算' : '真调'}｜n=${s.n}，失败 ${s.failures}`,
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 三分类准确率 | ${pct(s.accuracy)} |`,
    `| 二分类准确率（对 / 不对） | ${pct(s.binaryAccuracy)} |`,
    `| 误放率（wrong→correct，越低越好） | ${pct(s.falsePass)} |`,
    `| 误区检出率 | ${pct(s.diagnosis)} |`,
    '',
    '| 标注 \\ 判定 | correct | partial | wrong | 失败 |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}
