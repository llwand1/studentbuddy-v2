/**
 * evals/lib/protocol — 出题提示词装配。
 *
 * ★ 纪律:QUIZ_PROTOCOL **不许手抄**——运行时直接从
 *   `packages/server/src/learning/quiz.ts` 源码提取,生产协议改了,eval 自动跟着改,
 *   永不漂移(同 `tools/metrics.mjs` 的对账哲学)。
 * ★ 配比指令镜像 `quiz.ts` 的 `buildMixInstruction`(join('') 无分隔符,措辞一字不差);
 *   若生产侧改措辞,本文件需同步——selftest 里有一条护栏检查关键短语。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const QUIZ_TS = join(ROOT, 'packages', 'server', 'src', 'learning', 'quiz.ts');

/** 与 @sb/shared 的 QUIZ_TYPES 同序(顺序即出题排列序) */
export const QUIZ_TYPES = ['single', 'multiple', 'fill', 'essay', 'judge'];
export const QUIZ_TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  fill: '填空题',
  essay: '解答题',
  judge: '判断题',
};

/** 从生产源码提取出题协议;提不到就抛错(宁停不错,协议是 eval 的地基) */
export function loadQuizProtocol() {
  const src = readFileSync(QUIZ_TS, 'utf8');
  const m = src.match(/export const QUIZ_PROTOCOL = `([\s\S]*?)`;/);
  if (!m) throw new Error(`无法从 ${QUIZ_TS} 提取 QUIZ_PROTOCOL——生产源码结构变了,请更新 evals/lib/protocol.mjs`);
  return m[1];
}

/** 镜像 quiz.ts 的 buildMixInstruction(措辞一字不差,lines.join('')) */
export function buildMixInstruction(mix) {
  const total = QUIZ_TYPES.reduce((s, t) => s + (mix[t] ?? 0), 0);
  const wanted = QUIZ_TYPES.filter((t) => (mix[t] ?? 0) > 0).map((t) => `${QUIZ_TYPE_LABELS[t]} ${mix[t]} 道`);
  const zero = QUIZ_TYPES.filter((t) => (mix[t] ?? 0) === 0).map((t) => QUIZ_TYPE_LABELS[t]);
  const lines = [`本次出题数量要求：总共恰好 ${total} 道题，其中 ${wanted.join('、')}。`];
  if (zero.length > 0) lines.push(`不要出${zero.join('、')}（该题型数量为 0）。`);
  lines.push('questions 数组按上述题型顺序排列，不多不少。');
  return lines.join('');
}

/** 单条 eval 用例 → 完整提示词(无检索资料、无配图要求 ⇒ refs 应为 []、svg 不强求) */
export function buildPrompt(quizCase) {
  return [
    loadQuizProtocol(),
    buildMixInstruction(quizCase.mix),
    `给定材料：\n${quizCase.material}`,
  ].join('\n\n');
}
