/**
 * model-bench/lib/public-suites —— 建立在公开学术评测集上的两个套件。
 *
 *   `public-solve`     模型自己答 MMLU/C-Eval 的题,对**金标**算正确率。零裁判、零人工标注。
 *   `public-replicate` 拿公开集真题当 ref,走**既有**复刻评分器量协议保真度(评分口径一行不改)。
 *
 * 为什么这两个套件放一起:它们共用同一批条目,一次拉取两处用 —— 也因此可以并排读出一件事,
 * 「模型答得对」和「模型能把题忠实搬进产品协议」是**两种能力**。实测里最常见的组合是
 * 正确率高、复刻却掉分(模型忍不住改写题干、给选项加字母前缀、顺手"纠正"原题),
 * 而产品坏在后者 —— 用户看到的是一道跟原题对不上的题。
 */
import { buildSolvePrompt, parseAnswerSet, sameAnswerSet } from './solver.mjs';
import { replicateSuite } from './suites.mjs';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const frac = (n, d) => (d === 0 ? `${n}/0 —(无分母)` : `${n}/${d}(${((n / d) * 100).toFixed(1)}%)`);

/** 按某个键分组统计正确率,进报告的细分表 */
function breakdown(results, keyOf) {
  const m = new Map();
  for (const r of results) {
    const k = keyOf(r) ?? '(未知)';
    const cur = m.get(k) ?? { n: 0, ok: 0 };
    cur.n += 1;
    if (r.success) cur.ok += 1;
    m.set(k, cur);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ════════════════════════ public-solve ════════════════════════

export const publicSolveSuite = {
  prompt: (kase) => buildSolvePrompt({ question: kase.question, options: kase.options, multiple: kase.multiple }),

  /**
   * 三种结局,互斥且穷尽 —— 与生产 `quiz-verify.ts` 的保守纪律同源:
   *   correct    解出来且与金标一致
   *   wrong      解出来但不一致            ← 这才是「学科上答错了」
   *   unresolved 解不出(空答/单选给多字母/答非所问) ← 生产此时**放行不拦**,这里也不算答错
   *
   * ★ 为什么 unresolved 不算答错:它与「答错」的行动指引不同。答错 ⇒ 这模型学科不行,别拿它当
   *   验算保险丝;解不出 ⇒ 多半是**指令服从**问题(它非要写解释),换个提示词或换个模型形态就好。
   *   混成一个「错误率」之后,这两条路就再也分不开了。
   *   但正确率的**主分母仍是全部样本**(见 aggregate):对产品来说,解不出的那次保险丝照样没起作用。
   */
  grade(raw, kase) {
    const got = parseAnswerSet(raw, kase.options.length, kase.multiple);
    const resolved = got != null;
    const correct = resolved && sameAnswerSet(got, kase.answer);
    const letters = (idx) => (idx ?? []).map((i) => 'ABCDEF'[i]).join('') || '—';
    const checks = {
      resolved: { pass: resolved, note: resolved ? '' : '解不出字母(空答/单选多字母/答非所问)' },
      correct: { pass: correct, note: correct ? '' : `答 ${letters(got)}，金标 ${letters(kase.answer)}` },
    };
    return { checks, resolved, correct, got, success: correct, score: correct ? 1 : 0 };
  },

  aggregate(results) {
    const n = results.length;
    const ok = results.filter((r) => r.correct).length;
    const resolved = results.filter((r) => r.resolved).length;
    const metrics = {
      // 主指标:严格口径,分母 = 全部样本(解不出也算没答对)
      正确率: frac(ok, n),
      // 参照口径:只在解出来的里面算 —— 两个数差得多 ⇒ 问题在指令服从而不在学科水平
      '正确率|仅解出的': frac(ok, resolved),
      可解率: frac(resolved, n),
    };
    for (const [k, v] of breakdown(results, (r) => r.id?.split('/')[0])) metrics[`└ ${k}`] = frac(v.ok, v.n);
    return {
      primary: n ? ok / n : 0,
      headline: `正确率 ${frac(ok, n)} · 可解率 ${frac(resolved, n)}`,
      metrics,
    };
  },

  /** 假模型 = 理想答题者(验通路用,应当 100% —— 全绿只证明管子通了,不证明模型好) */
  fake(kase) {
    return kase.answer.map((i) => 'ABCDEF'[i]).join('');
  },
};

// ════════════════════════ public-replicate ════════════════════════

export const publicReplicateSuite = {
  ...replicateSuite,
  /** 评分完全复用 replicateSuite.grade;只在聚合时多切一刀按源/语种看 */
  aggregate(results) {
    const base = replicateSuite.aggregate(results);
    const metrics = { ...base.metrics };
    for (const [k, v] of breakdown(results, (r) => r.id?.split('/')[0])) metrics[`└ ${k}`] = frac(v.ok, v.n);
    return { ...base, metrics };
  },
};

// ════════════════════════ 自检 ════════════════════════

/** 返回失败条数 */
export function selftestPublicSuites() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };

  const kase = { id: 'mmlu/x/test/0', domain: 'x', options: ['甲', '乙', '丙', '丁'], answer: [2], multiple: false };

  check('盲解:答对 → correct', publicSolveSuite.grade('C', kase).correct);
  check('盲解:答错 → correct 红且 resolved 绿', (() => {
    const g = publicSolveSuite.grade('A', kase);
    return !g.correct && g.resolved;
  })());
  check('盲解:空答 → unresolved(不算答错)', (() => {
    const g = publicSolveSuite.grade('我需要更多信息', kase);
    return !g.resolved && !g.correct;
  })());
  check('盲解:单选答出多字母 → 矛盾不猜(生产同款)', !publicSolveSuite.grade('可能是 A 也可能是 C', kase).resolved);
  check('盲解:带解释但字母唯一 → 照样解得出', publicSolveSuite.grade('答案是 C，因为……', kase).resolved);
  check('盲解:越界字母被忽略(只有 4 个选项时 E 不算)', !publicSolveSuite.grade('E', kase).resolved);
  check('盲解:假模型 = 理想答题者', publicSolveSuite.grade(publicSolveSuite.fake(kase), kase).correct);

  // 分母纪律:全错时正确率 0/1,但**不能**因为没解出就把分母缩掉
  const agg = publicSolveSuite.aggregate([
    { id: 'mmlu/a/test/0', correct: true, resolved: true, success: true },
    { id: 'mmlu/a/test/1', correct: false, resolved: false, success: false },
  ]);
  check('盲解:解不出的样本仍进主分母(1/2 而非 1/1)', agg.metrics['正确率'].startsWith('1/2'));
  check('盲解:参照口径按解出的算(1/1)', agg.metrics['正确率|仅解出的'].startsWith('1/1'));

  // 复刻套件复用既有评分器 —— 这里只钉「公开条目转过来的 case 能被它吃下」
  const item = {
    id: 'ceval/high_school_physics/val/0',
    domain: 'high_school_physics',
    type: 'single',
    ref: { question: '一个物体做匀速直线运动，下列说法正确的是？', options: ['加速度为零', '速度为零', '合力不为零', '位移为零'], answer: [0] },
  };
  const good = publicReplicateSuite.fake(item);
  check('公开复刻:忠实复刻 → success', publicReplicateSuite.grade(good, item).success);
  check('公开复刻:答案被改 → 抓到', !publicReplicateSuite.grade(good.replace('"answer":[0]', '"answer":[2]'), item).success);

  return failed;
}
