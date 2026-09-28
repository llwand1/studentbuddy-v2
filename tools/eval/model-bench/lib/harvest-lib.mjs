/**
 * model-bench/lib/harvest-lib —— 现场搜题的**纯逻辑**(零依赖、零网络:抽题协议 / 质检 / 去重 / 快照 / 稳定性对比)。
 *
 * ══ 为什么要现场搜题 ══
 *
 * 公开评测集(MMLU/C-Eval)解决了「有金标」,但没解决「没被背过」—— 它们大概率已在被测模型的
 * 训练数据里。而产品真实干的事是:**联网搜到一道刚出炉的题,把它复刻进协议**。
 * 这条链路只有拿**现场抓的题**才测得准。两个数并排读:
 *   公开集复刻分 高 而 现场题复刻分 低 ⇒ 模型是在背题面,不是在搬结构;
 *   两者接近                          ⇒ 复刻能力是真的,可以放心开这条链。
 *
 * ══ 为什么采集与评分要分成两段 ══
 *
 * 采集要联网、要调抽题模型,天生**不确定**;评分必须确定、可复算。所以:
 *   采集(harvest.mts) → 写一份带 provenance 的**冻结快照** jsonl → 评分(run.mjs)只读快照。
 * 这与评测台 `--replay` 是同一条纪律:网络与模型的抖动**不许流进分数里**。
 * 快照进 gitignore(同 `tools/eval/reports/`:入库就是把采集时刻的旧题留在树里误导人),
 * 但快照里逐条记着 source_url / fetched_at / channel / extractor,谁都能回去核。
 *
 * ══ 一个必须承认的混淆项 ══
 *
 * 抽题器本身是个 LLM。它抽错了(改了题干、猜了答案),会被后面的复刻评分记成「模型复刻不忠实」。
 * 三道闸降低这个混淆:
 *   ① **质检是规则的,不是模型的**(见 `validateItem`):结构不合格的候选直接丢,丢因逐条计数;
 *   ② 快照记 `extractor` 字段,抽题模型 == 被测模型时,报告打「自产自销」警示;
 *   ③ 快照可人读 —— 分数可疑时第一件事是去翻那 30 行 jsonl,而不是猜。
 */
import { textSim } from './similarity.mjs';

// ════════════════════════ 抽题协议 ════════════════════════

/**
 * 从网页正文里抽选择题。
 *
 * 写法上刻意与产品 `QUIZ_PROTOCOL` 不同源:这里抽的是**网页上已经存在的题**,不是让模型出题。
 * 「不许发明」「抽不到就返回空数组」是本协议的全部要点 —— 抽题器一旦开始创作,
 * 现场题就退化成了另一个自造数据集,本套件的全部意义就没了。
 */
export const EXTRACT_PROTOCOL = [
  '你是题目抽取器。下面是一个网页的正文。请把其中**已经存在**的选择题原样抽出来。',
  '',
  '硬规则：',
  '1. 只抽网页上真实存在的题，**一道都不许发明、不许补全、不许改写题干**。排版噪音（多余空格、编号、"答案："前缀）可以清理。',
  '2. 只要选择题（单选/多选），且必须同时具备：完整题干、≥2 个选项、页面上明确给出的正确答案。三者缺一就跳过这道。',
  '3. 题干里引用了图片/表格（"如图""下图""根据上表"）的，**跳过** —— 抽出来也没法答。',
  '4. answer 填正确选项的**下标数组**（0 起），单选一个元素，多选多个。页面只给字母的自己换算。',
  '5. 抽不到任何合格的题就返回空数组，这是完全可以接受的结果。',
  '',
  '只输出被 [ITEMS] 与 [/ITEMS] 包裹的 JSON，标记外不要有任何文字：',
  '[ITEMS]{"items":[{"question":"题干","options":["选项1","选项2","选项3","选项4"],"answer":[1],"subject":"学科（没有就填空串）"}]}[/ITEMS]',
].join('\n');

/** 网页正文 → 抽题提示词(正文截断 6000 字符:再长抽题器也读不完,还把成本翻倍) */
export function buildExtractPrompt(pageText, meta = {}) {
  return [
    EXTRACT_PROTOCOL,
    '',
    `网页标题：${meta.title ?? '(无)'}`,
    `网页正文：\n${String(pageText ?? '').slice(0, 6000)}`,
  ].join('\n');
}

/** 抽题器输出 → 候选数组;解不出返回 null(与「抽到 0 条」是两回事,调用侧分开计数) */
export function parseExtracted(raw) {
  const m = String(raw ?? '').match(/\[ITEMS\]([\s\S]*?)\[\/ITEMS\]/);
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]);
    return Array.isArray(body?.items) ? body.items : null;
  } catch {
    return null;
  }
}

// ════════════════════════ 质检(规则,零模型) ════════════════════════

/** 题干里出现这些词 ⇒ 依赖图表,产品里答不了 */
const NEEDS_MEDIA = /(如图|下图|上图|右图|左图|图中|根据下表|上表所示|见附图|如下图所示)/;
/** 网页导航残渣的典型特征 */
const PAGE_NOISE = /(登录|注册|版权所有|Copyright|下载APP|扫码关注|上一篇|下一篇|相关推荐)/i;

/**
 * 单条候选的质检。**每条丢弃都有一个可统计的理由** —— 采集产出率低时,
 * 丢因分布直接告诉你是「搜到的页面不对」还是「抽题器不行」。
 *
 * @returns {{ ok: true, item: object } | { ok: false, reason: string }}
 */
export function validateItem(cand) {
  const q = typeof cand?.question === 'string' ? cand.question.trim() : '';
  if (!q) return { ok: false, reason: 'no-stem' };
  if (q.length < 6) return { ok: false, reason: 'stem-too-short' };
  // 600 字符以上八成是把整页塞进来了(真实题干极少超过这个量级)
  if (q.length > 600) return { ok: false, reason: 'stem-too-long' };
  if (NEEDS_MEDIA.test(q)) return { ok: false, reason: 'needs-media' };
  if (PAGE_NOISE.test(q)) return { ok: false, reason: 'page-noise' };

  const options = Array.isArray(cand.options) ? cand.options.map((o) => String(o ?? '').trim()) : [];
  if (options.length < 2) return { ok: false, reason: 'few-options' };
  if (options.length > 8) return { ok: false, reason: 'too-many-options' };
  if (options.some((o) => !o)) return { ok: false, reason: 'empty-option' };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, reason: 'dup-option' };

  const answer = Array.isArray(cand.answer) ? cand.answer.map(Number) : [];
  if (answer.length === 0) return { ok: false, reason: 'no-answer' };
  if (answer.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length))
    return { ok: false, reason: 'answer-out-of-range' };
  if (new Set(answer).size !== answer.length) return { ok: false, reason: 'dup-answer' };
  if (answer.length === options.length) return { ok: false, reason: 'all-options-correct' };

  // 正确选项原文整个出现在题干里 = 送分题,多半是抽题器把答案行混进了题干
  const correctText = answer.map((i) => options[i]).filter((t) => t.length >= 4);
  if (correctText.some((t) => q.includes(t))) return { ok: false, reason: 'answer-leak-in-stem' };

  return {
    ok: true,
    item: {
      question: q,
      options,
      answer: [...answer].sort((a, b) => a - b),
      subject: typeof cand.subject === 'string' ? cand.subject.trim() : '',
    },
  };
}

/**
 * 去重:题干相似度 ≥ 0.9 视为同一道。
 * 阈值比复刻套件的 0.55 高得多 —— 这里要的是「同一道题的不同排版」,不是「意思差不多」。
 * 真题在网上被转载得到处都是,不去重的话一份快照里能有五份同题。
 */
export function dedupe(items, threshold = 0.9) {
  const kept = [];
  let removed = 0;
  for (const it of items) {
    if (kept.some((k) => textSim(k.question, it.question) >= threshold)) {
      removed += 1;
      continue;
    }
    kept.push(it);
  }
  return { kept, removed };
}

/** 现场题 → 复刻用例(与 `toReplicateCase` 同形,直接喂既有复刻评分器) */
export function toLiveCase(item) {
  return {
    id: item.id,
    domain: item.subject || item.query || 'live',
    lang: 'zh',
    source: 'live',
    type: item.answer.length > 1 ? 'multiple' : 'single',
    ref: { question: item.question, options: item.options, answer: item.answer },
  };
}

// ════════════════════════ 快照的统计与对比 ════════════════════════

/** 一份快照的画像 */
export function snapshotStats(snapshot) {
  const items = snapshot.items ?? [];
  const hosts = new Map();
  for (const it of items) {
    let h = '(无)';
    try {
      h = new URL(it.sourceUrl).host;
    } catch {
      /* 留 (无) */
    }
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  return {
    channel: snapshot.channel,
    items: items.length,
    queries: snapshot.queries?.length ?? 0,
    pagesFetched: snapshot.pagesFetched ?? 0,
    pagesUsable: snapshot.pagesUsable ?? 0,
    multiple: items.filter((i) => i.answer.length > 1).length,
    hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]),
    dropped: snapshot.dropped ?? {},
    duplicatesRemoved: snapshot.duplicatesRemoved ?? 0,
  };
}

/**
 * 两份快照的**稳定性对比**(免 key 通道 vs 带 key 通道)。
 *
 * 回答三个问题:
 *   ① **产出率**:同样的查询词,哪条通道能抓到更多合格题?(pagesFetched → items 的转化)
 *   ② **重合度**:两条通道抓到的是不是同一批题?重合低 ⇒ 后续两次跑分的差异里混着
 *      「换了一批题」这个自变量,**不能直接比分数大小** —— 这正是本函数存在的理由。
 *   ③ **来源分布**:免 key 通道是不是总落在同几个站上?(单一来源 = 结论没有推广性)
 *
 * 题目重合用 textSim ≥ 0.85 配对(比去重阈值略松:两条通道的排版清理会有细微差别)。
 */
export function compareHarvests(a, b, threshold = 0.85) {
  const sa = snapshotStats(a);
  const sb = snapshotStats(b);
  const ia = a.items ?? [];
  const ib = b.items ?? [];

  const usedB = new Set();
  const pairs = [];
  for (const x of ia) {
    let best = -1;
    let bestSim = 0;
    for (let j = 0; j < ib.length; j++) {
      if (usedB.has(j)) continue;
      const s = textSim(x.question, ib[j].question);
      if (s > bestSim) {
        bestSim = s;
        best = j;
      }
    }
    if (best >= 0 && bestSim >= threshold) {
      usedB.add(best);
      pairs.push({ a: x.id, b: ib[best].id, sim: bestSim });
    }
  }

  const urlsA = new Set(ia.map((i) => i.sourceUrl));
  const urlsB = new Set(ib.map((i) => i.sourceUrl));
  const urlInter = [...urlsA].filter((u) => urlsB.has(u)).length;
  const urlUnion = new Set([...urlsA, ...urlsB]).size;

  const jaccard = urlUnion ? urlInter / urlUnion : 0;
  // 重合率分母取较大的一份:小份完全被大份包住时不该读成 100% 一致
  const overlap = Math.max(ia.length, ib.length) ? pairs.length / Math.max(ia.length, ib.length) : 0;

  return {
    a: sa,
    b: sb,
    pairedItems: pairs.length,
    itemOverlap: overlap,
    urlJaccard: jaccard,
    pairs: pairs.slice(0, 20),
    // 读法提示随数据一起走,免得下游只看见一个 0.12 却不知道该怎么办
    verdict:
      overlap >= 0.6
        ? '两条通道抓到的基本是同一批题 ⇒ 后续两次跑分的差异可以直接归因到通道/模型'
        : '两条通道抓到的是**不同的题** ⇒ 分数差里混着「换了一批题」,只能比各自的绝对水平，不能比差值',
  };
}

// ════════════════════════ 自检 ════════════════════════

export function selftestHarvest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };

  const good = { question: '下列关于欧姆定律的说法，正确的是？', options: ['电阻与电压成正比', '电流与电压成正比', '电流与电阻成正比', '电压与电流无关'], answer: [1] };
  check('质检:合格题通过', validateItem(good).ok);
  check('质检:缺答案 → no-answer', validateItem({ ...good, answer: [] }).reason === 'no-answer');
  check('质检:答案越界 → answer-out-of-range', validateItem({ ...good, answer: [9] }).reason === 'answer-out-of-range');
  check('质检:只有一个选项 → few-options', validateItem({ ...good, options: ['甲'] }).reason === 'few-options');
  check('质检:选项重复 → dup-option', validateItem({ ...good, options: ['甲', '甲', '乙', '丙'] }).reason === 'dup-option');
  check('质检:空选项 → empty-option', validateItem({ ...good, options: ['甲', '', '乙', '丙'] }).reason === 'empty-option');
  check('质检:全选项都对 → all-options-correct', validateItem({ ...good, answer: [0, 1, 2, 3] }).reason === 'all-options-correct');
  check('质检:依赖图表 → needs-media', validateItem({ ...good, question: '如图所示电路中，电流为多少？' }).reason === 'needs-media');
  check('质检:导航残渣 → page-noise', validateItem({ ...good, question: '下一篇：欧姆定律练习题及答案下载APP查看' }).reason === 'page-noise');
  check('质检:题干整段吞了正确选项 → answer-leak-in-stem', !validateItem({
    question: '电流与电压成正比，这句话对吗？请选择',
    options: ['电阻与电压成正比', '电流与电压成正比', '电流与电阻成正比', '以上都不对'],
    answer: [1],
  }).ok);
  check('质检:题干过长 → stem-too-long', validateItem({ ...good, question: '题'.repeat(700) }).reason === 'stem-too-long');

  check('抽题:解出标记内 JSON', (parseExtracted('[ITEMS]{"items":[{"question":"q"}]}[/ITEMS]') ?? []).length === 1);
  check('抽题:没标记 → null(与「抽到 0 条」分开)', parseExtracted('我没找到题目') === null);
  check('抽题:空数组是合法结果', (parseExtracted('[ITEMS]{"items":[]}[/ITEMS]') ?? null)?.length === 0);

  const dupSet = [
    { question: '下列关于欧姆定律的说法，正确的是？' },
    { question: '下列关于欧姆定律的说法,正确的是?' },
    { question: '光合作用的主要场所是哪里？' },
  ];
  check('去重:同题不同排版被合并(3 → 2)', dedupe(dupSet).kept.length === 2);

  const snapA = { channel: 'free', queries: ['q'], pagesFetched: 4, items: [
    { id: 'a1', question: '下列关于欧姆定律的说法，正确的是？', options: ['x', 'y'], answer: [0], sourceUrl: 'https://e1.example/a' },
    { id: 'a2', question: '光合作用的主要场所是哪里？', options: ['x', 'y'], answer: [0], sourceUrl: 'https://e2.example/b' },
  ] };
  const snapB = { channel: 'keyed', queries: ['q'], pagesFetched: 4, items: [
    { id: 'b1', question: '下列关于欧姆定律的说法,正确的是?', options: ['x', 'y'], answer: [0], sourceUrl: 'https://e1.example/a' },
    { id: 'b2', question: '牛顿第二定律的公式是什么？', options: ['x', 'y'], answer: [0], sourceUrl: 'https://e3.example/c' },
  ] };
  const cmp = compareHarvests(snapA, snapB);
  check('对比:配对出 1 道同题', cmp.pairedItems === 1);
  check('对比:重合率 0.5 且给出读法提示', Math.abs(cmp.itemOverlap - 0.5) < 1e-9 && cmp.verdict.includes('不同的题'));
  check('对比:URL Jaccard = 1/3', Math.abs(cmp.urlJaccard - 1 / 3) < 1e-9);

  return failed;
}
