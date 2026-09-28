/**
 * shared/spell-chant — 「魔法吟唱」的**唯一事实源**：把一段历史对话切成可吟唱的「节」、
 * 复述提问的相似度与阈值、遮罩提示、共鸣判定、威力与伤害（契约 `docs/SPELL-CHANT-SPEC.md`）。
 *
 * 为什么放 shared：与 `continent.ts` 同一个理由——「伤害怎么算」「哪句算共鸣」必须只有一份口径，
 * 前端算出来的威力与文档/测试里写的数必须是同一个函数的结果。
 *
 * ── 三条硬口径（改码前必读）────────────────────────────────────────────────────
 * 1. **纯函数、零随机、零时钟**：遮罩露哪几个字由 `continentHash` 决定（同一句每次遮得一样，
 *    不然用户刷新一下就能凑出整句）；本文件**不许出现 `Math.random` / `Date.now`**。
 * 2. **数值由学习行为解释**：威力 = 命中的节数（复述一次提问 / 重做一题各算一节），
 *    共鸣 ×2 = 咒语正文提到了这块地的词条。跳过 / 答错 = 0，没有空转的数值。
 * 3. **只切、不判**：本文件不判分题目——题卡判分复用对话页那一份（`features/quiz/quiz-attempt.ts`），
 *    这里只负责「哪些题能进吟唱」（可客观判分的四型）。
 */
import { continentHash, normText } from './continent.js';
import type { QuizQuestion } from './content-blocks.js';

/** 一次吟唱最多几节（超出只取前 N 节，UI 如实提示）。8 = 一段典型对话的轮数上限，再长就是拉练不是回忆 */
export const SPELL_MAX_VERSES = 8;
/** 一张题卡最多取几题进吟唱（题卡动辄 8 题，全进就把复述提问淹了） */
export const SPELL_MAX_QUIZ_PER_CARD = 3;
/** 「回响」（AI 回答摘录）字数上限 */
export const SPELL_ECHO_CHARS = 160;
/** 共鸣倍率：咒语正文提到这块地的词条 ⇒ 这次回顾对该词条是直接复习 */
export const SPELL_RESONANCE_MULTIPLIER = 2;
/** 复述阈值：≤ SHORT 字用 MAX，≥ LONG 字用 MIN，中间线性（长句不可能逐字复述，阈值不降就是把人卡死） */
export const SPELL_THRESHOLD_MAX = 0.6;
export const SPELL_THRESHOLD_MIN = 0.4;
export const SPELL_THRESHOLD_SHORT = 20;
export const SPELL_THRESHOLD_LONG = 60;
/** 遮罩：每 3 个字按哈希露出约 1 个 */
export const SPELL_MASK_EVERY = 3;
/** 遮罩用的字符（全角下划线，等宽、与中文同高） */
export const SPELL_MASK_CHAR = '＿';

/** 吟唱的输入：对话核折好的消息流里，本文件只关心这三样 */
export interface ChantTurn {
  role: 'user' | 'assistant';
  content: string;
  /** 这条是题卡时：卡上的题（对话页 `quizBlock.quiz.questions`） */
  quiz?: readonly QuizQuestion[];
  /** 题卡标题（有则进「回响」） */
  quizTitle?: string;
}

/** 咒语的一节 */
export type ChantVerse =
  /** 复述提问：`prompt` 是当初的原话，`echo` 是那一轮 AI 回答的摘录（可能为空——那轮没有文字回答） */
  | { kind: 'recall'; prompt: string; echo: string }
  /** 重做题目：只会是可客观判分的四型（`chantable`） */
  | { kind: 'quiz'; question: QuizQuestion; title: string };

/** 一节的结果：命中 / 失谐（跳过、答错都是失谐） */
export type ChantVerseResult = 'hit' | 'miss';

export interface ChantPlan {
  verses: ChantVerse[];
  /** 被截掉的节数（0 = 没截）；UI 据此说「咒语太长，只吟唱前 N 节」 */
  truncated: number;
}

/**
 * 这道题能不能进吟唱：只收**机器可判对错**的四型且答案形状完整。
 * `essay` 没有可判的对错；`fill` 没答案就没法判；选择题答案下标必须落在选项内。
 */
export function chantable(q: QuizQuestion): boolean {
  if (!q || typeof q.question !== 'string' || !q.question.trim()) return false;
  if (q.type === 'fill') {
    return Array.isArray(q.answer) ? q.answer.length > 0 && q.answer.every((a) => String(a).trim() !== '') : typeof q.answer === 'string' && q.answer.trim() !== '';
  }
  if (q.type === 'single' || q.type === 'multiple' || q.type === 'judge') {
    const options = q.type === 'judge' ? ['正确', '错误'] : q.options ?? [];
    if (options.length < 2 || !Array.isArray(q.answer) || q.answer.length === 0) return false;
    return q.answer.every((a) => Number.isInteger(Number(a)) && Number(a) >= 0 && Number(a) < options.length);
  }
  return false;
}

/**
 * 「回响」：AI 回答的摘录——去掉 `[QUIZ]…[/QUIZ]` / `[SCENARIO]…` 登记块、代码围栏、Markdown 记号，
 * 折叠空白，截到 `SPELL_ECHO_CHARS`。★ 只是提示，不是判分依据，故宁可粗一点也不引 Markdown 解析器。
 */
export function echoOf(content: string, max: number = SPELL_ECHO_CHARS): string {
  const s = (content ?? '')
    .replace(/\[QUIZ\][\s\S]*?\[\/QUIZ\]/g, ' ')
    .replace(/\[SCENARIO\][\s\S]*?\[\/SCENARIO\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/**
 * 把折好的消息流切成节：**用户提问（非空文字）→ 下一条 AI 回答 = 一节复述**；**题卡上的题 = 各一节重做**。
 * ★ 次序与对话一致（先问的先吟）；一条提问只配它之后的**第一条** AI 消息（文字或题卡）。
 * ★ 提问后面没有任何 AI 消息（被中止 / 正在生成）⇒ 仍成一节，`echo` 为空——UI 说「这一轮没有留下回响」。
 * ★ 只有图片没有文字的提问不成节（没有可复述的话）。
 */
export function buildChantVerses(turns: readonly ChantTurn[], maxVerses: number = SPELL_MAX_VERSES): ChantPlan {
  const all: ChantVerse[] = [];
  let pending: string | null = null;
  const flush = (echo: string): void => {
    if (pending === null) return;
    all.push({ kind: 'recall', prompt: pending, echo });
    pending = null;
  };
  for (const t of turns) {
    if (t.role === 'user') {
      flush('');
      const text = (t.content ?? '').trim();
      if (text) pending = text;
      continue;
    }
    const quiz = (t.quiz ?? []).filter(chantable).slice(0, SPELL_MAX_QUIZ_PER_CARD);
    const title = (t.quizTitle ?? '').trim() || '对话里出过的题';
    if (quiz.length > 0) {
      flush(echoOf(t.content) || `出了一组题：${title}`);
      for (const question of quiz) all.push({ kind: 'quiz', question, title });
      continue;
    }
    const echo = echoOf(t.content);
    if (echo) flush(echo);
  }
  flush('');
  const cap = Math.max(1, Math.trunc(maxVerses) || SPELL_MAX_VERSES);
  return { verses: all.slice(0, cap), truncated: Math.max(0, all.length - cap) };
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = [...s];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const g = `${chars[i]}${chars[i + 1]}`;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * 复述相似度 `[0, 1]`：归一化（`normText`：NFKC / 小写 / 去空白与中英标点）后的
 * **字符二元组多重集 Dice 系数**。不分词（中英混排下分词器本身就是一份口径），只看相邻字对。
 * - 完全相同 ⇒ 1；任一为空 ⇒ 0；
 * - 只有单字（凑不出二元组）时退化为「归一后相等」。
 */
export function promptSimilarity(a: string, b: string): number {
  const x = normText(a ?? '');
  const y = normText(b ?? '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xs = [...x];
  const ys = [...y];
  if (xs.length < 2 || ys.length < 2) return 0;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (xs.length - 1 + (ys.length - 1));
}

/** 共鸣阈值：按**原提问归一后的长度**线性递减（见常量注释） */
export function resonanceThreshold(promptLength: number): number {
  const n = Math.max(0, Math.trunc(promptLength) || 0);
  if (n <= SPELL_THRESHOLD_SHORT) return SPELL_THRESHOLD_MAX;
  if (n >= SPELL_THRESHOLD_LONG) return SPELL_THRESHOLD_MIN;
  const k = (n - SPELL_THRESHOLD_SHORT) / (SPELL_THRESHOLD_LONG - SPELL_THRESHOLD_SHORT);
  return SPELL_THRESHOLD_MAX - k * (SPELL_THRESHOLD_MAX - SPELL_THRESHOLD_MIN);
}

/** 这一句复述过关了吗（唯一入口；UI 不自己比数） */
export function resonates(prompt: string, attempt: string): boolean {
  return promptSimilarity(prompt, attempt) >= resonanceThreshold([...normText(prompt)].length);
}

const MASK_KEEP = /[\s\p{P}\p{S}]/u;

/**
 * 遮罩原提问：首字必露，其余每个字按 `continentHash(seed|i) % SPELL_MASK_EVERY === 0` 露出（约三分之一），
 * 空白与标点原样保留（句子的形状留着，人才想得起来）。
 * ★ 至少遮住一个字：全露就不是遮罩（两字以内的句子首字露、末字遮）。
 */
export function maskPrompt(prompt: string, seed: string): string {
  const chars = [...(prompt ?? '')];
  let hidden = 0;
  let lastLetter = -1;
  const out = chars.map((ch, i) => {
    if (MASK_KEEP.test(ch)) return ch;
    lastLetter = i;
    if (i === 0 || continentHash(`${seed}|${i}`) % SPELL_MASK_EVERY === 0) return ch;
    hidden += 1;
    return SPELL_MASK_CHAR;
  });
  if (hidden === 0 && lastLetter > 0) out[lastLetter] = SPELL_MASK_CHAR;
  return out.join('');
}

/** 共鸣：会话任一消息正文（归一后）包含这块地的词条名（归一后）。空词条名恒 false */
export function spellResonates(texts: readonly string[], term: string): boolean {
  const t = normText(term ?? '');
  if (!t) return false;
  return texts.some((x) => normText(x ?? '').includes(t));
}

/** 威力 = 命中的节数 */
export function chantPower(results: readonly ChantVerseResult[]): number {
  return results.filter((r) => r === 'hit').length;
}

/** 伤害 = 威力 ×（共鸣 ? 倍率 : 1）；威力非法 ⇒ 0（不会因为脏值打出负伤害或 NaN） */
export function spellDamage(power: number, resonant: boolean): number {
  const p = Math.max(0, Math.trunc(power) || 0);
  return p * (resonant ? SPELL_RESONANCE_MULTIPLIER : 1);
}
