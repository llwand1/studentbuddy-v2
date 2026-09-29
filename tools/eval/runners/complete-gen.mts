/**
 * tools/eval/runners/complete-gen — 「题目自包含」评测的**生成侧**（口径与读数见 `docs/eval/complete.md`）。
 *
 * 一件事：对数据集里每个 case，把 topic 交给产品自己的两条管道——
 *   · `generateQuiz(online)`：联网 AI 出题；
 *   · `collectQuiz`：现场搜集真题；
 * 把学生**会看到的题卡**（题干/材料/选项/图）原样记下来，交给评分侧（`complete.mts`）。
 *
 * ★ 与产品版本无关：只用两条管道各自的**公开入口**与零值报告，不依赖任何新增符号。
 *   所以同一份文件可以复制进「修复前提交」的 git worktree 里跑（基线臂），也能在本分支跑（本分支臂）——
 *   两臂差别只有产品代码，评测代码逐字相同。
 * ★ 逐 case 落盘、可断点续跑（`--resume`）：一次完整评测要跑一两个小时，不能因为一次 429 从头来。
 * ★ 传输失败按 `--retry` 补跑并如实记 `error`；绝不静默丢 case（分母会变小、比率虚高）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CollectReport, QuizImageReport, QuizQuestion } from '@sb/shared';
import { emptyCollectReport, emptyQuizImageReport } from '@sb/shared';
import { generateQuiz, saveQuizImage } from '../../../packages/server/src/learning/quiz.js';
import { collectQuiz } from '../../../packages/server/src/learning/collect.js';
import { imagePath } from '../../../packages/server/src/storage/image-cache.js';
import { getDb } from '../../../packages/server/src/storage/db.js';
import type { EvalCard, GenRecord } from '../../../packages/server/src/learning/complete-eval-metrics.js';
import { bootEvalEnv } from '../lib/env.mts';
import { usageFromBody } from '../lib/meter.mjs';
import { installSearchReplay, setReplayCase } from '../lib/search-replay.mts';

export interface CompleteCase {
  id: string;
  category: string;
  need: 'passage' | 'figure' | 'table' | 'none';
  topic: string;
}
export interface GenFile {
  dataset: string;
  arm: string;
  sha: string | null;
  model: string;
  visionModel: string | null;
  records: GenRecord[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 出题配比：2 单选 + 1 填空——够让模型「想出」依赖材料的题，又不至于让一个 case 跑太久 */
const MIX = { single: 2, multiple: 0, fill: 1, essay: 0, judge: 0, scenario: 0 };

function gitSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? `${sha}+patch` : sha;
  } catch {
    return null;
  }
}

/** 题 → 学生看到的卡。图片复制进报告目录（临时库随进程删掉，评分侧要读） */
function toCard(q: QuizQuestion, imgDir: string, extra: Pick<EvalCard, 'ok' | 'reason'> = {}): EvalCard {
  const card: EvalCard = {
    type: q.type,
    question: q.question,
    hasFigure: !!q.svg || !!q.photo,
    ...(q.material ? { material: q.material } : {}),
    ...(q.options ? { options: q.options.map(String) } : {}),
    ...(['single', 'multiple', 'judge'].includes(q.type) && Array.isArray(q.answer) ? { answer: (q.answer as unknown[]).filter((x): x is number => typeof x === 'number') } : {}),
    ...extra,
  };
  const name = q.photo?.src.match(/^\/api\/images\/([\w.-]+)$/)?.[1];
  const src = name ? imagePath(name) : null;
  if (name && src && fs.existsSync(src)) {
    fs.mkdirSync(imgDir, { recursive: true });
    fs.copyFileSync(src, path.join(imgDir, name));
    card.imageFile = path.join(path.basename(path.dirname(imgDir)), path.basename(imgDir), name);
  } else if (q.svg) card.svgSource = q.svg.slice(0, 3000);
  return card;
}

export async function runCompleteGen(opts: {
  dataset: string; arm: string; out: string; limit: number; only: string[]; channels: string[];
  throttleMs: number; retry: number; resume: boolean; reportsDir: string;
}): Promise<GenFile> {
  const ds = JSON.parse(fs.readFileSync(opts.dataset, 'utf8')) as { version: string; cases: CompleteCase[] };
  let cases = opts.only.length ? ds.cases.filter((c) => opts.only.includes(c.id)) : ds.cases;
  if (opts.limit > 0) cases = cases.slice(0, opts.limit);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 搜索回放：评测沙箱的出口 IP 让 Bing RSS 返回无关结果，改用人工冻结的快照（见 search-fixture.mjs）；两臂共用
  const snapFile = opts.dataset.replace(/\.json$/, '.search.json');
  if (fs.existsSync(snapFile)) installSearchReplay(snapFile);
  const env = await bootEvalEnv({ rawDir: path.join(opts.reportsDir, 'raw', `${opts.arm}-${stamp}`) });
  // 视觉角色：与被测模型同一条 provider，模型名由 SB_EVAL_VISION_MODEL 指定（两臂必须一致才可比）
  const visionModel = process.env.SB_EVAL_VISION_MODEL ?? null;
  if (visionModel) {
    getDb().prepare('INSERT OR REPLACE INTO role_bindings (role, provider_id, model, owner_id) VALUES (?, ?, ?, NULL)').run('vision', 'sb-eval-proxy', visionModel);
  }
  saveQuizImage(true, null); // 出题配图开关：两臂都开（基线也该有机会画图/配图）
  const file: GenFile = fs.existsSync(opts.out) && opts.resume
    ? (JSON.parse(fs.readFileSync(opts.out, 'utf8')) as GenFile)
    : { dataset: ds.version, arm: opts.arm, sha: gitSha(), model: env.model, visionModel, records: [] };
  const imgDir = path.join(path.dirname(opts.out), 'complete-images', opts.arm);
  const save = () => fs.writeFileSync(opts.out, JSON.stringify(file, null, 1), 'utf8');

  try {
    for (const [i, c] of cases.entries()) {
      for (const channel of ['gen', 'collect'] as const) {
        if (!opts.channels.includes(channel)) continue;
        if (file.records.some((r) => r.caseId === c.id && r.channel === channel && !r.error)) continue;
        file.records = file.records.filter((r) => !(r.caseId === c.id && r.channel === channel));
        // 模型偶发输出非法 JSON（题干里裸的英文双引号）或摘录不出题 → 产品报 parse。用户看到失败会再点一次，
        // 所以两臂同规则补跑：出题通道最多再 1 次，搜集通道最多再 2 次（页面抓取快，且单次摘录随机性大），记 attempts。
        const extra = channel === 'gen' ? 1 : 2;
        const oneTry = async (): Promise<GenRecord> => {
          let r = await runOne(c, channel, env.recorder, imgDir);
          for (let k = 0; k < extra && !r.error && r.failure === 'parse' && r.cards.length === 0; k += 1) {
            const again = await runOne(c, channel, env.recorder, imgDir);
            again.attempts = (r.attempts ?? 1) + 1;
            again.latencyMs += r.latencyMs;
            again.promptTokens = (again.promptTokens ?? 0) + (r.promptTokens ?? 0);
            again.completionTokens = (again.completionTokens ?? 0) + (r.completionTokens ?? 0);
            r = again;
          }
          return r;
        };
        let rec: GenRecord | null = null;
        for (let attempt = 0; attempt <= opts.retry; attempt += 1) {
          rec = await oneTry();
          if (!rec.error) break;
          // 限流窗口按分钟算：429 退避 60s 起步，其它传输错误按 throttle
          await sleep(/HTTP 429|rate limit/i.test(rec.error) ? 60_000 * (attempt + 1) : opts.throttleMs * (attempt + 2));
        }
        file.records.push(rec!);
        save();
        console.log(`[${opts.arm} ${i + 1}/${cases.length}] ${c.id} ${channel}: 交付 ${rec!.cards.filter((x) => x.ok !== false).length}` +
          `${rec!.cards.some((x) => x.ok === false) ? `（被拒 ${rec!.cards.filter((x) => x.ok === false).length}）` : ''} ${(rec!.latencyMs / 1000).toFixed(0)}s` +
          `${rec!.failure ? ` failure=${rec!.failure}` : ''}${rec!.error ? ` ⚠️${rec!.error.slice(0, 80)}` : ''}`);
        await sleep(opts.throttleMs);
      }
    }
  } finally {
    await env.close();
  }
  return file;

  async function runOne(c: CompleteCase, channel: 'gen' | 'collect', recorder: typeof env.recorder, dir: string): Promise<GenRecord> {
    const before = recorder.count();
    setReplayCase(c.id);
    const t0 = Date.now();
    const rec: GenRecord = { caseId: c.id, channel, latencyMs: 0, promptTokens: null, completionTokens: null, droppedByProduct: null, cards: [] };
    try {
      if (channel === 'gen') {
        const report: QuizImageReport = emptyQuizImageReport(true);
        const quiz = await generateQuiz(c.topic, undefined, MIX, report, undefined, true, null, false);
        rec.cards = (quiz?.questions ?? []).map((q) => toCard(q, dir));
        if (report.failure) rec.failure = report.failure;
        // 基线没有 completeness 字段 ⇒ 保持 null（不是 0）
        const comp = (report as QuizImageReport & { completeness?: { dropped: number } }).completeness;
        if (comp) rec.droppedByProduct = comp.dropped;
      } else {
        const report: CollectReport = emptyCollectReport();
        const res = await collectQuiz(c.topic, report, { ownerId: null });
        rec.cards = res.candidates.map((x) => toCard(x.question, dir, { ok: x.ok, ...(x.reason ? { reason: x.reason } : {}) }));
        if (report.failure) rec.failure = report.failure;
        const comp = (report as CollectReport & { completeness?: { rejectedIncomplete: number } }).completeness;
        if (comp) rec.droppedByProduct = comp.rejectedIncomplete;
      }
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
    }
    rec.latencyMs = Date.now() - t0;
    let p = 0;
    let q = 0;
    let seen = false;
    for (const g of recorder.since(before)) {
      // 429/5xx 被产品吞成 parse 之类的「正常失败」，会把限流算成模型不行。识别出来按传输错误处理，由外层退避重跑
      if (!rec.error && (g.status === 429 || g.status >= 500)) rec.error = `模型接口 HTTP ${g.status}（限流/服务端错误）`;
      const u = usageFromBody(g.responseBody);
      if (u) {
        seen = true;
        p += u.promptTokens ?? 0;
        q += u.completionTokens ?? 0;
      }
    }
    if (seen) {
      rec.promptTokens = p;
      rec.completionTokens = q;
    }
    return rec;
  }
}

/**
 * 独立入口（基线臂的 worktree 里没有新的 run.mts，直接跑这个文件）：
 *   npx tsx tools/eval/runners/complete-gen.mts --arm base [--only P01,C01] [--channels gen,collect] [--resume]
 * 本分支里 `npm run eval -- complete-gen` 走的是同一个函数。
 */
if (process.argv[1]?.endsWith('complete-gen.mts')) {
  const a = process.argv.slice(2);
  const flag = (k: string, d = ''): string => {
    const i = a.indexOf(`--${k}`);
    return i < 0 ? d : (a[i + 1] && !a[i + 1]!.startsWith('--') ? a[i + 1]! : 'true');
  };
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const reportsDir = path.resolve(root, flag('out', 'tools/eval/reports'));
  const arm = flag('arm', 'fix');
  fs.mkdirSync(reportsDir, { recursive: true });
  const r = await runCompleteGen({
    dataset: path.resolve(root, flag('dataset', 'tools/eval/datasets/complete-v1.json')), arm, reportsDir,
    out: path.join(reportsDir, `complete-gen-${arm}.json`),
    limit: Number(flag('limit', '0')),
    only: flag('only').split(',').map((s) => s.trim()).filter(Boolean),
    channels: flag('channels', 'gen,collect').split(','),
    throttleMs: Number(flag('throttle', '1500')), retry: Number(flag('retry', '1')), resume: flag('resume') === 'true',
  });
  console.log(`\n录制件：complete-gen-${arm}.json（${r.records.length} 条）`);
}
