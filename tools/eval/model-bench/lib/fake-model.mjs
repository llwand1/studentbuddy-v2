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

/** 自检用的基准用例(夹具可用 mix 覆写) */
export const FIXTURE_CASE = {
  id: 'selftest',
  domain: '生物',
  lang: 'zh',
  material: '光合作用是绿色植物利用叶绿体,把二氧化碳和水转化为有机物并释放氧气的过程。材料指出光合作用需要叶绿体。下列哪项正确,是常见考点。',
  mix: { single: 1, multiple: 0, fill: 0, essay: 0, judge: 0 },
};
