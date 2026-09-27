/**
 * evals/lib/graders — 规则评分器(确定性,零模型)。
 *
 * 每个 grader:(raw, quizCase) → { pass: boolean, note?: string } 或跳过时返回 null。
 * 硬检查(hard)计入得分;软检查(soft)只报告不扣同权重的分(权重减半)。
 * 检查依据全部来自生产契约:QUIZ_PROTOCOL 的规则段 + quiz.ts normalizeQuiz/applyQuizMix 的实际行为。
 */
import { QUIZ_TYPES } from './protocol.mjs';

// ── 提取与解析 ──────────────────────────────────────────────

/** [QUIZ]...[/QUIZ] 提取;返回 { body, outside, count } */
export function extractQuizBlock(raw) {
  const matches = [...raw.matchAll(/\[QUIZ\]([\s\S]*?)\[\/QUIZ\]/g)];
  const outside = raw.replace(/\[QUIZ\][\s\S]*?\[\/QUIZ\]/g, '').trim();
  return { body: matches[0]?.[1] ?? null, outside, count: matches.length };
}

function tryParse(raw) {
  const { body } = extractQuizBlock(raw);
  if (body == null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const normText = (s) => String(s).replace(/\s+/g, '').toLowerCase();

/** 字符 bigram 集(中文友好;英文退化为字符对,同样能测重叠) */
function bigrams(s) {
  const t = normText(s).replace(/[^\p{L}\p{N}]/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

// ── 硬检查 ──────────────────────────────────────────────────

export const HARD_CHECKS = {
  /** 恰好一对 [QUIZ] 标记,标记外不许有其他文字(协议末句) */
  wrap(raw) {
    const { body, outside, count } = extractQuizBlock(raw);
    if (count === 0) return { pass: false, note: '没有 [QUIZ]...[/QUIZ] 标记' };
    if (count > 1) return { pass: false, note: `出现 ${count} 对标记` };
    if (outside.length > 0) return { pass: false, note: `标记外有 ${outside.length} 字符多余文字` };
    return { pass: body != null ? true : false };
  },

  /** 标记内是合法 JSON */
  json(raw) {
    const { body } = extractQuizBlock(raw);
    if (body == null) return { pass: false, note: '无标记体可解析' };
    try {
      JSON.parse(body);
      return { pass: true };
    } catch (e) {
      return { pass: false, note: `JSON 解析失败: ${String(e.message).slice(0, 80)}` };
    }
  },

  /** 字段契约:title/questions;每题 type/question/answer/explanation/svg/refs 一个不许省 */
  schema(raw) {
    const q = tryParse(raw);
    if (!q) return { pass: false, note: '无合法 JSON' };
    if (typeof q.title !== 'string' || !Array.isArray(q.questions) || q.questions.length === 0)
      return { pass: false, note: 'title/questions 结构不对' };
    const REQUIRED = ['type', 'question', 'answer', 'explanation', 'svg', 'refs'];
    for (let i = 0; i < q.questions.length; i++) {
      const item = q.questions[i];
      for (const f of REQUIRED)
        if (!(f in item)) return { pass: false, note: `第 ${i + 1} 题缺字段 ${f}(协议:不要省略)` };
      if (['single', 'multiple', 'judge'].includes(item.type) && !Array.isArray(item.options))
        return { pass: false, note: `第 ${i + 1} 题(${item.type})缺 options` };
    }
    return { pass: true };
  },

  /** 配比精确契约:各题型数量与要求一致(applyQuizMix 的 matched 语义) */
  mix(raw, quizCase) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可数' };
    const actual = Object.fromEntries(QUIZ_TYPES.map((t) => [t, 0]));
    for (const item of q.questions) if (item.type in actual) actual[item.type] += 1;
    const diffs = QUIZ_TYPES.filter((t) => actual[t] !== (quizCase.mix[t] ?? 0)).map(
      (t) => `${t}: 要 ${quizCase.mix[t] ?? 0} 实 ${actual[t]}`,
    );
    const alien = q.questions.filter((item) => !QUIZ_TYPES.includes(item.type)).length;
    if (alien > 0) diffs.push(`自造题型 ${alien} 道`);
    return diffs.length === 0 ? { pass: true } : { pass: false, note: diffs.join('; ') };
  },

  /** 排列顺序契约:questions 按 QUIZ_TYPES 顺序(提示词明说) */
  order(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    const ranks = q.questions
      .map((item) => QUIZ_TYPES.indexOf(item.type))
      .filter((r) => r >= 0);
    for (let i = 1; i < ranks.length; i++)
      if (ranks[i] < ranks[i - 1]) return { pass: false, note: `第 ${i + 1} 题题型顺序倒置` };
    return { pass: true };
  },

  /** 各题型 answer 合法性(协议规则段逐条) */
  answers(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const item = q.questions[i];
      const at = `第 ${i + 1} 题(${item.type})`;
      if (item.type === 'single' || item.type === 'judge') {
        if (!Array.isArray(item.answer) || item.answer.length !== 1 || !Number.isInteger(item.answer[0]))
          return { pass: false, note: `${at} answer 应为单元素下标数组` };
      }
      if (item.type === 'judge') {
        if (!Array.isArray(item.options) || item.options.length !== 2 || item.options[0] !== '正确' || item.options[1] !== '错误')
          return { pass: false, note: `${at} options 应恒为 ["正确","错误"]` };
      }
      if (item.type === 'multiple') {
        if (!Array.isArray(item.answer) || item.answer.length < 1 || !item.answer.every(Number.isInteger))
          return { pass: false, note: `${at} answer 应为下标数组` };
      }
      if (item.type === 'single' || item.type === 'multiple' || item.type === 'judge') {
        const n = item.options?.length ?? 0;
        if (!item.answer.every((a) => a >= 0 && a < n)) return { pass: false, note: `${at} answer 下标越界` };
      }
      if (item.type === 'fill') {
        if (!Array.isArray(item.answer) || item.answer.length === 0 || !item.answer.every((a) => typeof a === 'string' && a.trim()))
          return { pass: false, note: `${at} answer 应为非空字符串数组` };
        const blanks = (String(item.question).match(/____/g) ?? []).length;
        if (blanks === 0) return { pass: false, note: `${at} 题干没有 ____ 空位` };
        if (blanks !== item.answer.length)
          return { pass: false, note: `${at} 空位 ${blanks} 个但答案 ${item.answer.length} 个` };
      }
      if (item.type === 'essay') {
        if (typeof item.answer !== 'string' || !item.answer.trim())
          return { pass: false, note: `${at} answer 应为参考要点字符串` };
      }
    }
    return { pass: true };
  },

  /** 选项质量:数量、非空、去重 */
  options(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const item = q.questions[i];
      if (item.type !== 'single' && item.type !== 'multiple') continue;
      const at = `第 ${i + 1} 题(${item.type})`;
      const opts = item.options ?? [];
      if (opts.length < 3) return { pass: false, note: `${at} 选项仅 ${opts.length} 个(<3)` };
      if (opts.some((o) => typeof o !== 'string' || !o.trim())) return { pass: false, note: `${at} 有空选项` };
      if (new Set(opts.map(normText)).size !== opts.length) return { pass: false, note: `${at} 选项重复` };
    }
    return { pass: true };
  },

  /** 答案泄漏:正确选项全文出现在题干里 = 送分题 */
  leakage(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const item = q.questions[i];
      if (item.type !== 'single' && item.type !== 'multiple') continue;
      const stem = normText(item.question);
      for (const a of item.answer ?? []) {
        const opt = normText(item.options?.[a] ?? '');
        if (opt.length >= 4 && stem.includes(opt))
          return { pass: false, note: `第 ${i + 1} 题正确选项原文出现在题干` };
      }
    }
    return { pass: true };
  },

  /** refs 契约:eval 不给检索资料 ⇒ refs 必须是 [](协议:没参考就填 []) */
  refs(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const r = q.questions[i].refs;
      if (!Array.isArray(r)) return { pass: false, note: `第 ${i + 1} 题 refs 不是数组` };
      if (r.length > 0) return { pass: false, note: `第 ${i + 1} 题在无资料场景下编造了 refs` };
    }
    return { pass: true };
  },

  /** svg:给了就得像 SVG;照抄示例方框 = 等于没配图(协议原话) */
  svg(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const s = q.questions[i].svg;
      if (typeof s !== 'string') return { pass: false, note: `第 ${i + 1} 题 svg 不是字符串` };
      if (!s.trim()) continue;
      if (!/^<svg[\s>]/.test(s.trim())) return { pass: false, note: `第 ${i + 1} 题 svg 不是 <svg> 开头` };
      if (s.includes("x='25' y='15' width='60' height='60'"))
        return { pass: false, note: `第 ${i + 1} 题照抄了协议示例方框` };
    }
    return { pass: true };
  },
};

// ── 软检查(报告但权重减半)──────────────────────────────────

export const SOFT_CHECKS = {
  /** 题干与材料的字符 bigram 重叠 ≥ 0.22 ——「题目必须源于给定材料」的粗启发 */
  grounding(raw, quizCase) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    const mat = bigrams(quizCase.material);
    let worst = 1;
    let worstAt = 0;
    for (let i = 0; i < q.questions.length; i++) {
      const bg = [...bigrams(q.questions[i].question)];
      if (bg.length === 0) continue;
      const hit = bg.filter((b) => mat.has(b)).length / bg.length;
      if (hit < worst) {
        worst = hit;
        worstAt = i + 1;
      }
    }
    return worst >= 0.22
      ? { pass: true, note: `最低重叠 ${worst.toFixed(2)}` }
      : { pass: false, note: `第 ${worstAt} 题与材料重叠仅 ${worst.toFixed(2)}(疑似编造)` };
  },

  /** 非 essay 题应有非空 explanation(产品体验:逐题解析) */
  explanation(raw) {
    const q = tryParse(raw);
    if (!q?.questions) return { pass: false, note: '无题可查' };
    for (let i = 0; i < q.questions.length; i++) {
      const item = q.questions[i];
      if (item.type === 'essay') continue;
      if (typeof item.explanation !== 'string' || item.explanation.trim().length < 2)
        return { pass: false, note: `第 ${i + 1} 题解析为空` };
    }
    return { pass: true };
  },
};

/** 跑全部检查 → { checks: {name:{pass,note,tier}}, score: 0..1 } */
export function gradeCase(raw, quizCase) {
  const checks = {};
  let got = 0;
  let max = 0;
  for (const [name, fn] of Object.entries(HARD_CHECKS)) {
    const r = fn(raw, quizCase);
    checks[name] = { ...r, tier: 'hard' };
    max += 1;
    if (r.pass) got += 1;
  }
  for (const [name, fn] of Object.entries(SOFT_CHECKS)) {
    const r = fn(raw, quizCase);
    checks[name] = { ...r, tier: 'soft' };
    max += 0.5;
    if (r.pass) got += 0.5;
  }
  return { checks, score: max > 0 ? got / max : 0 };
}
