/**
 * media/vision-eval-metrics — 看图核验离线评测口径（纯函数，进单测）。
 *
 * ★ 最要紧的是**误收率**：干扰主题（相近概念）被判 yes ⇒ 错图会被放进对话/题目。
 *   误拒（该收判 no）只是少一张图，代价小得多。
 * ★ 泄露：标注会泄露的样本里判出泄露的比例（检出率），以及不该泄露却判泄露的比例（误报）。
 * ★ 失败留在分母，按判错计。时延单列 p50/p95（每张图一次视觉调用，找图时要乘候选数）。
 */
import type { ImageMatch } from './image-verify.js';

export interface VisionEvalRecord {
  id: string;
  expect: ImageMatch[];
  got: ImageMatch | null;
  latencyMs: number;
  expectLeak?: boolean;
  gotLeak?: boolean | null;
}

export interface VisionEvalSummary {
  n: number;
  failures: number;
  accuracy: number | null;
  /** 期望 no 却判 yes 的比例 */
  falseAccept: number | null;
  /** 期望含 yes 却判 no 的比例 */
  falseReject: number | null;
  leakRecall: number | null;
  leakFalseAlarm: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

export function summarizeVision(rs: VisionEvalRecord[]): VisionEvalSummary {
  let ok = 0, fail = 0, negN = 0, fa = 0, posN = 0, fr = 0, leakN = 0, leakHit = 0, cleanN = 0, leakFa = 0;
  const lat: number[] = [];
  for (const r of rs) {
    if (r.got === null) fail += 1;
    else lat.push(r.latencyMs);
    if (r.got !== null && r.expect.includes(r.got)) ok += 1;
    if (r.expect.length === 1 && r.expect[0] === 'no') {
      negN += 1;
      if (r.got === 'yes') fa += 1;
    }
    if (r.expect.includes('yes')) {
      posN += 1;
      if (r.got === 'no') fr += 1;
    }
    if (r.expectLeak === true) {
      leakN += 1;
      if (r.gotLeak === true) leakHit += 1;
    } else if (r.expectLeak === false) {
      cleanN += 1;
      if (r.gotLeak === true) leakFa += 1;
    }
  }
  lat.sort((a, b) => a - b);
  return {
    n: rs.length,
    failures: fail,
    accuracy: ratio(ok, rs.length),
    falseAccept: ratio(fa, negN),
    falseReject: ratio(fr, posN),
    leakRecall: ratio(leakHit, leakN),
    leakFalseAlarm: ratio(leakFa, cleanN),
    p50Ms: pct(lat, 0.5),
    p95Ms: pct(lat, 0.95),
  };
}

const p = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const ms = (x: number | null) => (x === null ? '—' : `${(x / 1000).toFixed(1)}s`);

export function renderVisionSummary(s: VisionEvalSummary, meta: { model: string; dataset: string; date: string; replay: boolean }): string {
  return [
    `**${meta.date}**｜模型 \`${meta.model}\`｜数据集 \`${meta.dataset}\`｜${meta.replay ? '离线重算' : '真调'}｜n=${s.n}，失败 ${s.failures}`,
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 判定准确率 | ${p(s.accuracy)} |`,
    `| **误收率**（相近干扰判成 yes，越低越好） | ${p(s.falseAccept)} |`,
    `| 误拒率（该收判 no） | ${p(s.falseReject)} |`,
    `| 答案泄露检出率 | ${p(s.leakRecall)} |`,
    `| 泄露误报率 | ${p(s.leakFalseAlarm)} |`,
    `| 单张时延 p50／p95 | ${ms(s.p50Ms)}／${ms(s.p95Ms)} |`,
  ].join('\n');
}
