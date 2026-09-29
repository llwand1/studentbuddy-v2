/**
 * tools/eval/runners/grade — AI 阅卷（`quiz.grade`）套件的运行侧（口径见 `grade-eval-metrics.ts`，文档 `docs/eval/grade.md`）。
 *
 * 走产品自己的 `gradeAnswer`（与 `/api/learning/grade` 同一条链，含网关的解析/修复重试），
 * 每条样本记下判定、分数与误区 ⇒ 录制件落盘后 `--replay` 可零额度重算（改口径时 CI 必红）。
 * ★ 阅卷绑定的角色是 `solver`，环境里就只借这一条 provider；ownerId 用临时库里的评测用户，
 *   判出的误区写进临时库，随环境一起删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GradeVerdict } from '@sb/shared';
import { gradeAnswer } from '../../../packages/server/src/learning/quiz-grade.js';
import { summarizeGrade } from '../../../packages/server/src/learning/grade-eval-metrics.js';
import type { GradeEvalRecord, GradeEvalSummary } from '../../../packages/server/src/learning/grade-eval-metrics.js';
import { bootEvalEnv } from '../lib/env.mts';

export interface GradeCase {
  id: string;
  qtype: 'fill' | 'essay';
  question: string;
  reference: string;
  answer: string;
  expected: GradeVerdict;
  note?: string;
}

export interface GradeRun {
  dataset: string;
  model: string;
  file: string;
  records: (GradeEvalRecord & { error?: string })[];
  summary: GradeEvalSummary;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runGradeSuite(opts: { dataset: string; limit: number; throttleMs: number; retry: number; reportsDir: string }): Promise<GradeRun> {
  const ds = JSON.parse(fs.readFileSync(opts.dataset, 'utf8')) as { version: string; cases: GradeCase[] };
  const cases = opts.limit > 0 ? ds.cases.slice(0, opts.limit) : ds.cases;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const env = await bootEvalEnv({ rawDir: path.join(opts.reportsDir, 'raw', stamp), role: 'solver' });
  const records: GradeRun['records'] = [];
  try {
    for (const [i, c] of cases.entries()) {
      let rec: GradeRun['records'][number] = { id: c.id, expected: c.expected, got: null, score: null, misconception: null };
      for (let attempt = 0; attempt <= opts.retry; attempt += 1) {
        const out = await gradeAnswer({ question: c.question, reference: c.reference, answer: c.answer, qtype: c.qtype }, 'sb-eval');
        if (out.ok) {
          rec = { ...rec, got: out.result.verdict, score: out.result.score, misconception: out.result.misconception };
          delete rec.error;
          break;
        }
        rec.error = `${out.reason}: ${out.error}`;
      }
      records.push(rec);
      console.log(`[${i + 1}/${cases.length}] ${c.id} 标注=${c.expected} 判定=${rec.got ?? '✗失败'}${rec.got && rec.got !== c.expected ? '  ←不一致' : ''}`);
      if (i < cases.length - 1) await sleep(opts.throttleMs);
    }
  } finally {
    await env.close();
  }
  fs.mkdirSync(opts.reportsDir, { recursive: true });
  const file = path.join(opts.reportsDir, `grade-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ dataset: ds.version, model: env.model, records }, null, 2), 'utf8');
  return { dataset: ds.version, model: env.model, file, records, summary: summarizeGrade(records) };
}

/** 离线重算：只读录制件，不起环境、不调模型 */
export function replayGrade(file: string): GradeRun {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataset: string; model: string; records: GradeRun['records'] };
  return { ...raw, file, summary: summarizeGrade(raw.records) };
}
