/**
 * tools/eval/lib/render — 把评测指标渲染成进仓的 markdown（当前只有 quiz）。
 *
 * ★ 三条排版纪律（都是为了让数字**可被质疑**）：
 *   ① 每个比率都写成 `n/d（xx.x%）`——只给百分比就会重现隔壁评测台「7/13 读成 12/13」那类误读；
 *   ② 分母为 0 一律 `—（无分母）`，**绝不写 0%**：0% 是「一个都没成」，`—` 是「今天没测」，
 *      两者的行动指引完全相反；
 *   ③ 传输层失败（429/超时）单独一列摆在最上面——它决定其余所有比率的可信度。
 *      补跑过几次的词条也照实列出来，读的人才知道这轮跑得干不干净。
 *   ④ 报告头必须能**复现这一轮**：代码版本、采样参数、随机种子、花了多少钱。
 *      缺哪项就写「—」并说明拿不到的**原因**——`docs/eval/quiz.md` §1 把这四项登记为欠账，
 *      就是因为「一份看不出是哪版代码跑的报告，过两周谁也不敢引用」。
 */
import path from 'node:path';
import type { QuizEvalSummary } from '../../../packages/server/src/learning/quiz-eval-metrics.js';
import type { QuizRunRecord, RunProvenance, RunResult } from '../runners/quiz.mts';
import { fmtUsd } from './pricing.mjs';

const ARM_TITLES: Record<string, string> = {
  base: 'arm `base`（关配图）——量纯出题链',
  img: 'arm `img`（开配图）——产图率/留图率只在这一档有意义',
};

/** 比率：分母 0 ⇒ 明确写「无分母」，不写 0% */
function pct(f: { n: number; d: number }): string {
  if (f.d === 0) return `${f.n}/0 —（无分母）`;
  return `${f.n}/${f.d}（${((f.n / f.d) * 100).toFixed(1)}%）`;
}

const GB = ['strict', 'repaired', 'rescued', 'failed'] as const;
const GB_LABEL: Record<(typeof GB)[number], string> = {
  strict: '一次成型（原样 JSON 合法）',
  repaired: '靠无损修复（漏括号/漏转义）',
  rescued: '靠抢救（剥 svg／截断逐题回退）',
  failed: '整组没解出（用户看到的 502）',
};

function metricTable(s: QuizEvalSummary): string {
  const rows: Array<[string, string]> = [
    ['成功率（组）＝交付≥1 题', pct(s.success)],
    ['完美出题率（组）＝一次成型∧满配∧字段全齐∧零丢图∧零截断∧零重复', pct(s.perfectRun)],
    ['一次成型率（组）', pct(s.firstParse)],
    ['满配率＝按题型出齐｜分母＝有交付的组', pct(s.matched)],
    ['题级交付率＝Σ交付题/Σ请求题', pct(s.questionDelivery)],
    ['字段齐全率＝体检全过的题/交付题', pct(s.completeQuestion)],
    ['坏答案题数（判分必错）', String(s.badAnswer)],
    ['组内重复题数', String(s.duplicates)],
    ['撞输出上限的组数', String(s.truncatedRuns)],
    ['被剥掉的坏图数', String(s.droppedSvg)],
  ];
  const img = s.image
    ? ([
        ['产图率＝交付带图题/交付题', pct(s.image.produced)],
        ['留图率＝交付带图题/模型画出的图', pct(s.image.retained)],
        ['出图组占比＝至少 1 图的组/开配图的组', pct(s.image.groupsWithImage)],
      ] as Array<[string, string]>)
    : [];
  return [
    '| 指标 | 值 |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    ...img.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '**一次出组定性（互斥且穷尽）**',
    '',
    '| 定性 | 组数 |',
    '| --- | --- |',
    ...GB.map((g) => `| ${GB_LABEL[g]} | ${s.byGrade[g]} |`),
    '',
    '**逐题型**',
    '',
    '| 题型 | 请求 | 交付 | 字段齐全 | 坏答案 |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(s.byType).map(([t, v]) => `| ${t} | ${v.requested} | ${v.delivered} | ${v.complete} | ${v.answerInvalid} |`),
    '',
    s.latencyMs
      ? `**时延** p50 ${s.latencyMs.p50}ms／p95 ${s.latencyMs.p95}ms／max ${s.latencyMs.max}ms`
      : '**时延** 无记录',
  ].join('\n');
}

function failureList(records: QuizRunRecord[]): string {
  const bad = records.filter((r) => r.transportError || !r.delivered || (r.delivered?.questions.length ?? 0) === 0);
  if (bad.length === 0) return '本轮无失败组。';
  return [
    '| 词条 | arm | 真因 | 补跑次数 |',
    '| --- | --- | --- | --- |',
    ...bad.map((r) => {
      const why =
        r.transportError ??
        (r.imageReport.failure === 'no-model'
          ? 'no-model（角色模型没配上）'
          : r.imageReport.failure === 'parse'
            ? 'parse（模型有输出但解不成题组）'
            : 'empty（解出了题组却一题不剩）');
      return `| ${r.caseId} | ${r.arm} | ${why} | ${r.attempts} |`;
    }),
  ].join('\n');
}

/**
 * 报告头的可复现七项。
 * 每一项拿不到都写「—（原因）」：读的人要能分清「这轮没花钱」和「这轮没记账」。
 */
function provenanceTable(p: RunProvenance | undefined, model: string): string {
  if (!p) return '_本轮无出处记录（录制件早于本功能）。_';
  const dash = (why: string) => `— <sub>${why}</sub>`;
  const temp =
    p.tempSpread ? `${p.tempSpread.join(' / ')} <sub>（同轮多档，按场景分）</sub>` : p.temperature != null ? String(p.temperature) : dash('请求体里没有该字段');
  const costCell =
    p.costUsd == null
      ? dash(p.totalRuns > 0 ? '上游没回 usage，或价表无此模型 —— 不是 0' : '本轮没有调用')
      : `${fmtUsd(p.costUsd)} <sub>（记账 ${p.costedRuns}/${p.totalRuns} 组${p.costedRuns < p.totalRuns ? '，**未覆盖全部**，实际花费更高' : ''}）</sub>`;
  const rows: Array<[string, string]> = [
    ['代码版本', p.gitSha ? `\`${p.gitSha}\`${p.gitSha.endsWith('-dirty') ? ' ⚠ **工作区有未提交改动，这一轮别人还原不了**' : ''}` : dash('不在 git 工作树里')],
    ['模型', `\`${p.requestedModel ?? model}\``],
    ['temperature', temp],
    ['max_tokens', p.maxTokens != null ? String(p.maxTokens) : dash('请求体里没有该字段')],
    ['随机种子', p.seed != null ? String(p.seed) : dash('产品不传 seed —— 本评测**不可逐位复现**，只可统计复现')],
    ['token（prompt/completion）', p.promptTokens || p.completionTokens ? `${p.promptTokens} / ${p.completionTokens}` : dash('上游没回 usage')],
    ['本轮成本', costCell],
    ['价表', p.priceNote],
  ];
  return ['| 出处项 | 值 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

export function renderQuizDoc(
  result: RunResult,
  meta: { writeAt: string; replay: boolean; datasetFile: string },
): string {
  const attempts = result.records.reduce((a, r) => a + r.attempts, 0);
  const transport = result.records.filter((r) => r.transportError).length;
  const requestedPerRun = result.records[0]?.mix ? Object.values(result.records[0].mix).reduce((a, b) => a + b, 0) : 0;
  return [
    `> 本块由 \`npm run eval -- quiz\` 生成于 ${meta.writeAt}${meta.replay ? '（**离线重算**，未调模型）' : ''}。`,
    `> 数据集 \`${result.dataset}\`${meta.datasetFile ? `（\`${path.basename(meta.datasetFile)}\`，provenance=dev-hand）` : ''}／模型 \`${result.model}\`／`,
    `> 组数 ${result.records.length}／上游实际调用 ${attempts} 次／每组请求 ${requestedPerRun} 题／传输层失败 ${transport} 组。`,
    '',
    '### 这一轮是怎么跑出来的（出处）',
    '',
    provenanceTable(result.provenance, result.model),
    '',
    ...result.summaries.map(({ arm, summary }) => [
      `### ${ARM_TITLES[arm] ?? `\`arm ${arm}\`（${summary.runs} 组）`}`,
      '',
      `组数 ${summary.runs}／传输层失败 ${summary.transportErrors} 组`,
      '',
      metricTable(summary),
    ].join('\n')),
    '',
    '### 失败组逐条（不合并、不省略）',
    '',
    failureList(result.records),
  ].join('\n');
}
