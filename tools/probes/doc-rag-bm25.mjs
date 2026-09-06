/**
 * 离线探针：切块 + BM25 在长资料上的真实命中率与耗时（为 `docs/DOC-RAG-SPEC.md` §8 提供实测依据）。
 * 纯 JS、不联网、不调模型、不碰 better-sqlite3 ⇒ Node 20/22 都能跑。复跑：
 *   node tools/probes/doc-rag-bm25.mjs        # 产物写同目录 doc-rag-bm25.result.txt
 *   node --expose-gc tools/probes/doc-rag-bm25.mjs   # 末段的内存量测需要 gc 钩子，不给就自动跳过
 *
 * ★ 入库理由：契约 §8 里每个阈值数字（chunk=800 / k=12 / 60k 直塞上限）都是从这里量出来的，
 *   没有可复算脚本，后人就只能相信一段引用。改那些常量时重跑本脚本是**必需动作**。
 * ★ 诚实声明：本脚本**不 import 仓内实现**，而是自行复刻一份同参数的 BM25/切块（写它时实现还未落地）。
 *   所以它量到的是“这套算法参数的行为”，不是“仓内实现的行为”；两者的关联靠
 *   `doc-retrieve.test.ts` 里的 T8 召回锁（那边是真拿 `retrieveDoc` 跑的）。
 *   若两边分叉，以仓内实现 + 其单测为准，本脚本仅作参数选型的历史记录。
 *
 * v1 的缺陷（已修，记 §8.2 防重犯）：
 *  1. 语料只有 38k 字，未超过现状的 60k 直塞上限 → 「直塞丢了什么」这个对照根本没建立。
 *  2. 查询全部高亮命中事实句里的独一词汇 → 五组参数 recall 都是 1.00，等于没量。
 * v2 做法：
 *  - 语料 ~110k 字（24 章），另附一份「无换行平铺」变体量切块器的边界情形。
 *  - 每章一条冷门事实，查询分「关键词型」与「改写型」（同义替换，刻意避开原文用词）两类分别计量。
 *  - 三条基线对照：当前整篇直塞前 60k / 朴素取前 k 块 / BM25 top-k。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = [];
const log = (s) => { out.push(String(s)); };

const MAX_DOC_CHARS = 60_000; // 对照基线；现役值在 `shared/src/doc-rag.ts`，改那边不改这里是静默错账

// ── 语料构造 ─────────────────────────────────────────────
const TOPICS = [
  '牛顿运动定律', '功与能', '动量守恒', '万有引力与航天', '电场强度', '电势与等势面',
  '电流与电阻', '磁场对电流的作用', '电磁感应', '交流电与变压器', '光的折射', '光的干涉与衍射',
  '原子核式结构', '放射性与半衰期', '光电效应', '热力学第一定律', '气体动理论', '熵与方向性',
  '化学平衡', '电离平衡', '氧化还原反应', '电化学', '有机反应类型', '实验误差分析',
];
// 每章一组领域词，供模板拼正文——让章内词汇高度重叠，模拟真实讲义的难区分程度
const DOMAINS = [
  ['受力分析', '质量', '加速度', '合外力', '惯性'],
  ['做功', '动能', '势能', '机械能守恒', '功率'],
  ['动量', '冲量', '碰撞', '系统', '守恒条件'],
  ['轨道', '周期', '环绕速度', '中心天体', '引力常量'],
  ['电场线', '点电荷', '库仑力', '场强叠加', '试探电荷'],
  ['等势面', '电势差', '电场力做功', '零电势点', '电势能'],
  ['电阻率', '串联', '并联', '电动势', '内阻'],
  ['安培力', '洛伦兹', '磁感应强度', '左手定则', '载流导线'],
  ['磁通量', '感应电动势', '楞次定律', '切割磁感线', '线圈'],
  ['有效值', '匝数比', '升压', '频率', '铁芯'],
  ['折射率', '入射角', '折射角', '全反射', '临界角'],
  ['双缝', '亮纹', '光程差', '波长', '条纹间距'],
  ['α粒子散射', '核式模型', '电子轨道', '卢瑟福', '原子核'],
  ['半衰期', '衰变方程', '射线', '原子核', '统计规律'],
  ['遏止电压', '入射光频率', '逸出功', '光电子', '极限频率'],
  ['内能', '绝热', '等温变化', '做功与热传递', '状态量'],
  ['分子速率', '温度', '布朗运动', '扩散', '平均动能'],
  ['熵', '无序程度', '孤立系统', '方向性', '热力学第二定律'],
  ['平衡常数', '转化率', '勒夏特列', '催化剂', '平衡移动'],
  ['电离度', 'pH', '弱电解质', '离子积', '水解'],
  ['化合价', '电子转移', '氧化剂', '还原剂', '配平'],
  ['阴极', '阳极', '电解质溶液', '放电顺序', '电极反应式'],
  ['取代反应', '加成反应', '酯化', '官能团', '消去'],
  ['系统误差', '偶然误差', '有效数字', '多次测量', '仪器精度'],
];
// 事实句：查询要能在原文里定位到它（关键词型），改写型则刻意换词
const FACTS = [
  '月球表面的重力加速度约为 1.62 米每二次方秒。',
  '第一宇宙速度的数值是 7.9 千米每秒。',
  '完全非弹性碰撞中动能损失比例最大。',
  '卡文迪许扭秤实验第一次测出了引力常量 G。',
  '密立根油滴实验测定的是元电荷 e 的数值。',
  '场强为零的位置电势不一定为零。',
  '超导体零电阻状态对应的温度叫转变温度。',
  '霍尔电压与载流子浓度成反比。',
  '楞次定律的本质是能量守恒定律在感应电流方向上的体现。',
  '理想变压器原副线圈中交流的频率保持不变。',
  '全反射临界角的公式是 sin C 等于 1 除以折射率 n。',
  '双缝干涉中相邻亮纹间距与双缝到屏的距离成正比。',
  'α 射线穿透能力最弱但电离能力最强。',
  '半衰期不受温度与压强等外界条件影响。',
  '光电效应中遏止电压只与入射光频率有关。',
  '绝热过程中系统与外界没有热量交换。',
  '温度是分子平均动能的标志量。',
  '孤立系统的熵永不减少。',
  '加入催化剂不改变化学平衡位置只改变到达平衡的速率。',
  '水的离子积 Kw 在 25 摄氏度时等于 1e-14。',
  '原电池的负极发生氧化反应。',
  '电解饱和食盐水阴极的产物是氢气。',
  '酯化反应属于取代反应的一种。',
  '系统误差只能靠改进方法减小，不能靠多次测量消除。',
];
const GENERIC = [
  '这一节先给出定义与适用条件，再讨论边界情形下的退化行为，最后回到例题。',
  '常见的错误做法是把结论当成前提使用，此处需要特别注意因果方向不能颠倒。',
  '下面用三个由浅入深的例子说明该结论如何在具体题目里落地，先手推再代数。',
  '从守恒的角度看，上述结果与直觉一致，但推导步骤不可省略，量纲检查要放第一步。',
  '建议先做定性判断再做定量计算，否则很难发现中间结果的符号问题。',
  '本段只讨论理想情形，摩擦、散热、空气阻力等次级效应留到后面几节处理。',
  '这一结论在选择题里常以反例形式出现，务必记住它的成立前提和失效条件。',
  '把物理量的单位统一后再代入公式，是避免低级失误最省事的办法。',
];
// 模板：让正文里充满领域词，制造真实的词汇竞争（BM25 不能靠独一词白捡）
const TPL = [
  (d) => `处理${d[0]}问题时，第一步是厘清${d[1]}与${d[2]}之间的依赖关系，再判断${d[3]}是否满足前提。`,
  (d) => `${d[0]}的常见考法是把${d[1]}和${d[2]}混在一起给出，要求我们从${d[3]}出发反推${d[4]}。`,
  (d) => `讨论${d[0]}时必须先确定研究对象，否则${d[1]}的方向和${d[2]}的正负都无从谈起。`,
  (d) => `${d[3]}是理解${d[0]}的关键，它决定了${d[1]}在${d[4]}变化时的响应方式。`,
  (d) => `若忽略${d[2]}带来的影响，${d[0]}的计算结果会系统性偏离真实值，${d[4]}误差会被放大。`,
  (d) => `从${d[1]}的定义式出发，两边同乘${d[4]}后可以把${d[0]}改写成关于${d[3]}的关系。`,
  (d) => `考试中${d[0]}往往与${d[2]}结合命题，突破口是${d[1]}，检验手段是${d[3]}。`,
  (d) => `注意${d[4]}只在特定条件下成立，一旦${d[0]}超出该范围，${d[2]}就要重新估计。`,
];

function buildChapter(ci, withNewlines) {
  const d = DOMAINS[ci];
  const sep = withNewlines ? '\n\n' : '';
  const parts = withNewlines ? [`## 第 ${ci + 1} 章 ${TOPICS[ci]}`] : [`第${ci + 1}章${TOPICS[ci]}`];
  for (let p = 0; p < 40; p++) {
    const body = TPL[(ci + p) % TPL.length](d) + GENERIC[(ci + p) % GENERIC.length];
    if (p === 20) parts.push(body, FACTS[ci]);
    else parts.push(body);
  }
  return parts.join(sep);
}

const HEADER = '# 物理化学复习讲义（合成长资料，用于检索探针）\n\n';
const STRUCTURED = HEADER + TOPICS.map((_, i) => buildChapter(i, true)).join('\n\n');
const FLAT = '物理化学复习讲义' + TOPICS.map((_, i) => buildChapter(i, false)).join('');

// ── 切块（段落聚合 + 超长单段硬切，偏移精确对应原文）────────
function chunkDoc(text, size, overlap) {
  const paras = [];
  const re = /\n{2,}/g;
  let pos = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) paras.push([pos, m.index]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) paras.push([pos, text.length]);
  const chunks = [];
  let from = -1;
  let to = 0;
  let prefix = '';
  const push = (f, t, pre) => {
    const body = (pre ? pre + '\n' : '') + text.slice(f, t).trim();
    if (body.trim()) chunks.push({ seq: chunks.length, from: f, to: t, text: body });
  };
  for (const [f, t] of paras) {
    const raw = text.slice(f, t).trim();
    if (!raw) continue;
    if (raw.length > size) {
      // 单段就超阈值：先结算已积累的，再按定长硬切
      if (from >= 0) { push(from, to, prefix); from = -1; prefix = ''; }
      for (let s = 0; s < raw.length; s += size - overlap) {
        const e = Math.min(s + size, raw.length);
        const body = raw.slice(s, e);
        if (body.trim()) chunks.push({ seq: chunks.length, from: f + s, to: f + e, text: body });
        if (e === raw.length) break;
      }
      continue;
    }
    if (from < 0) { from = f; to = t; prefix = ''; continue; }
    if (to - from + (t - f) > size) {
      const tail = overlap > 0 ? text.slice(Math.max(from, to - overlap), to) : '';
      push(from, to, prefix);
      from = f; to = t; prefix = tail;
    } else {
      to = t;
    }
  }
  if (from >= 0) push(from, to, prefix);
  return chunks;
}

// ── 分词：英文/数字词 + 中文 bigram（单字也留，防二字词漏切）──
function tokenize(s) {
  const low = s.toLowerCase();
  const en = low.match(/[a-z][a-z0-9.+-]*|\d+(?:\.\d+)?/g) ?? [];
  const runs = low.match(/[\u4e00-\u9fff]+/g) ?? [];
  const cn = [];
  for (const r of runs) {
    if (r.length === 1) { cn.push(r); continue; }
    for (let i = 0; i < r.length - 1; i++) cn.push(r.slice(i, i + 2));
  }
  return [...en, ...cn];
}

// ── BM25（dl 预计算，避免检索时重复展开 map）──────────────
function buildIndex(chunks, k1 = 1.2, b = 0.75) {
  const tf = chunks.map((c) => {
    const m = new Map();
    for (const t of tokenize(c.text)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = chunks.length;
  const lens = tf.map((m) => { let n = 0; for (const v of m.values()) n += v; return n; });
  const avgdl = lens.reduce((s, n) => s + n, 0) / N;
  const idf = new Map();
  df.forEach((n, t) => idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5))));
  return { N, avgdl, k1, b, tf, lens, idf };
}

function search(idx, query) {
  const scores = new Array(idx.N).fill(0);
  for (const t of new Set(tokenize(query))) {
    const w = idx.idf.get(t);
    if (!w) continue;
    for (let i = 0; i < idx.N; i++) {
      const f = idx.tf[i].get(t);
      if (!f) continue;
      scores[i] += w * ((f * (idx.k1 + 1)) / (f + idx.k1 * (1 - idx.b + (idx.b * idx.lens[i]) / idx.avgdl)));
    }
  }
  const ranked = scores.map((s, i) => ({ i, s })).filter((r) => r.s > 0);
  ranked.sort((a, b) => b.s - a.s);
  return ranked;
}

// ── 查询集：关键词型（贴近原文用词）/ 改写型（同义替换，避开原词）──
const QUERIES = [
  { want: 1, kw: '月球表面的重力加速度是多少', para: '在月球上松手，物体下落得有多快' },
  { want: 2, kw: '第一宇宙速度的数值是多少', para: '贴着地表绕地球转需要多快的速度' },
  { want: 3, kw: '哪种碰撞动能损失比例最大', para: '两物体撞完粘在一起时机械能掉得最狠吗' },
  { want: 4, kw: '扭秤实验测出的引力常量是谁做的', para: '最早把万有引力那个比例系数称出来的人是谁' },
  { want: 5, kw: '油滴实验测定元电荷的数值', para: '基本电荷量是被哪个实验第一次数出来的' },
  { want: 6, kw: '场强为零处电势是否为零', para: '某点没有电场力的效果时，那里的电位参考值能确定吗' },
  { want: 9, kw: '楞次定律的本质是能量守恒吗', para: '判断感应电流方向那条规矩，深层依据是啥' },
  { want: 11, kw: '全反射临界角公式 sin C 等于 1 除以 n', para: '光从光密进光疏，刚好折不到达时的入射角怎么求' },
  { want: 14, kw: '半衰期受温度压强影响吗', para: '把样品加热，衰变一半所需时间会变吗' },
  { want: 15, kw: '遏止电压与入射光频率的关系', para: '让光电流刚好为零的那个反向电压取决于什么' },
  { want: 19, kw: '催化剂改变化学平衡位置吗', para: '加催化剂之后，最终转化率会不会提高' },
  { want: 22, kw: '电解饱和食盐水阴极产物是什么', para: '食盐水通电时，接负极那端冒出的气体是啥' },
  { want: 24, kw: '多次测量能不能消除系统误差', para: '把仪器本身的偏差靠反复读数取平均抹掉，行不行' },
];
const DISTRACTORS = [
  '资料里有没有讲量子色动力学',
  '拓扑绝缘体的能带反转是怎么一回事',
  '股票技术指标的 MACD 金叉怎么判断',
];

function evalCorpus(name, text, size, overlap, k) {
  const t0 = performance.now();
  const chunks = chunkDoc(text, size, overlap);
  const t1 = performance.now();
  const idx = buildIndex(chunks);
  const t2 = performance.now();
  const findFact = (n) => chunks.findIndex((c) => c.text.includes(FACTS[n - 1]));
  const run = (kind) => {
    let hit = 0;
    let naive = 0;
    let direct = 0;
    const rows = [];
    const dist = [];
    for (const q of QUERIES) {
      const ci = findFact(q.want);
      if (ci < 0) { rows.push(`  [数据缺失] 第${q.want}章事实未落进任何块`); continue; }
      const query = kind === 'kw' ? q.kw : q.para;
      const ranked = search(idx, query);
      const top = ranked.slice(0, k);
      const rank = top.findIndex((r) => r.i === ci);
      if (rank >= 0) hit++;
      // 基线 1：朴素取前 k 块（不做检索，只按原文顺序）
      if (ci < k) naive++;
      // 基线 2：现状整篇直塞前 MAX_DOC_CHARS 字
      if (chunks[ci].from < MAX_DOC_CHARS) direct++;
      const cs = ranked.find((r) => r.i === ci);
      dist.push({ kind, want: q.want, rank: rank >= 0 ? rank + 1 : 0, top1: top[0] ? top[0].s : 0, correct: cs ? cs.s : 0 });
      rows.push(
        `  ${kind === 'kw' ? 'KW  ' : 'PARA'} 第${String(q.want).padStart(2)}章 → 块#${ci}(起${chunks[ci].from}) ` +
        `${rank >= 0 ? 'rank' + (rank + 1) : '未进前' + k}｜正确块分=${cs ? cs.s.toFixed(2) : '-'} top1分=${top[0] ? top[0].s.toFixed(2) : '-'}｜直塞可见=${chunks[ci].from < MAX_DOC_CHARS ? 'Y' : 'N'}`,
      );
    }
    return { hit, naive, direct, rows, dist };
  };
  const t3 = performance.now();
  const kw = run('kw');
  const t4 = performance.now();
  const para = run('para');
  // 注入体量：top-k 块拼起来的字符数（决定 token 成本）
  const sample = search(idx, QUERIES[0].kw).slice(0, k).map((r) => chunks[r.i].text).join('\n');
  const distract = DISTRACTORS.map((q) => {
    const r = search(idx, q);
    return { q: q.slice(0, 12), top1: r.length ? +r[0].s.toFixed(2) : 0 };
  });
  return {
    name, size, overlap, k,
    kwDist: kw.dist, paraDist: para.dist,
    blocks: chunks.length,
    chars: text.length,
    chunkMs: +(t1 - t0).toFixed(1),
    indexMs: +(t2 - t1).toFixed(1),
    perQueryMs: +((t4 - t3) / (QUERIES.length * 2 + DISTRACTORS.length)).toFixed(2),
    kwHit: kw.hit, paraHit: para.hit, total: QUERIES.length,
    naive: kw.naive, direct: kw.direct,
    injectChars: sample.length,
    distract,
    rows: [...kw.rows, ...para.rows],
  };
}

const CONFIGS = [
  [800, 120, 6],
  [800, 120, 8],
  [800, 120, 4],
  [1200, 200, 6],
  [600, 0, 8],
];

log(`语料A（有换行分段）字数=${STRUCTURED.length}，语料B（单行平铺）字数=${FLAT.length}，直塞上限=${MAX_DOC_CHARS}`);
log('说明：PARA=改写型查询（刻意避开原文用词）；naive=朴素前k块基线；直塞可见=该块起点是否落在今天的前60k窗口内');
const results = [];
for (const [size, overlap, k] of CONFIGS) {
  results.push(evalCorpus('A分段', STRUCTURED, size, overlap, k));
  results.push(evalCorpus('B平铺', FLAT, size, overlap, k));
}
for (const r of results) {
  log('\n' + '='.repeat(70));
  log(`[${r.name}] chunk=${r.size} overlap=${r.overlap} k=${r.k}｜块数=${r.blocks}｜` +
    `关键词型 recall=${r.kwHit}/${r.total}｜改写型 recall=${r.paraHit}/${r.total}｜` +
    `朴素前${r.k}块命中=${r.naive}/${r.total}｜直塞可见=${r.direct}/${r.total}`);
  log(`  切块=${r.chunkMs}ms 建索引=${r.indexMs}ms 单次检索=${r.perQueryMs}ms top${r.k}注入字数=${r.injectChars} 干扰项=${r.distract.map((d) => `${d.q}=${d.top1}`).join(' / ')}`);
  if (r.name === 'A分段' && r.size === 800 && r.k === 6) r.rows.forEach((x) => log(x));
}

// ── 分数下限阀值分析（主配置 chunk=800 overlap=120 k=6）──────────
log('\n' + '='.repeat(70));
log('分数分布与「无相关内容」判定阀值（主配置 A分段 chunk=800 overlap=120 k=6）：');
const main = results.find((r) => r.name === 'A分段' && r.size === 800 && r.overlap === 120 && r.k === 6);
const allDist = [...main.kwDist, ...main.paraDist];
const hitScores = allDist.filter((d) => d.rank > 0).map((d) => d.correct).sort((a, b) => a - b);
const missScores = allDist.filter((d) => d.rank === 0).map((d) => d.correct).sort((a, b) => a - b);
const top1s = allDist.map((d) => d.top1).sort((a, b) => a - b);
const dis = main.distract.map((d) => d.top1).sort((a, b) => a - b);
const fmt = (a) => (a.length ? a.map((x) => x.toFixed(2)).join(', ') : '无');
log(`  命中查询的正确块分（${hitScores.length}）最小=${hitScores[0]?.toFixed(2)} 中位=${hitScores[Math.floor(hitScores.length / 2)]?.toFixed(2)}`);
log(`  未命中（改写型漏接）的正确块分：${fmt(missScores)}`);
log(`  所有查询 top1 分范围：${top1s[0]?.toFixed(2)} ~ ${top1s[top1s.length - 1]?.toFixed(2)}`);
log(`  干扰项（资料里没提）top1 分：${fmt(dis)}`);
log(`  → 关键结论：干扰项 top1(${dis[dis.length - 1]?.toFixed(2)}) 与命中正确块分(${hitScores[0]?.toFixed(2)}) 是否可分——绝对分数阀值能否单一取值看这里`);
log(`  → 可行替代：用「查询词元覆盖度」作相对判定而非绝对分（见下）。`);

// ── 替代判据实测：命中的「不同查询词元个数」能否分开真相关与伪相关 ────
function coverageProbe(text, size, overlap, k) {
  const chunks = chunkDoc(text, size, overlap);
  const toks = chunks.map((c) => new Set(tokenize(c.text)));
  const idx = buildIndex(chunks);
  const rows = [];
  const stat = { hitMinCov: Infinity, disMaxCov: 0, missCov: [] };
  const cov = (qi, ci) => [...tokenize(qi)].filter((t) => toks[ci].has(t)).length;
  for (const q of QUERIES) {
    const ci = chunks.findIndex((c) => c.text.includes(FACTS[q.want - 1]));
    for (const kind of ['kw', 'para']) {
      const query = kind === 'kw' ? q.kw : q.para;
      const ranked = search(idx, query).slice(0, k);
      const c = cov(query, ci);
      if (ranked.some((r) => r.i === ci)) stat.hitMinCov = Math.min(stat.hitMinCov, c);
      else stat.missCov.push(c);
      rows.push(`  ${kind} 第${String(q.want).padStart(2)}章 正确块词元覆盖数=${c} top1覆盖数=${cov(query, ranked[0] ? ranked[0].i : 0)}`);
    }
  }
  for (const d of DISTRACTORS) {
    const ranked = search(idx, d).slice(0, k);
    const maxc = ranked.reduce((mx, r) => Math.max(mx, cov(d, r.i)), 0);
    stat.disMaxCov = Math.max(stat.disMaxCov, maxc);
    rows.push(`  干扰「${d}」 top${k} 最大词元覆盖数=${maxc}`);
  }
  return { rows, stat };
}
const cov = coverageProbe(STRUCTURED, 800, 120, 6);
log('\n' + '='.repeat(70));
log('词元覆盖度（命中的不同查询词元个数，chunk=800 overlap=120 k=6）：');
log(`  真命中块的最小覆盖数=${cov.stat.hitMinCov}｜干扰项 top${6} 的最大覆盖数=${cov.stat.disMaxCov}｜改写型漏接块覆盖数=${JSON.stringify(cov.stat.missCov)}`);
cov.rows.forEach((x) => log(x));

// ── 规模测试：~700k 字（十倍近重复正文），事实只存在于最后一片 ───────
// 为何这样造：事实只放末尾 → 今天的前 60k 直塞窗口 100% 看不见，且全文到处
// 都充斥着同一批领域词 → 检索必须在大量高度同词竞争的块里找出唯一含答案的那块。
function buildScaleCopies(copies) {
  let s = '';
  for (let i = 0; i < copies; i++) {
    s += `\n\n# 复印部分 ${i + 1}\n\n`;
    for (let c = 0; c < TOPICS.length; c++) {
      const d = DOMAINS[c];
      const keep = i === copies - 1; // 只有最后一片带事实
      s += `第 ${c + 1} 章 ${TOPICS[c]}\n\n`;
      for (let p = 0; p < 40; p++) {
        const body = TPL[(c + p) % TPL.length](d) + GENERIC[(c + p) % GENERIC.length];
        s += body + '\n\n';
        if (p === 20 && keep) s += FACTS[c] + '\n\n';
      }
    }
  }
  return s;
}
const SCALE = buildScaleCopies(10);
log('\n' + '='.repeat(70));
log(`规模测试：字数=${SCALE.length}（事实全部在后 1/10）`);
for (const [size, overlap, k] of [[800, 120, 6], [1200, 200, 6]]) {
  const t0 = performance.now();
  const chunks = chunkDoc(SCALE, size, overlap);
  const t1 = performance.now();
  const idx = buildIndex(chunks);
  const t2 = performance.now();
  let kwHit = 0;
  let paraHit = 0;
  let direct = 0;
  let naive = 0;
  const miss = [];
  for (const q of QUERIES) {
    const ci = chunks.findIndex((c) => c.text.includes(FACTS[q.want - 1]));
    if (chunks[ci].from < MAX_DOC_CHARS) direct++;
    if (ci < k) naive++;
    if (search(idx, q.kw).slice(0, k).some((r) => r.i === ci)) kwHit++;
    if (search(idx, q.para).slice(0, k).some((r) => r.i === ci)) paraHit++;
    else miss.push(`第${q.want}章(${q.para})`);
  }
  const t3 = performance.now();
  log(`  [chunk=${size} overlap=${overlap} k=${k}] 块数=${chunks.length}｜` +
    `KW recall=${kwHit}/${QUERIES.length} PARA recall=${paraHit}/${QUERIES.length}｜` +
    `朴素前${k}块=${naive}/${QUERIES.length}｜直塞可见=${direct}/${QUERIES.length}｜` +
    `切块=${(t1 - t0).toFixed(1)}ms 建索引=${(t2 - t1).toFixed(1)}ms 检索=${((t3 - t2) / (QUERIES.length * 2)).toFixed(2)}ms/次`);
  if (miss.length) log(`    改写型漏接：${miss.join('、')}`);
}

// ── k 值扫描（700k 规模，chunk=800 overlap=120）：多给几块能否救回改写型 ───
log('\n' + '='.repeat(70));
log('k 值扫描（700k 字规模，chunk=800 overlap=120）：');
{
  const chunks = chunkDoc(SCALE, 800, 120);
  const idx = buildIndex(chunks);
  const wanted = QUERIES.map((q) => ({ q, ci: chunks.findIndex((c) => c.text.includes(FACTS[q.want - 1])) }));
  for (const k of [4, 6, 8, 12, 16, 24]) {
    let kwHit = 0;
    let paraHit = 0;
    let inject = 0;
    for (const w of wanted) {
      const rk = search(idx, w.q.kw).slice(0, k);
      if (rk.some((r) => r.i === w.ci)) kwHit++;
      const rp = search(idx, w.q.para).slice(0, k);
      if (rp.some((r) => r.i === w.ci)) paraHit++;
      inject += rk.reduce((s, r) => s + chunks[r.i].text.length, 0);
    }
    log(`  k=${String(k).padStart(2)}｜KW recall=${kwHit}/13 PARA recall=${paraHit}/13｜平均注入字数=${Math.round(inject / wanted.length)}`);
  }
}

// ── 内存占用：索引结构存不存得起（本地长驻服务会缓存多会话）────────
log('\n' + '='.repeat(70));
log('内存占用（chunk=800 overlap=120）：');
if (!global.gc) {
  // 不开 --expose-gc 时 heapUsed 里含着上一段没回收的语料，差值会算成负数；
  // 曾因此产生过一行 -5927 KB 的假数，所以宁可不测也不能给一个看着像真的噪声。
  log('  未开 --expose-gc，本次跳过。要量内存请跑：node --expose-gc tools/probes/doc-rag-bm25.mjs');
} else {
  global.gc();
  const m0 = process.memoryUsage().heapUsed;
  const chunks60k = chunkDoc(STRUCTURED, 800, 120);
  const idx60k = buildIndex(chunks60k);
  const m1 = process.memoryUsage().heapUsed;
  void idx60k;
  const idxScale = buildIndex(chunkDoc(SCALE, 800, 120));
  const m2 = process.memoryUsage().heapUsed;
  void chunks60k;
  log(`  72k 字（${idx60k.N} 块）heap 增量=${((m1 - m0) / 1024).toFixed(0)} KB`);
  log(`  716k 字（${idxScale.N} 块）heap 增量=${((m2 - m1) / 1024).toFixed(0)} KB = ${((m2 - m1) / 1024 / 1024).toFixed(1)} MB`);
  log('  → 单会话长资料缓存成本量级；量的是这个数级而不是小数点，两次跑差 30% 不影响结论。');
}
fs.writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-rag-bm25.result.txt'),
  out.join('\n') + '\n',
  'utf8',
);
console.log('done -> tools/probes/doc-rag-bm25.result.txt');
