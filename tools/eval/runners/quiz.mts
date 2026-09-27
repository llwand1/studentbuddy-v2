/**
 * tools/eval/runners/quiz — 出题套件的**运行侧**（判据抄录见 `docs/eval/quiz.md`，批次 A＝零裁判）。
 *
 * 一件事：把 `tools/eval/datasets/terms-v1.json` 的每个词条按两个 arm 喂给**产品自己的出题管道**，
 * 把每次真调的输入输出原样记下来，交给 `quiz-eval-metrics.ts` 的口径打分。
 *
 * ★ 为什么走 `generateBlendedQuiz` 而不是 `generateQuiz`：路由 `/api/quiz/generate` 调的是前者，
 *   评测要量的是**用户实际经过的那条链**（含合流层的裁剪与报告透传）。绕开它就等于给一条
 *   没人走过的路刷分。真题侧配比恒取默认全 0——那是 §3.4 collect 套件的事，不混进本套件的题数。
 *
 * ★ 为什么每次真调都留一份原始文本：一次成型率量的是模型**第一遍写的 JSON 干不干净**，
 *   产品返回值里这段已被解析阶梯消化掉了（见 `lib/recorder.mts` 头注）。
 *   原文＋交付题组一起落盘后，`scoreQuizRun` 就是纯函数 ⇒ 同一份录制可离线重算（`replayScores`），
 *   CI 的 quiz 口径回归闸因此零成本、零额度，且**改评分口径时必红**（改模型提示词才可能变绿）。
 *
 * ★ 防呆（隔壁 `doc-rag-eval` 第一版的教训：把 7/13 读成 12/13）：
 *   ① 一笔调用若没在录制代理上留下记录，记 `no-call-recorded`；留下了记录却抽不出文本，记
 *      `empty-recording`——两者都判传输失败、**不算一次成型**。「模型压根没被调到」与「评测台读坏了」
 *      都不能读成好指标（后者是本文件第一版真撞上的：适配器恒发 SSE，而抽取只认非流式形状）；
 *   ② 传输失败按 `--retry` 补跑同一词条，补跑次数如实记进 `attempts`，
 *      绝不静默丢弃失败组（丢了分母就变小、成功率虚高）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { QuizImageReport, QuizMix, QuizMixReport, QuizPayload } from '@sb/shared';
import { DEFAULT_QUIZ_SOURCE_MIX, countQuizImages, emptyQuizImageReport, mixTotal } from '@sb/shared';
import { generateBlendedQuiz } from '../../../packages/server/src/learning/quiz-blend.js';
import { saveQuizImage } from '../../../packages/server/src/learning/quiz.js';
import { scoreQuizRun, summarizeRuns } from '../../../packages/server/src/learning/quiz-eval-metrics.js';
import type {
  QuizEvalRunInput,
  QuizEvalSummary,
  QuizRunScore,
} from '../../../packages/server/src/learning/quiz-eval-metrics.js';
import { bootEvalEnv } from '../lib/env.mts';
import { recordedText } from '../lib/recorder.mts';
import type { Recorder } from '../lib/recorder.mts';

export interface QuizCase {
  id: string;
  discipline: string;
  difficulty: string;
  topic: string;
  excerpt: string;
}

export interface QuizDataset {
  version: string;
  mix: QuizMix;
  cases: QuizCase[];
}

/** 一次真调的**完整留痕**：既是打分的输入，也是离线重算的输入 */
export interface QuizRunRecord extends QuizEvalRunInput {
  arm: string;
  /** 含补跑：1 ＝ 一次成功，>1 ⇒ 前面几次是传输失败（429/超时） */
  attempts: number;
}

export interface RunOpts {
  dataset: string;
  arms: string[];
  limit: number;
  /** 两次真调之间的间隔（免费档 250 次/5 小时，且本仓无退避重试） */
  throttleMs: number;
  /** 传输层失败时对同一词条的补跑次数上限 */
  retry: number;
  reportsDir: string;
}

export interface RunResult {
  dataset: string;
  model: string;
  stamp: string;
  file: string;
  records: QuizRunRecord[];
  scores: QuizRunScore[];
  summaries: Array<{ arm: string; summary: QuizEvalSummary }>;
}

const ARM_IMAGE: Record<string, boolean> = { base: false, img: true };

export function loadDataset(file: string): QuizDataset {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as QuizDataset;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error(`数据集没有题目：${file}`);
  for (const c of raw.cases) {
    if (!c.id || !c.topic || !c.excerpt) throw new Error(`数据集条目缺 id/topic/excerpt：${c.id ?? '(无 id)'}`);
  }
  if (mixTotal(raw.mix) === 0) throw new Error('数据集配比为全 0：每词条都会得到空题组');
  return raw;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runOnce(
  c: QuizCase,
  mix: QuizMix,
  imageOn: boolean,
  model: string,
  recorder: Recorder,
): Promise<QuizEvalRunInput> {
  const images: QuizImageReport = emptyQuizImageReport(imageOn);
  let delivered: QuizPayload | null = null;
  const aiMixReport: QuizMixReport = { requested: mix, actual: mix, matched: false };
  const before = recorder.count();
  const started = Date.now();
  let transportError: string | undefined;
  try {
    // 真题侧恒为默认全 0（不出真题）：本套件只量 AI 出题链，`online=false` 同义于「不联网」
    const blended = await generateBlendedQuiz(
      c.topic,
      c.excerpt,
      mix,
      { ...DEFAULT_QUIZ_SOURCE_MIX },
      images,
      undefined,
      false,
      null,
    );
    delivered = blended.quiz;
    Object.assign(aiMixReport, blended.report.ai);
    // 与路由同源的一步：交付图数在配比裁剪**后**数
    if (delivered) images.delivered = countQuizImages(delivered);
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  }
  const calls = recorder.count() - before;
  const rec = calls > 0 ? recorder.last() : null;
  const rawText = recordedText(rec);
  // ★ 防呆①：一笔都没发到上游 ⇒ 没有原文，绝不能读成「一次成型」
  if (!transportError && calls === 0) transportError = 'no-call-recorded';
  if (!transportError && rec && rec.status !== 200) transportError = `http-${rec.status}`;
  // ★ 防呆②（SSE 假指标的门）：上游回了 200 却抽不出文本 ⇒ 是**评测台读坏了**，不是模型写坏了。
  //   不拦下来就会读成「JSON 解不出但产品救出了题」= rescued，一整轮的一次成型率全废。
  if (!transportError && rec?.status === 200 && rawText.trim() === '') transportError = 'empty-recording';
  return {
    caseId: c.id,
    topic: c.topic,
    discipline: c.discipline,
    imageOn,
    mix,
    rawText,
    delivered,
    imageReport: images,
    aiMixReport,
    latencyMs: Date.now() - started,
    model,
    transportError,
  };
}

export async function runQuizSuite(opts: RunOpts): Promise<RunResult> {
  const dataset = loadDataset(opts.dataset);
  const cases = opts.limit > 0 ? dataset.cases.slice(0, opts.limit) : dataset.cases;
  for (const arm of opts.arms) {
    if (!(arm in ARM_IMAGE)) throw new Error(`未知 arm：${arm}（可选 base / img）`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const records: QuizRunRecord[] = [];
  const env = await bootEvalEnv({ rawDir: path.join(opts.reportsDir, 'raw', stamp) });
  try {
    for (const arm of opts.arms) {
      const imageOn = ARM_IMAGE[arm] ?? false;
      saveQuizImage(imageOn, null); // 配图硬门读这一行：提示词与解析必须同源
      for (const [i, c] of cases.entries()) {
        let input = await runOnce(c, dataset.mix, imageOn, env.model, env.recorder);
        let attempts = 1;
        while (input.transportError && attempts <= opts.retry) {
          attempts += 1;
          await sleep(opts.throttleMs);
          input = await runOnce(c, dataset.mix, imageOn, env.model, env.recorder);
        }
        const score = scoreQuizRun(input);
        records.push({ ...input, arm, attempts });
        const mark = score.perfect ? '✓' : score.success ? '·' : '✗';
        console.log(
          `[${arm} ${i + 1}/${cases.length}] ${c.id} ${mark} grade=${score.grade} ` +
            `题=${score.deliveredTotal}/${score.requestedTotal} 图=${score.svgDelivered}/${score.svgInRaw ?? '-'} ` +
            `${Math.round(score.latencyMs / 100) / 10}s 试${attempts}次` +
            `${score.transportError ? ` ⚠️${score.transportError}` : ''}`,
        );
        if (i < cases.length - 1) await sleep(opts.throttleMs);
      }
    }
  } finally {
    await env.close();
  }
  const scores = records.map((r) => scoreQuizRun(r));
  fs.mkdirSync(opts.reportsDir, { recursive: true });
  const file = path.join(opts.reportsDir, `quiz-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      { dataset: dataset.version, model: env.model, stamp, arms: opts.arms, cases: cases.length, records },
      null,
      2,
    ),
    'utf8',
  );
  return {
    dataset: dataset.version,
    model: env.model,
    stamp,
    file,
    records,
    scores,
    summaries: summarizeByArm(scores),
  };
}

/** 逐 arm 汇总：两个 arm 的数**永不合并成一个**（配图开与关是两种条件） */
export function summarizeByArm(scores: QuizRunScore[]): Array<{ arm: string; summary: QuizEvalSummary }> {
  const arms = new Map<string, QuizRunScore[]>();
  for (const s of scores) {
    const arm = s.imageOn ? 'img' : 'base';
    const list = arms.get(arm);
    if (list) list.push(s);
    else arms.set(arm, [s]);
  }
  return [...arms.entries()].map(([arm, list]) => ({ arm, summary: summarizeRuns(list) }));
}

/**
 * 离线重算：读一份录制件，拿**存下来的原文与交付题组**重跑 `scoreQuizRun`。
 * 不碰模型、不占额度 ⇒ 判据是「改了评分口径这里必红」，与「模型今天心情如何」无关。
 */
export function replayScores(file: string): RunResult {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    dataset: string;
    model: string;
    stamp: string;
    records: QuizRunRecord[];
  };
  const records = stored.records ?? [];
  if (records.length === 0) throw new Error(`录制件里没有记录：${file}`);
  const scores = records.map((r) => scoreQuizRun(r));
  return {
    dataset: stored.dataset,
    model: stored.model,
    stamp: stored.stamp,
    file,
    records,
    scores,
    summaries: summarizeByArm(scores),
  };
}
