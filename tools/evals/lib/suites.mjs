/**
 * evals/lib/suites — 复刻 / 联网引用 / 词条抽取 三个套件的评分与聚合。
 *
 * 每个套件导出 { grade(raw, kase), aggregate(results), fake(kase) }:
 * - replicate:结构合格 + 与原题相似度(textSim/setSim)+ 答案一致 ⇒ 成功;
 *   聚合出【成功率】与【总体相似度】——这正是"复刻网络题目"链路的两条硬指标。
 * - search:refs 编号合法 + 引用覆盖 + 引用命中(只许引真正相关的资料)⇒ 成功;
 *   聚合出【引用命中率】——refs 溯源是产品可信度的地基,引错比不引更糟。
 * - terms:协议合格 + 抽取的词条对上金标(模糊匹配 P/R/F1)⇒ 成功;
 *   聚合出【平均 F1】——词条是产品主体,抽错词条 = 后续学练忆全歪。
 */
import { HARD_CHECKS, tryParse, extractQuizBlock } from './graders.mjs';
import { textSim, setSim } from './similarity.mjs';
import { QUIZ_TYPES } from './protocol.mjs';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 跑一组结构检查,返回 { checks, ok } */
function runChecks(names, raw, kase) {
  const checks = {};
  let ok = true;
  for (const n of names) {
    const r = HARD_CHECKS[n](raw, kase);
    checks[n] = r;
    if (!r.pass) ok = false;
  }
  return { checks, ok };
}

// ════════════════════════ 复刻套件 ════════════════════════

/** 答案一致性:按题型把"正确答案的文本"对上原题 */
function answerMatches(q, ref, type) {
  if (type === 'single' || type === 'judge') {
    const got = q.options?.[q.answer?.[0]];
    const want = ref.options?.[ref.answer?.[0]];
    return got != null && want != null && textSim(got, want) >= 0.6;
  }
  if (type === 'multiple') {
    const got = (q.answer ?? []).map((i) => q.options?.[i] ?? '');
    const want = (ref.answer ?? []).map((i) => ref.options?.[i] ?? '');
    return got.length === want.length && setSim(got, want) >= 0.6;
  }
  if (type === 'fill') return setSim(q.answer, ref.answer) >= 0.6;
  return false;
}

export const replicateSuite = {
  /** 结构:标记/JSON/字段 + 答案与选项合法(mix/order/refs 等对单题复刻无意义) */
  grade(raw, kase) {
    const { checks, ok: structOk } = runChecks(['wrap', 'json', 'schema', 'answers', 'options'], raw, kase);
    const parsed = tryParse(raw);
    const q = parsed?.questions?.[0];
    let typeOk = false;
    let stemSim = 0;
    let optSim = null;
    let similarity = 0;
    let ansMatch = false;
    if (q) {
      typeOk = parsed.questions.length === 1 && q.type === kase.type;
      stemSim = textSim(q.question, kase.ref.question);
      optSim = kase.ref.options ? setSim(q.options ?? [], kase.ref.options) : null;
      similarity = optSim == null ? stemSim : 0.6 * stemSim + 0.4 * optSim;
      ansMatch = answerMatches(q, kase.ref, kase.type);
    }
    checks.oneOfType = { pass: typeOk, note: typeOk ? '' : '不是恰好 1 道指定题型' };
    const success = structOk && typeOk && similarity >= 0.55 && ansMatch;
    return { checks, structOk: structOk && typeOk, stemSim, optSim, similarity, ansMatch, success, score: similarity };
  },
  aggregate(results) {
    const okStruct = results.filter((r) => r.structOk).length;
    const okAns = results.filter((r) => r.ansMatch).length;
    const success = results.filter((r) => r.success).length;
    const sim = mean(results.map((r) => r.similarity));
    return {
      primary: success / results.length,
      headline: `成功率 ${pct(success / results.length)} · 总体相似度 ${sim.toFixed(3)}`,
      metrics: {
        成功率: pct(success / results.length),
        总体相似度: sim.toFixed(3),
        答案一致率: pct(okAns / results.length),
        结构合格率: pct(okStruct / results.length),
      },
    };
  },
  fake(kase) {
    const { ref, type } = kase;
    const q = {
      type,
      question: ref.question,
      answer: type === 'fill' ? [...ref.answer] : [...ref.answer],
      explanation: `解析：见原题考点。`,
      svg: '',
      refs: [],
    };
    if (ref.options) q.options = [...ref.options];
    return `[QUIZ]${JSON.stringify({ title: '复刻题', questions: [q] })}[/QUIZ]`;
  },
};

// ════════════════════════ 联网引用套件 ════════════════════════

export const searchSuite = {
  grade(raw, kase) {
    const names = ['wrap', 'json', 'schema', 'mix', 'order', 'answers', 'options', 'leakage', 'svg'];
    const { checks, ok: baseOk } = runChecks(names, raw, kase);
    const parsed = tryParse(raw);
    const qs = parsed?.questions ?? [];
    const nSrc = kase.sources.length;
    const relevant = new Set(kase.relevant);

    let rangeOk = qs.length > 0;
    for (const q of qs) {
      if (!Array.isArray(q.refs) || !q.refs.every((n) => Number.isInteger(n) && n >= 1 && n <= nSrc)) rangeOk = false;
    }
    checks.refsRange = { pass: rangeOk, note: rangeOk ? '' : `refs 需为 1..${nSrc} 的整数` };

    const withRefs = qs.filter((q) => Array.isArray(q.refs) && q.refs.length > 0).length;
    const coverage = qs.length ? withRefs / qs.length : 0;
    const coverageOk = coverage >= 0.5;
    checks.coverage = { pass: coverageOk, note: `带引用题占比 ${pct(coverage)}(事实全在资料里,≥50% 才及格)` };

    const cited = qs.flatMap((q) => (Array.isArray(q.refs) ? q.refs : []));
    const hits = cited.filter((n) => relevant.has(n)).length;
    const hitRate = cited.length ? hits / cited.length : 0;
    const hitOk = cited.length > 0 && hits === cited.length;
    checks.hit = { pass: hitOk, note: cited.length ? `命中 ${hits}/${cited.length}(引了不相关资料=失败)` : '零引用' };

    const success = baseOk && rangeOk && coverageOk && hitOk;
    return { checks, structOk: baseOk && rangeOk, coverage, hitRate, citedCount: cited.length, hitCount: hits, success, score: success ? 1 : 0 };
  },
  aggregate(results) {
    const success = results.filter((r) => r.success).length;
    const citedAll = results.reduce((a, r) => a + r.citedCount, 0);
    const hitAll = results.reduce((a, r) => a + r.hitCount, 0);
    return {
      primary: success / results.length,
      headline: `成功率 ${pct(success / results.length)} · 引用命中率 ${citedAll ? pct(hitAll / citedAll) : 'n/a'}`,
      metrics: {
        成功率: pct(success / results.length),
        引用命中率: citedAll ? pct(hitAll / citedAll) : 'n/a(零引用)',
        平均引用覆盖率: pct(mean(results.map((r) => r.coverage))),
        结构合格率: pct(results.filter((r) => r.structOk).length / results.length),
      },
    };
  },
  fake(kase) {
    const rel = kase.relevant[0];
    const snippet = kase.sources[rel - 1].snippet.slice(0, 30);
    const questions = [];
    for (const t of QUIZ_TYPES) {
      for (let i = 0; i < (kase.mix[t] ?? 0); i++) {
        const base = { explanation: `依据资料[${rel}]：${snippet}…`, svg: '', refs: [rel] };
        if (t === 'single')
          questions.push({ ...base, type: t, question: `根据资料，关于「${snippet}…」下列哪项正确？`, options: ['资料支持的表述', '干扰甲', '干扰乙', '干扰丙'], answer: [0] });
        else if (t === 'judge') questions.push({ ...base, type: t, question: `${snippet}。`, options: ['正确', '错误'], answer: [0] });
        else if (t === 'fill') questions.push({ ...base, type: t, question: `${snippet}，其关键概念是____。`, answer: ['要点'] });
        else if (t === 'multiple')
          questions.push({ ...base, type: t, question: `关于「${snippet}…」可推出哪些？`, options: ['可推一', '推不出', '可推二'], answer: [0, 2] });
        else questions.push({ ...base, type: t, question: `结合资料谈「${snippet}…」。`, answer: '要点', solution: '完整解答' });
      }
    }
    return `[QUIZ]${JSON.stringify({ title: '联网出题', questions })}[/QUIZ]`;
  },
};

// ════════════════════════ 词条抽取套件 ════════════════════════

function extractTermsBlock(raw) {
  const matches = [...raw.matchAll(/\[TERMS\]([\s\S]*?)\[\/TERMS\]/g)];
  const outside = raw.replace(/\[TERMS\][\s\S]*?\[\/TERMS\]/g, '').trim();
  return { body: matches[0]?.[1] ?? null, outside, count: matches.length };
}

/** 词条匹配:归一化相等 / 包含 / 相似度 ≥ 0.75 */
function termHit(a, b) {
  const x = String(a).toLowerCase().trim();
  const y = String(b).toLowerCase().trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x) || textSim(x, y) >= 0.75;
}

export const termsSuite = {
  grade(raw, kase) {
    const checks = {};
    const { body, outside, count } = extractTermsBlock(raw);
    checks.wrap = {
      pass: count === 1 && outside.length === 0,
      note: count !== 1 ? `${count} 对 [TERMS] 标记` : outside.length ? '标记外有多余文字' : '',
    };
    let parsed = null;
    try {
      parsed = body != null ? JSON.parse(body) : null;
      checks.json = { pass: parsed != null, note: parsed == null ? '无标记体' : '' };
    } catch (e) {
      checks.json = { pass: false, note: String(e.message).slice(0, 60) };
    }
    const terms = Array.isArray(parsed?.terms) ? parsed.terms : null;
    let schemaOk = terms != null && terms.length > 0;
    if (schemaOk)
      for (const t of terms)
        if (
          typeof t.term !== 'string' || !t.term.trim() ||
          typeof t.definition !== 'string' || !t.definition.trim() ||
          typeof t.domain !== 'string' ||
          typeof t.importance !== 'number' || t.importance < 0 || t.importance > 1
        )
          schemaOk = false;
    checks.schema = { pass: schemaOk, note: schemaOk ? '' : 'terms 字段契约不满足(term/definition/domain/importance)' };

    const n = terms?.length ?? 0;
    checks.count = { pass: n >= 3 && n <= 8, note: `抽了 ${n} 条(协议:通常 3-8)` };

    let precision = 0;
    let recall = 0;
    let f1 = 0;
    if (terms && terms.length) {
      const pred = terms.map((t) => t.term);
      const gold = kase.gold;
      const predHit = pred.filter((p) => gold.some((g) => termHit(p, g))).length;
      const goldHit = gold.filter((g) => pred.some((p) => termHit(p, g))).length;
      precision = predHit / pred.length;
      recall = goldHit / gold.length;
      f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    }
    checks.f1 = { pass: f1 >= 0.5, note: `P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)}` };

    const structOk = checks.wrap.pass && checks.json.pass && checks.schema.pass;
    const success = structOk && f1 >= 0.5;
    return { checks, structOk, precision, recall, f1, success, score: f1 };
  },
  aggregate(results) {
    const success = results.filter((r) => r.success).length;
    return {
      primary: mean(results.map((r) => r.f1)),
      headline: `平均 F1 ${mean(results.map((r) => r.f1)).toFixed(3)} · 成功率 ${pct(success / results.length)}`,
      metrics: {
        平均F1: mean(results.map((r) => r.f1)).toFixed(3),
        平均Precision: mean(results.map((r) => r.precision)).toFixed(3),
        平均Recall: mean(results.map((r) => r.recall)).toFixed(3),
        成功率: pct(success / results.length),
        结构合格率: pct(results.filter((r) => r.structOk).length / results.length),
      },
    };
  },
  fake(kase) {
    const terms = kase.gold.slice(0, 8).map((g) => ({
      term: g,
      definition: `${g} 的精炼释义(据材料)`,
      domain: kase.domain ?? 'general',
      importance: 0.8,
    }));
    return `[TERMS]${JSON.stringify({ terms })}[/TERMS]`;
  },
};

// ════════════════════════ 新套件自检 ════════════════════════

/** 返回失败条数;每条断言"该抓的必须抓到、该放的必须放行" */
export function selftestSuites() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };

  // 相似度度量本身
  check('相似度:全同文本 = 1', textSim('勾股定理指出 a²+b²=c²', '勾股定理指出 a²+b²=c²') === 1);
  check('相似度:无关文本 < 0.2', textSim('勾股定理指出直角三角形两直角边平方和等于斜边平方', 'The water cycle describes evaporation') < 0.2);
  check('相似度:近似改写落中间', (() => { const s = textSim('直角三角形两直角边的平方和等于斜边的平方', '直角三角形中,两条直角边平方之和等于斜边平方'); return s > 0.5 && s < 1; })());

  // 复刻:回显原题 → 高相似 + 成功;换答案 → 抓到
  const repCase = { id: 't', type: 'single', ref: { question: '中国最长的河流是哪一条？', options: ['黄河', '长江', '珠江', '黑龙江'], answer: [1] } };
  const good = replicateSuite.fake(repCase);
  const gGood = replicateSuite.grade(good, repCase);
  check('复刻:忠实复刻 → success 且相似度>0.95', gGood.success && gGood.similarity > 0.95);
  const flipped = good.replace('"answer":[1]', '"answer":[0]');
  const gBad = replicateSuite.grade(flipped, repCase);
  check('复刻:答案被改 → ansMatch=false 且不成功', !gBad.ansMatch && !gBad.success);
  const wrongType = good.replace('"type":"single"', '"type":"judge"');
  check('复刻:题型跑偏 → oneOfType 变红', !replicateSuite.grade(wrongType, repCase).checks.oneOfType.pass);

  // 联网引用:引对 → 成功;引到干扰源 → hit 红;编号越界 → refsRange 红
  const srchCase = {
    id: 't', mix: { single: 1, multiple: 0, fill: 0, essay: 0, judge: 1 },
    material: '围绕主题出题。',
    sources: [
      { title: '相关资料', url: 'https://a.example', snippet: '量子纠缠是两个粒子状态关联的现象,测量其一立即影响另一方的描述。' },
      { title: '无关资料', url: 'https://b.example', snippet: '红烧肉的做法:五花肉切块焯水,加冰糖酱油小火慢炖四十分钟。' },
    ],
    relevant: [1],
  };
  const sGood = searchSuite.fake(srchCase);
  check('联网:引用相关资料 → success', searchSuite.grade(sGood, srchCase).success);
  const sWrong = sGood.replaceAll('"refs":[1]', '"refs":[2]');
  check('联网:引用无关资料 → hit 变红', !searchSuite.grade(sWrong, srchCase).checks.hit.pass);
  const sOut = sGood.replaceAll('"refs":[1]', '"refs":[9]');
  check('联网:编号越界 → refsRange 变红', !searchSuite.grade(sOut, srchCase).checks.refsRange.pass);
  const sNone = sGood.replaceAll('"refs":[1]', '"refs":[]');
  check('联网:全不引用 → coverage 变红', !searchSuite.grade(sNone, srchCase).checks.coverage.pass);

  // 词条:命中金标 → F1=1;抽错词 → F1 低;缺字段 → schema 红
  const termCase = { id: 't', domain: '物理', material: '动能与势能……', gold: ['动能', '势能', '机械能'] };
  const tGood = termsSuite.fake(termCase);
  check('词条:全中金标 → F1=1 且 success', (() => { const g = termsSuite.grade(tGood, termCase); return g.f1 === 1 && g.success; })());
  const tWrong = `[TERMS]{"terms":[{"term":"红烧肉","definition":"一道菜","domain":"cooking","importance":0.9},{"term":"冰糖","definition":"调料","domain":"cooking","importance":0.5},{"term":"酱油","definition":"调料","domain":"cooking","importance":0.5}]}[/TERMS]`;
  check('词条:抽错词 → F1<0.3 且不成功', (() => { const g = termsSuite.grade(tWrong, termCase); return g.f1 < 0.3 && !g.success; })());
  const tNoField = `[TERMS]{"terms":[{"term":"动能","domain":"物理","importance":0.8}]}[/TERMS]`;
  check('词条:缺 definition → schema 变红', !termsSuite.grade(tNoField, termCase).checks.schema.pass);
  check('词条:模糊匹配容忍表述差异', termHit('二分查找算法', '二分查找'));

  return failed;
}
