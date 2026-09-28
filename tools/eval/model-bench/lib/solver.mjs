/**
 * model-bench/lib/solver —— 盲解口径的**唯一镜像**(对准生产 `learning/quiz-verify.ts`)。
 *
 * 为什么新开这个文件:本目录此前有**两处**手抄生产盲解逻辑 —— run.mjs 的 `verifyParse` 与
 * `verifySolve` 各抄了一份字母表、一份提示词、一份「单选答出多个字母=矛盾」的规则。
 * 现在公开评测集套件(`public-solve`)要第三次用到同一套东西。三处手抄 = 生产改一个字、
 * 三处静默落后(本仓对双写的判决见 `learning/term-usage.ts` 头注:「doc-rag.ts 常量双写、
 * ebbinghaus.ts 判定双写同款病」)。⇒ 收成一份,并配一条**漂移护栏**。
 *
 * ★ 护栏怎么工作:`assertMirrorsProduction()` 去 `quiz-verify.ts` 里 grep 本文件复刻的那几段
 *   特征串。生产改了措辞而这里没跟上 ⇒ `--selftest` 直接变红。
 *   这与 `protocol.mjs` 从生产源码正则提取 QUIZ_PROTOCOL 是同一条纪律的两种形态:
 *   常量能提取就提取,函数体提取不了就**钉住特征串**。宁可红一次,不要悄悄漂移。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const VERIFY_TS = join(ROOT, 'packages', 'server', 'src', 'learning', 'quiz-verify.ts');

/** 与 UI 选项字母同序;生产注释:「题目选项实际 ≤6 个,留到 F 兜边界」 */
export const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 生产 `buildSolvePrompt` 里那两句问法,一字不差 */
const ASK_MULTIPLE = '这是多选题,只输出全部正确选项的字母(如 AC),不要任何解释。';
const ASK_SINGLE = '只输出正确选项的字母,不要任何解释。';

/**
 * 盲解提示词:**只有题干+选项**,答案与解析绝不入内(信息面与人类答题者一致)。
 * 逐字镜像 `quiz-verify.ts` 的 `buildSolvePrompt`。
 */
export function buildSolvePrompt({ question, options = [], multiple = false }) {
  const opts = options.map((o, i) => `${CHOICE_LETTERS[i]}. ${o}`);
  return [multiple ? ASK_MULTIPLE : ASK_SINGLE, '', `题干：${question}`, ...opts].join('\n');
}

/**
 * 从 solver 回复解析答案下标集合。逐字镜像 `quiz-verify.ts` 的 `parseAnswerSet`:
 * 只认字母(数字歧义大 —— 生产注释:「ai-bot 收 0 基数字,人写 1 基,谁对赌不起」);
 * 扫全文去重;单选/判断答出多个不同字母 = 矛盾 → null(记 unresolved,**不猜**)。
 */
export function parseAnswerSet(raw, optionCount, multiple) {
  const seen = new Set();
  for (const ch of String(raw ?? '').toUpperCase()) {
    const idx = CHOICE_LETTERS.indexOf(ch);
    if (idx >= 0 && idx < optionCount) seen.add(idx);
  }
  if (seen.size === 0) return null;
  if (!multiple && seen.size > 1) return null;
  return [...seen].sort((a, b) => a - b);
}

/** 下标集合相等(与顺序无关) */
export function sameAnswerSet(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v) => y.includes(v));
}

/**
 * 漂移护栏:生产源码里必须还找得到本文件复刻的那几段。
 * @returns {string[]} 失败说明(空数组 = 没漂移)
 */
export function assertMirrorsProduction() {
  const bad = [];
  let src = '';
  try {
    src = readFileSync(VERIFY_TS, 'utf8');
  } catch (e) {
    return [`读不到生产源码 ${VERIFY_TS}(${String(e.message ?? e)})`];
  }
  if (!src.includes(ASK_MULTIPLE)) bad.push('quiz-verify.ts 里找不到多选问法原句 —— 生产改了措辞,solver.mjs 要跟上');
  if (!src.includes(ASK_SINGLE)) bad.push('quiz-verify.ts 里找不到单选问法原句 —— 生产改了措辞,solver.mjs 要跟上');
  if (!/CHOICE_LETTERS\s*=\s*\[\s*'A',\s*'B',\s*'C',\s*'D',\s*'E',\s*'F'/.test(src))
    bad.push('quiz-verify.ts 的 CHOICE_LETTERS 变了 —— solver.mjs 的字母表要跟上');
  if (!src.includes('if (!multiple && seen.size > 1) return null'))
    bad.push('quiz-verify.ts 的「单选多字母=矛盾」规则变了 —— parseAnswerSet 要跟上');
  return bad;
}
