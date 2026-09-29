/**
 * tools/eval/run.mts — 功能评测台**唯一入口**（口径与判据内联在 `docs/eval/quiz.md`）。
 *
 * 用法：
 *   npm run eval -- quiz --limit 3 --arms base          # 冒烟（3 次真调）
 *   npm run eval -- quiz                                # 全套（18 词条 × 2 arm = 36 次真调）
 *   npm run eval -- quiz --replay <reports/quiz-x.json> # 零额度离线重算（CI 口径回归闸）
 *   npm run eval -- grade                               # AI 阅卷（24 条人工标注，24 次真调）
 *   npm run eval -- grade --replay <reports/grade-x.json>
 *
 * ★ 为什么真调要单独一条命令、且不进 `npm run check`：本仓 check 必须离线可跑（CI 无 key）。
 *   评测的**评分口径**进单测（`quiz-eval-metrics.test.ts`，纯函数），**跑真模型**留给本地/发版前手动，
 *   数字落地进 `docs/eval/quiz.md`（有日期、有模型名、有分母，才是可对质的证据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { replayScores, runQuizSuite } from './runners/quiz.mts';
import { renderQuizDoc } from './lib/render.mts';
import { replayGrade, runGradeSuite, type GradeRun } from './runners/grade.mts';
import { replayVision, runVisionSuite, type VisionRun } from './runners/vision.mts';
import { renderVisionSummary } from '../../packages/server/src/media/vision-eval-metrics.js';
import { renderGradeSummary } from '../../packages/server/src/learning/grade-eval-metrics.js';

const HELP = `用法：npm run eval -- <suite> [选项]

  suite   quiz                     （已实现）  出题结构化指标
          vision                   （已实现）  看图核验：误收率／泄露检出／单张时延（datasets/vision-v1.json）
          grade                    （已实现）  AI 阅卷准确率／误放率（数据集 datasets/grade-v1.json）
          search/collect/scenario/chat/review   （契约 §3.2~§3.7，批次 B 待建）

  选项    --dataset <file>         数据集路径（默认 tools/eval/datasets/terms-v1.json）
          --arms <base,img>        跑哪几个 arm（默认两个都跑）
          --limit <n>              只跑前 n 个词条（冒烟用；0＝全部）
          --throttle <ms>          两次真调的间隔（默认 1200）
          --retry <n>              传输失败补跑次数（默认 1）
          --out <dir>              落盘目录（默认 tools/eval/reports）
          --replay <file>          离线重算一份录制件（不调模型）
          --doc <file>             把指标写进这份 markdown（默认 docs/eval/quiz.md）
          --check                  只算不写文档，任一指标缺分母即退出码 1`;

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const suite = argv[0];
  if (!suite || suite === '--help' || argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  if (suite === 'vision') {
    await visionMain(argv);
    return;
  }
  if (suite === 'grade') {
    await gradeMain(argv);
    return;
  }
  if (suite !== 'quiz') {
    console.error(`✗ 套件「${suite}」还没建。已实现：quiz、grade、vision`);
    process.exitCode = 2;
    return;
  }
  const flags = parse(argv.slice(1));
  const root = path.resolve(import.meta.dirname, '..', '..');
  const reportsDir = path.resolve(root, flags['out'] ?? 'tools/eval/reports');
  const docFile = path.resolve(root, flags['doc'] ?? 'docs/eval/quiz.md');

  if (flags['replay']) {
    const file = path.isAbsolute(flags['replay']) ? flags['replay'] : path.resolve(root, flags['replay']);
    const result = replayScores(file);
    console.log(`离线重算 ${result.records.length} 组（数据集 ${result.dataset}／模型 ${result.model}）`);
    const doc = renderQuizDoc(result, { writeAt: new Date().toISOString().slice(0, 10), replay: true, datasetFile: '' });
    // `--check` ＝ 只打印不落盘（CI 口径回归闸要的是「能不能算出来」，不是「文档变了没」）
    if (flags['check'] !== 'true') writeDoc(docFile, doc, root);
    else console.log(doc);
    return;
  }

  const result = await runQuizSuite({
    dataset: path.resolve(root, flags['dataset'] ?? 'tools/eval/datasets/terms-v1.json'),
    arms: (flags['arms'] ?? 'base,img').split(',').map((s) => s.trim()).filter(Boolean),
    limit: Number(flags['limit'] ?? '0'),
    throttleMs: Number(flags['throttle'] ?? '1200'),
    retry: Number(flags['retry'] ?? '1'),
    reportsDir,
  });
  console.log(`\n录制件：${path.relative(root, result.file)}（${result.records.length} 组）`);
  const doc = renderQuizDoc(result, {
    writeAt: new Date().toISOString().slice(0, 10),
    replay: false,
    datasetFile: 'tools/eval/datasets/terms-v1.json',
  });
  if (flags['check'] === 'true') {
    console.log(doc);
    return;
  }
  writeDoc(docFile, doc, root);
}

/**
 * 指标块用成对标记圈起来覆写，**标记之外的手写内容原样保留**：
 * §3 的预言、§5 的结论、§6 的口径修正是人写的账，机器每跑一次就把它们覆盖掉的话，
 * 这份文档就只剩「今天的数」而没有「为什么是这个数」——那正是评测最容易烂掉的方式。
 */
function writeDoc(docFile: string, doc: string, root: string, tag = 'quiz'): void {
  const BEGIN = `<!-- eval:${tag}:begin -->`;
  const END = `<!-- eval:${tag}:end -->`;
  const block = `${BEGIN}\n${doc}\n${END}`;
  fs.mkdirSync(path.dirname(docFile), { recursive: true });
  const prev = fs.existsSync(docFile) ? fs.readFileSync(docFile, 'utf8') : '';
  const next =
    prev.includes(BEGIN) && prev.includes(END)
      ? // 替换体走函数返回：字符串形式的 `replace` 会把 `$&` / `$'` 当成引用解释，
        // 指标文案里一旦出现 `$`（LaTeX 题面就有这个可能）会静默拼错整篇文档
        prev.replace(new RegExp(`${BEGIN}[\\s\\S]*${END}`), () => block)
      : `${prev.trimEnd()}${prev ? '\n\n' : ''}${block}\n`;
  fs.writeFileSync(docFile, next, 'utf8');
  console.log(`指标已写入 ${path.relative(root, docFile)}`);
}

async function gradeMain(argv: string[]): Promise<void> {
  const flags = parse(argv.slice(1));
  const root = path.resolve(import.meta.dirname, '..', '..');
  const reportsDir = path.resolve(root, flags['out'] ?? 'tools/eval/reports');
  const docFile = path.resolve(root, flags['doc'] ?? 'docs/eval/grade.md');
  let run: GradeRun;
  if (flags['replay']) {
    run = replayGrade(path.isAbsolute(flags['replay']) ? flags['replay'] : path.resolve(root, flags['replay']));
  } else {
    run = await runGradeSuite({
      dataset: path.resolve(root, flags['dataset'] ?? 'tools/eval/datasets/grade-v1.json'),
      limit: Number(flags['limit'] ?? '0'),
      throttleMs: Number(flags['throttle'] ?? '800'),
      retry: Number(flags['retry'] ?? '1'),
      reportsDir,
    });
    console.log(`\n录制件：${path.relative(root, run.file)}（${run.records.length} 条）`);
  }
  const doc = renderGradeSummary(run.summary, {
    model: run.model,
    dataset: run.dataset,
    date: new Date().toISOString().slice(0, 10),
    replay: Boolean(flags['replay']),
  });
  if (flags['check'] === 'true') {
    console.log(doc);
    if (run.summary.accuracy === null) process.exitCode = 1;
    return;
  }
  writeDoc(docFile, doc, root, 'grade');
}

async function visionMain(argv: string[]): Promise<void> {
  const flags = parse(argv.slice(1));
  const root = path.resolve(import.meta.dirname, '..', '..');
  const reportsDir = path.resolve(root, flags['out'] ?? 'tools/eval/reports');
  const docFile = path.resolve(root, flags['doc'] ?? 'docs/eval/vision.md');
  let run: VisionRun;
  if (flags['replay']) {
    run = replayVision(path.isAbsolute(flags['replay']) ? flags['replay'] : path.resolve(root, flags['replay']));
  } else {
    run = await runVisionSuite({
      dataset: path.resolve(root, flags['dataset'] ?? 'tools/eval/datasets/vision-v1.json'),
      limit: Number(flags['limit'] ?? '0'),
      throttleMs: Number(flags['throttle'] ?? '2000'),
      retry: Number(flags['retry'] ?? '3'),
      reportsDir,
    });
    console.log(`\n录制件：${path.relative(root, run.file)}（${run.records.length} 条）`);
  }
  const doc = renderVisionSummary(run.summary, { model: run.model, dataset: run.dataset, date: new Date().toISOString().slice(0, 10), replay: Boolean(flags['replay']) });
  if (flags['check'] === 'true') {
    console.log(doc);
    if (run.summary.accuracy === null) process.exitCode = 1;
    return;
  }
  writeDoc(docFile, doc, root, 'vision');
}

await main();
