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
import { samplingFromRequest, usageFromBody } from '../lib/meter.mjs';
import { costOf, priceProvenance } from '../lib/pricing.mjs';
import { execFileSync } from 'node:child_process';

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
  /**
   * 采样参数：**从实际发出去的请求体里读**，不是抄来的。
   * 评测台一行不改产品参数（见文件头注），所以温度/种子到底是多少，只有请求体知道。
   * 老录制件没有这个字段 ⇒ `undefined`，渲染成「—」。
   */
  sampling?: ReturnType<typeof samplingFromRequest>;
  /**
   * 用量：从上游响应体里抠（非流式 `usage` 或 SSE 末块的 usage），按**本组全部调用**求和。
   * 上游一笔都不回 ⇒ `undefined`。`callsMissingUsage>0` 时这组是**漏记的下界**。
   */
  usage?: (NonNullable<ReturnType<typeof usageFromBody>> & { callsMissingUsage: number }) | undefined;
  /** 成本（美元）：用量 × `tools/eval/pricing.json`；查不到价或没有用量 ⇒ null（**不是 0**） */
  costUsd?: number | null;
}

/** 报告头的「可复现七项」（评测契约要求，`docs/eval/quiz.md` §1 登记为批次 B 前必补） */
export interface RunProvenance {
  /** 代码版本；dirty ⇒ 这一轮别人还原不了 */
  gitSha: string | null;
  temperature: number | null;
  maxTokens: number | null;
  /** 产品不传 seed ⇒ null。照实写「未设」，不编一个出来 */
  seed: number | null;
  /** 这一轮实际用的模型名（从请求体读，与库里绑的那条对账） */
  requestedModel: string | null;
  /** 成本合计；`costedRuns` 是**真的算出了钱**的组数——没有它，总额会被读成全量的账 */
  costUsd: number | null;
  costedRuns: number;
  totalRuns: number;
  promptTokens: number;
  completionTokens: number;
  priceNote: string;
  /** 同轮里出现多档温度时列出全部；否则 null。报告头报单值会骗人 */
  tempSpread: string[] | null;
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
  /** 报告头的可复现七项（`docs/eval/quiz.md` §1 登记的欠账） */
  provenance: RunProvenance;
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
): Promise<QuizEvalRunInput & Pick<QuizRunRecord, 'sampling' | 'usage' | 'costUsd'>> {
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
  // ★ 计量按**这一组的全部调用**求和，不是只看最后一笔（出题链会多打几次上游）
  const group = recorder.since(before);
  const sampling = samplingFromRequest(group[0]?.requestBody) ?? undefined;
  const acc = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  let sawUsage = false;
  let usageMissing = 0;
  for (const g of group) {
    const u = usageFromBody(g.responseBody);
    if (!u) {
      usageMissing += 1; // 这一笔没记上账 ⇒ 下面的成本是**下界**，不是全额
      continue;
    }
    sawUsage = true;
    acc.promptTokens += u.promptTokens ?? 0;
    acc.completionTokens += u.completionTokens ?? 0;
    acc.totalTokens += u.totalTokens ?? 0;
    acc.reasoningTokens += u.reasoningTokens ?? 0;
    acc.cachedTokens += u.cachedTokens ?? 0;
  }
  const usage = sawUsage ? { ...acc, source: 'api' as const, callsMissingUsage: usageMissing } : undefined;
  // 价表查不到 ⇒ null（报告写「—」）。**绝不落 0**：0 会被读成「这轮不要钱」
  const costUsd = usage ? (costOf(sampling?.model ?? model, usage)?.usd ?? null) : null;
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
    sampling,
    usage,
    costUsd,
  };
}

/**
 * 代码版本 + 工作区是否干净。
 * 拿不到（比如打包发布后没有 .git）就是 null —— 报告里写「—」，不编一个假的 sha。
 */
function gitSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

/**
 * 把「可复现七项」从**录制件**里汇总出来。
 *
 * 为什么不直接读配置：评测台一行不改产品参数，产品内部用什么温度、传不传 seed，
 * 配置文件上看不出来；只有真发出去的那个请求体作数。录制件缺字段 ⇒ 该项 null ⇒ 报告写「—」。
 */
export function collectProvenance(records: QuizRunRecord[]): RunProvenance {
  const sampled = records.map((r) => r.sampling).filter((x): x is NonNullable<typeof x> => !!x);
  const first = sampled[0] ?? null;
  // 同一轮里温度若不一致，说明产品按场景分了档 —— 报告只报第一档会骗人，这里直接标出来
  const temps = [...new Set(sampled.map((s) => s.temperature).filter((t) => t != null))];
  let costUsd: number | null = null;
  let costedRuns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const r of records) {
    if (r.usage) {
      promptTokens += r.usage.promptTokens ?? 0;
      completionTokens += r.usage.completionTokens ?? 0;
    }
    if (typeof r.costUsd === 'number') {
      costUsd = (costUsd ?? 0) + r.costUsd;
      costedRuns += 1;
    }
  }
  const model = first?.model ?? records[0]?.model ?? null;
  return {
    gitSha: gitSha(),
    temperature: temps.length > 1 ? null : (first?.temperature ?? null),
    maxTokens: first?.maxTokens ?? null,
    seed: first?.seed ?? null,
    requestedModel: model,
    costUsd,
    costedRuns,
    totalRuns: records.length,
    promptTokens,
    completionTokens,
    priceNote: model ? priceProvenance(model) : '未知模型 —— 无法定价',
    tempSpread: temps.length > 1 ? temps.map(String) : null,
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
      {
        dataset: dataset.version,
        model: env.model,
        stamp,
        arms: opts.arms,
        cases: cases.length,
        provenance: collectProvenance(records),
        records,
      },
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
    provenance: collectProvenance(records),
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
    // 重算走的是**录制件里存的**采样/用量。老录制件没有这些字段 ⇒ 各项 null ⇒ 报告写「—」，
    // 而不是拿今天的价表去补一个当时并不存在的数。
    provenance: collectProvenance(records),
  };
}
