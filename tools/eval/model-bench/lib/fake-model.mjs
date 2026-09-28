/**
 * evals/lib/fake-model — 确定性假模型 + 评分器自检夹具。
 *
 * fakeCompletion:按用例配比产出一份**应当全绿**的输出——用来证明「跑分通路」通,
 * 零 key、零网络(同 `npm run demo:e2e` 的假 LLM 哲学)。
 * BROKEN_FIXTURES:每条故意坏在一个点上,selftest 断言对应评分器**必须**抓到它——
 * 评分器自己也要有判断标准,不能只在好输出上全绿。
 */
import { QUIZ_TYPES } from './protocol.mjs';

/** 取材料第一句(截断到 40 字)拼进题干,保证 grounding 检查真实通过 */
function firstClause(material, max = 40) {
  const seg = material.split(/[。.!?！？\n]/)[0] ?? material;
  return seg.slice(0, max);
}

function makeQuestion(type, quizCase, idx) {
  const clause = firstClause(quizCase.material);
  const base = { explanation: `依据材料：${clause}。`, svg: '', refs: [] };
  switch (type) {
    case 'single':
      return {
        ...base,
        type,
        question: `根据材料「${clause}…」，下列哪一项与材料表述一致？`,
        options: ['与材料一致的那一项', '无关干扰项甲', '无关干扰项乙', '无关干扰项丙'],
        answer: [0],
      };
    case 'multiple':
      return {
        ...base,
        type,
        question: `关于「${clause}…」，下列哪些说法可以从材料推出？`,
        options: ['可推出的说法一', '推不出的说法', '可推出的说法二'],
        answer: [0, 2],
      };
    case 'fill':
      return {
        ...base,
        type,
        question: `${clause}，其中的关键概念是____。`,
        answer: [`要点${idx + 1}`],
      };
    case 'essay':
      return {
        ...base,
        type,
        question: `结合材料「${clause}…」，谈谈你的理解。`,
        answer: '参考要点：围绕材料核心概念展开。',
        solution: '完整解答：先复述材料要点,再给出推论。',
      };
    case 'judge':
      return {
        ...base,
        type,
        question: `${clause}。`,
        options: ['正确', '错误'],
        answer: [0],
      };
    default:
      throw new Error(`未知题型 ${type}`);
  }
}

/** 确定性假模型:严格按配比、按题型顺序产题 */
export function fakeCompletion(quizCase) {
  const questions = [];
  for (const t of QUIZ_TYPES)
    for (let i = 0; i < (quizCase.mix[t] ?? 0); i++) questions.push(makeQuestion(t, quizCase, i));
  return `[QUIZ]${JSON.stringify({ title: `${quizCase.domain}练习`, questions })}[/QUIZ]`;
}

// ── 自检夹具:每条坏在一处,断言对应检查抓得到 ──────────────

const OK_Q = {
  type: 'single',
  question: '根据材料，下列哪项正确？',
  options: ['甲', '乙', '丙', '丁'],
  answer: [0],
  explanation: '解析',
  svg: '',
  refs: [],
};
const wrapQ = (questions) => `[QUIZ]${JSON.stringify({ title: 'T', questions })}[/QUIZ]`;

/** { name, output, mustFail } —— mustFail 指必须变红的检查名 */
export const BROKEN_FIXTURES = [
  { name: '标记外有闲聊', mustFail: 'wrap', output: `好的,这是题目:\n${wrapQ([OK_Q])}` },
  { name: '缺闭合标记', mustFail: 'wrap', output: `[QUIZ]{"title":"T","questions":[]}` },
  { name: 'JSON 尾逗号', mustFail: 'json', output: `[QUIZ]{"title":"T","questions":[],}[/QUIZ]` },
  { name: '缺 svg 字段', mustFail: 'schema', output: wrapQ([(({ svg, ...r }) => r)(OK_Q)]) },
  { name: '缺 refs 字段', mustFail: 'schema', output: wrapQ([(({ refs, ...r }) => r)(OK_Q)]) },
  { name: '数量超配比', mustFail: 'mix', output: wrapQ([OK_Q, OK_Q]) },
  { name: '自造题型', mustFail: 'mix', output: wrapQ([{ ...OK_Q, type: 'matching' }]) },
  {
    name: '题型顺序倒置',
    mustFail: 'order',
    mix: { single: 1, judge: 1 },
    output: wrapQ([
      { ...OK_Q, type: 'judge', options: ['正确', '错误'], answer: [0] },
      OK_Q,
    ]),
  },
  { name: 'single 多个答案', mustFail: 'answers', output: wrapQ([{ ...OK_Q, answer: [0, 1] }]) },
  {
    name: 'judge 选项走样',
    mustFail: 'answers',
    mix: { judge: 1 },
    output: wrapQ([{ ...OK_Q, type: 'judge', options: ['对', '错'], answer: [0] }]),
  },
  {
    name: 'fill 没有空位',
    mustFail: 'answers',
    mix: { fill: 1 },
    output: wrapQ([{ type: 'fill', question: '关键概念是什么', answer: ['A'], explanation: 'x', svg: '', refs: [] }]),
  },
  { name: '答案下标越界', mustFail: 'answers', output: wrapQ([{ ...OK_Q, answer: [9] }]) },
  { name: '选项重复', mustFail: 'options', output: wrapQ([{ ...OK_Q, options: ['甲', '甲', '丙', '丁'] }]) },
  { name: '仅两个选项', mustFail: 'options', output: wrapQ([{ ...OK_Q, options: ['甲', '乙'] }]) },
  {
    name: '正确答案泄漏进题干',
    mustFail: 'leakage',
    output: wrapQ([{ ...OK_Q, question: '材料指出光合作用需要叶绿体,下列哪项正确?', options: ['光合作用需要叶绿体', '乙', '丙', '丁'] }]),
  },
  { name: '无资料却编 refs', mustFail: 'refs', output: wrapQ([{ ...OK_Q, refs: [1] }]) },
  {
    name: '照抄示例 SVG 方框',
    mustFail: 'svg',
    output: wrapQ([{ ...OK_Q, svg: "<svg viewBox='0 0 120 90'><rect x='25' y='15' width='60' height='60' fill='none' stroke='#555'/></svg>" }]),
  },
  { name: '解析为空', mustFail: 'explanation', output: wrapQ([{ ...OK_Q, explanation: '' }]) },
  {
    name: '题目与材料无关(编造)',
    mustFail: 'grounding',
    output: wrapQ([{ ...OK_Q, question: 'Black-Scholes 期权定价公式假设标的资产价格服从几何布朗运动,试求欧式看涨期权价值。' }]),
  },
];

/**
 * **反方向**夹具:每条都是合法输出,对应检查**必须放行**。
 *
 * 为什么补这一组(2026-09-28):原来的自检只有一个方向——BROKEN_FIXTURES 证明「该抓的抓到了」。
 * 于是一类事故是结构性看不见的:**评分器过严,把合法输出误杀**。它不会让自检变红,
 * 只会让跑分里多出几条莫名其妙的 ❌,而所有人都会默认「模型写坏了」。
 *
 * 这不是假想。接公开评测集的当天,`ceval/high_school_biology/val/2` 这条遗传题
 * (选项 `AaBb / Aabb / AAbb / aabb`)被 `options` 判成「选项重复」——查重当时带 `toLowerCase()`,
 * 四个选项归一成同一个串。**理想输出(原样回显真题)都过不了**。
 * 自造的 110 例里从没有大小写敏感的选项,所以这个洞在自检里是隐形的。⇒ 补上反方向。
 */
export const LEGIT_FIXTURES = [
  {
    name: '遗传题:选项只差大小写(AaBb/Aabb/AAbb/aabb)',
    mustPass: 'options',
    output: wrapQ([{ ...OK_Q, options: ['AaBb', 'Aabb', 'AAbb', 'aabb'] }]),
    why: 'ceval/high_school_biology/val/2 真题形状;大小写在遗传/化学/代码题里有语义',
  },
  {
    name: '化学题:CO 与 Co 是两种东西',
    mustPass: 'options',
    output: wrapQ([{ ...OK_Q, options: ['CO', 'Co', 'CO₂', 'C'] }]),
    why: '一氧化碳 vs 钴;大小写不敏感查重会把它们合并',
  },
  {
    name: '恰好三个选项(下限边界,不许误判为太少)',
    mustPass: 'options',
    output: wrapQ([{ ...OK_Q, options: ['甲', '乙', '丙'] }]),
    why: '检查写的是 <3 才红,3 个必须放行',
  },
  {
    name: '正确选项是短词且恰好在题干出现(未达泄漏门槛)',
    mustPass: 'leakage',
    output: wrapQ([{ ...OK_Q, question: '材料提到光合作用,下列哪项正确?', options: ['叶绿', '乙选项', '丙选项', '丁选项'] }]),
    why: '泄漏检查的门槛是正确选项长度 ≥4 才算;短词重合是中文里的常态,不该红',
  },
];

/** 自检用的基准用例(夹具可用 mix 覆写) */
export const FIXTURE_CASE = {
  id: 'selftest',
  domain: '生物',
  lang: 'zh',
  material: '光合作用是绿色植物利用叶绿体,把二氧化碳和水转化为有机物并释放氧气的过程。材料指出光合作用需要叶绿体。下列哪项正确,是常见考点。',
  mix: { single: 1, multiple: 0, fill: 0, essay: 0, judge: 0 },
};
