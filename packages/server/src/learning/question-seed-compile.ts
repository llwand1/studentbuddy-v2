/** 只执行程序内置的数学规则；外部只提供整数参数空间。每次现场组题并验算。 */
import { randomInt } from 'node:crypto';
import type { QuizMix, QuizPayload, QuizQuestion, SeedType } from '@sb/shared';
import { SEED_TYPES, mixTotal } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { getSeed, seedEligibility, writeSeed, type StoredSeed } from './question-seeds.js';

export function equationQuestion(a: number, b: number, x: number, type: SeedType, position: number): QuizQuestion {
  const c = a * x + b;
  const left = `${a === 1 ? '' : a === -1 ? '−' : a}x${b === 0 ? '' : b < 0 ? '−' + Math.abs(b) : '+' + b}`;
  const equation = `${left}=${c}`;
  const step = `两边${b >= 0 ? '减去' : '加上'} ${Math.abs(b)}，得 ${a}x=${c - b}；再同除以 ${a}，得 x=${x}。代入：${a}×(${x})${b < 0 ? '−' + Math.abs(b) : '+' + b}=${c}，等式成立。`;
  if (type === 'judge') {
    const correct = position % 2 === 0;
    return { type, question: `方程 ${equation} 的解是 x=${correct ? x : x + 1}。这个判断正确吗？`, options: ['正确', '错误'], answer: [correct ? 0 : 1], explanation: step, tier: 'basic' };
  }
  if (type === 'fill') return { type, question: `解方程 ${equation}，x=____。`, answer: [String(x)], explanation: step, tier: 'basic' };
  if (type === 'essay') return { type, question: `解方程 ${equation}，写出等式两边的变换步骤并代入检验。`, answer: `x=${x}`, explanation: step,
    solution: `$$\\begin{aligned}${a}x${b < 0 ? '-' + Math.abs(b) : '+' + b}&=${c}\\\\${a}x&=${c - b}\\\\x&=${x}\\end{aligned}$$\n代入检验：${step}`, tier: 'basic' };
  const values = [x - 2, x - 1, x + 1]; values.splice(position % 4, 0, x);
  return { type: 'single', question: `解方程 ${equation}，x 等于多少？`, options: values.map(String), answer: [position % 4], explanation: step, tier: 'basic' };
}

export function compileSeed(ownerId: string | null, selected: StoredSeed, mix: QuizMix, opts: {
  signal?: AbortSignal; accept?: (quiz: QuizPayload) => boolean; commit?: (quiz: QuizPayload) => boolean;
} = {}): QuizPayload | null {
  if (!selected.seed.recipe || mix.multiple > 0 || mix.scenario > 0 || mixTotal(mix) === 0 || opts.signal?.aborted) return null;
  return getDb().transaction(() => {
    const current = getSeed(ownerId, selected.id);
    const p = current?.seed.recipe;
    if (!current || !p || !seedEligibility(current.seed, ownerId).eligible) return null;
    const used = new Set(current.used), fresh: string[] = [], questions: QuizQuestion[] = [];
    const total = p.coefficients.length * p.constants.length * p.solutions.length;
    const start = randomInt(total);
    for (const type of SEED_TYPES) {
      if (!current.seed.types.includes(type) && mix[type] > 0) return null;
      let got = 0;
      for (let offset = 0; got < mix[type] && offset < total; offset++) {
        const i = (start + offset) % total, key = String(i);
        if (used.has(key)) continue;
        const x = p.solutions[i % p.solutions.length]!;
        const b = p.constants[Math.floor(i / p.solutions.length) % p.constants.length]!;
        const a = p.coefficients[Math.floor(i / (p.solutions.length * p.constants.length))]!;
        // 双向验算确保答案来自同一组参数；不是导入者提供的答案。
        if ((a * x + b - b) / a !== x) continue;
        const q = equationQuestion(a, b, x, type, i);
        const one = { title: current.seed.topic, questions: [q] };
        if (opts.accept && !opts.accept(one)) continue;
        questions.push(q); used.add(key); fresh.push(key); got++;
      }
      if (got !== mix[type]) return null;
    }
    const quiz = { title: current.seed.topic, questions };
    if (opts.signal?.aborted || (opts.commit && !opts.commit(quiz))) return null;
    writeSeed(ownerId, { ...current, used: [...current.used, ...fresh], uses: current.uses + 1, lastUsedAt: Date.now() });
    return quiz;
  })();
}
