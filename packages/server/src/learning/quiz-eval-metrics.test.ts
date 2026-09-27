/**
 * quiz-eval-metrics 的口径锁（契约 EVAL-SPEC §3.1 批次 A）。
 * ★ 这批测试守的是**对外报数的定义**，不是实现细节：一次成型率、完美出题率、留图率、
 *   坏答案、分母口径。改这里的任何一条断言＝改评测口径，必须在 EVAL-SPEC 同批登记。
 * ★ 满配与题组形状一律走产品自己的 `applyQuizMix` 造，不在测试里复刻裁剪语义。
 */
import { describe, expect, it } from 'vitest';
import type { QuizImageReport, QuizMix, QuizPayload, QuizQuestion } from '@sb/shared';
import { emptyQuizImageReport } from '@sb/shared';
import { applyQuizMix } from './quiz.js';
import { quizStemKey, scoreQuizQuestion, scoreQuizRun, summarizeRuns } from './quiz-eval-metrics.js';
import type { QuizEvalRunInput, QuizRunScore } from './quiz-eval-metrics.js';

const MIX: QuizMix = { single: 1, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 };

function choiceQuestion(stem: string): QuizQuestion {
  return { type: 'single', question: stem, options: ['甲', '乙'], answer: [0], explanation: '因为甲' };
}

function payloadOf(questions: QuizQuestion[]): QuizPayload {
  return { title: '评测组', questions };
}

/** 走一遍产品的配比裁剪，拿到「交付题组 + 配比报告」——不在测试里另写一套裁剪 */
function runOf(
  questions: QuizQuestion[],
  override: Partial<QuizEvalRunInput> = {},
): QuizRunScore {
  const payload = payloadOf(questions);
  const applied = applyQuizMix(payload, MIX);
  const imageReport: QuizImageReport = { ...emptyQuizImageReport(override.imageOn ?? false) };
  if (applied.quiz) imageReport.delivered = applied.quiz.questions.filter((q) => !!q.svg).length;
  return scoreQuizRun({
    caseId: 'c1',
    topic: '测试词条',
    discipline: '编程',
    mix: MIX,
    rawText: `[QUIZ]${JSON.stringify(payload)}[/QUIZ]`,
    delivered: applied.quiz,
    imageReport,
    aiMixReport: applied.report,
    latencyMs: 1200,
    model: 'test-model',
    ...override,
  });
}

describe('一次成型（strict）与抢救阶梯的定性', () => {
  it('合法 JSON 包在 [QUIZ] 里＝strict，且各项条件齐全时判为完美组', () => {
    const s = runOf([choiceQuestion('1+1 等于几？')]);
    expect(s.grade).toBe('strict');
    expect(s.matched).toBe(true);
    expect(s.perfect).toBe(true);
    expect(s.requestedTotal).toBe(1);
    expect(s.deliveredTotal).toBe(1);
  });

  it('options 漏收尾中括号（真机复验抓到的第四种失败）＝靠无损修复，不算一次成型', () => {
    const s = runOf([choiceQuestion('题干')], {
      rawText:
        '{"title":"评测组","questions":[{"type":"single","question":"题干","options":["甲","乙","answer":[0],"explanation":"因为甲"}]}',
    });
    expect(s.grade).toBe('repaired');
    expect(s.perfect).toBe(false);
  });

  it('题目里写 LaTeX 漏掉第二根斜杠＝同一种 repaired（写 \\sin 是非法转义）', () => {
    const s = runOf([{ type: 'fill', question: '求 $\\sin 30^\\circ$ 的值____', answer: ['0.5'], explanation: 'e' }], {
      rawText: '{"title":"t","questions":[{"type":"fill","question":"求 $\\sin 30^\\circ$ 的值____","answer":["0.5"],"explanation":"e"}]}',
    });
    expect(s.grade).toBe('repaired');
  });

  it('末尾残缺＝修复器刻意不补（凭猜往下编结构会造出错题），只能算 rescued', () => {
    const s = runOf([choiceQuestion('题干')], {
      rawText: '{"title":"评测组","questions":[{"type":"single","question":"题干","options":["甲","乙"],"answer":[0],"explanation":"因为甲"',
    });
    expect(s.grade).toBe('rescued');
  });

  it('修复也解不出、但产品救出了题组＝rescued（既不冒充 strict 也不冒充 failed）', () => {
    const s = runOf([choiceQuestion('题干')], { rawText: '[QUIZ]{"questions":[oops]}[/QUIZ]' });
    expect(s.grade).toBe('rescued');
    expect(s.perfect).toBe(false);
  });

  it('产品没交付＝failed，failure 取产品上报的真因而不是笼统「失败」', () => {
    const s = runOf([choiceQuestion('题干')], {
      rawText: '抱歉，我无法出题。',
      delivered: null,
      imageReport: { ...emptyQuizImageReport(false), failure: 'parse' },
      aiMixReport: { requested: MIX, actual: { ...MIX, single: 0 }, matched: true },
    });
    expect(s.grade).toBe('failed');
    expect(s.success).toBe(false);
    expect(s.failure).toBe('parse');
  });

  it('传输层失败优先于产品上报（429 不能被记成「模型解析不出」）', () => {
    const s = runOf([choiceQuestion('题干')], {
      rawText: '',
      delivered: null,
      transportError: 'HTTP 429',
      imageReport: { ...emptyQuizImageReport(false), failure: 'parse' },
    });
    expect(s.failure).toBe('HTTP 429');
    expect(s.grade).toBe('failed');
  });

  it('svg 里漏转义双引号＝不算一次成型（配图 0 产率那类事故现场就是这一形状）', () => {
    const q: QuizQuestion = { ...choiceQuestion('看图'), svg: '<svg viewBox="0 0 1 1"></svg>' };
    // 手写字符串，故意让 svg 值里带裸双引号——这是模型最常犯的 JSON 卫生问题
    const raw =
      '[QUIZ]{"title":"t","questions":[{"type":"single","question":"看图","options":["甲","乙"],"answer":[0],"explanation":"e","svg":"<svg viewBox="0 0 1 1"></svg>"}]}[/QUIZ]';
    const s = runOf([q], { rawText: raw, imageOn: true });
    expect(s.grade).not.toBe('strict');
    expect(s.perfect).toBe(false);
  });
});

describe('题面体检（坏答案／坏选项／坏空位）', () => {
  it('答案下标越界＝坏答案：题面看着正常，判分必错', () => {
    const q: QuizQuestion = { type: 'single', question: '题干', options: ['甲', '乙'], answer: [7], explanation: 'e' };
    expect(scoreQuizQuestion(q).answerValid).toBe(false);
    expect(scoreQuizQuestion(q).complete).toBe(false);
  });

  it('单选题给了两个正确项＝坏答案（协议要求恰好一个）', () => {
    const q: QuizQuestion = { type: 'single', question: '题干', options: ['甲', '乙'], answer: [0, 1], explanation: 'e' };
    expect(scoreQuizQuestion(q).answerValid).toBe(false);
  });

  it('判断题选项不是「正确／错误」＝坏选项（前端按它判分，写错就永远判不对）', () => {
    const q: QuizQuestion = { type: 'judge', question: '地球是方的', options: ['对', '错'], answer: [0] };
    expect(scoreQuizQuestion(q).optionsValid).toBe(false);
  });

  it('填空题题干没有空位＝坏题（没有可填的位置，答案数组无处安放）', () => {
    const q: QuizQuestion = { type: 'fill', question: '水的化学式是什么', answer: ['H2O'], explanation: 'e' };
    expect(scoreQuizQuestion(q).blankOk).toBe(false);
    expect(scoreQuizQuestion(q).complete).toBe(false);
  });

  it('填空题有空位＝过关；解答题缺 solution＝不过关', () => {
    const fill: QuizQuestion = { type: 'fill', question: '水的化学式是____', answer: ['H2O'], explanation: 'e' };
    const essayNoSolution: QuizQuestion = { type: 'essay', question: '证明 sqrt2 是无理数', answer: '反设法', explanation: 'e' };
    expect(scoreQuizQuestion(fill).complete).toBe(true);
    expect(scoreQuizQuestion(essayNoSolution).solutionOk).toBe(false);
  });

  it('缺解析＝不过关（用户看不到为什么错，题等于少一半）', () => {
    const q: QuizQuestion = { type: 'single', question: '题干', options: ['甲', '乙'], answer: [0] };
    expect(scoreQuizQuestion(q).hasExplanation).toBe(false);
  });

  it('解答题不判分：`answer` 与 `solution` 有其一就判得下去（108 题真机逼出来的口径修正）', () => {
    const onlySolution: QuizQuestion = { type: 'essay', question: '简述秦朝巩固统一的措施', solution: '书同文、车同轨……' };
    const neither: QuizQuestion = { type: 'essay', question: '简述秦朝巩固统一的措施' };
    const singleNoAnswer: QuizQuestion = { type: 'single', question: '题干', options: ['甲', '乙'] };
    expect(scoreQuizQuestion(onlySolution).answerValid).toBe(true);
    expect(scoreQuizQuestion(onlySolution).complete).toBe(true);
    expect(scoreQuizQuestion(neither).answerValid).toBe(false);
    // 反向锁：选择题没答案是真坏题（判分必错），不许被 essay 的宽松口径带过去
    expect(scoreQuizQuestion(singleNoAnswer).answerValid).toBe(false);
  });

  it('解答题没有 `explanation` 仍算齐全——判据跟产品协议示例对齐，其余题型反向锁住', () => {
    const essay: QuizQuestion = { type: 'essay', question: '证明 sqrt2 是无理数', answer: '反设法', solution: '设其为分数……' };
    expect(scoreQuizQuestion(essay).hasExplanation).toBe(false); // 观察值照实记，报告里看得见
    expect(scoreQuizQuestion(essay).explanationOk).toBe(true); // 判据不卡它
    expect(scoreQuizQuestion(essay).complete).toBe(true);
    const single: QuizQuestion = { type: 'single', question: '题干', options: ['甲', '乙'], answer: [0] };
    expect(scoreQuizQuestion(single).explanationOk).toBe(false);
    expect(scoreQuizQuestion(single).complete).toBe(false);
  });
});

describe('重复题与归一化题干', () => {
  it('标点与空格差异不改判定：同一句话算重复', () => {
    expect(quizStemKey('1+1 等于几？')).toBe(quizStemKey('1 + 1 等于几'));
  });

  it('组内两道同干＝duplicates 1，完美组判据随即不成立', () => {
    const s = scoreQuizRun({
      caseId: 'c2',
      topic: 't',
      discipline: '编程',
      imageOn: false,
      mix: { ...MIX, single: 2 },
      rawText: `[QUIZ]${JSON.stringify(payloadOf([choiceQuestion('题A'), choiceQuestion('题A')]))}[/QUIZ]`,
      delivered: payloadOf([choiceQuestion('题A'), choiceQuestion('题A')]),
      imageReport: emptyQuizImageReport(false),
      aiMixReport: { requested: { ...MIX, single: 2 }, actual: { ...MIX, single: 2 }, matched: true },
      latencyMs: 900,
      model: 'test-model',
    });
    expect(s.duplicates).toBe(1);
    expect(s.perfect).toBe(false);
  });
});

describe('配图：产图率／留图率的分母口径', () => {
  it('模型画了 2 张、交付 1 张、丢 1 张＝留图率 1/2（丢了的不进分子）', () => {
    const withSvg = (stem: string): QuizQuestion => ({ ...choiceQuestion(stem), svg: '<svg viewBox="0 0 1 1"></svg>' });
    const one = runOf([withSvg('题A')], { imageOn: true });
    const other = runOf([withSvg('题B')], {
      imageOn: true,
      imageReport: { ...emptyQuizImageReport(true), delivered: 1, droppedSvg: 1 },
    });
    const sum = summarizeRuns([one, other]);
    expect(sum.image).not.toBe(null);
    expect(sum.image?.retained).toEqual({ n: 2, d: 2 });
    expect(sum.droppedSvg).toBe(1);
  });

  it('解不出 JSON 时 svgInRaw＝null，绝不把「没量到」当 0 拉低留图率', () => {
    const s = runOf([choiceQuestion('题干')], { rawText: '[QUIZ]{"questions":[oops]}[/QUIZ]', imageOn: true });
    expect(s.svgInRaw).toBe(null);
    expect(summarizeRuns([s]).image?.retained).toEqual({ n: 0, d: 0 });
  });

  it('整组关配图时 image＝null（不拿关图的数据冒充开图的读数）', () => {
    expect(summarizeRuns([runOf([choiceQuestion('题干')], { imageOn: false })]).image).toBe(null);
  });

  it('同一份指标里混开图与关图的组＝当场罢工（隔壁评测台「静默退化成同一档」的同族坑）', () => {
    const on = runOf([choiceQuestion('题干')], { imageOn: true });
    const off = runOf([choiceQuestion('题干2')], { imageOn: false });
    expect(() => summarizeRuns([on, off])).toThrow(/按 arm 分开/);
  });
});

describe('汇总分母如实（对外报的每个数都要能对回组数）', () => {
  const twoRuns = (): QuizRunScore[] => [
    runOf([choiceQuestion('好题')]),
    runOf([choiceQuestion('坏题')], {
      delivered: null,
      rawText: '我没有输出 JSON',
      imageReport: { ...emptyQuizImageReport(false), failure: 'parse' },
      aiMixReport: { requested: MIX, actual: { ...MIX, single: 0 }, matched: true },
    }),
  ];

  it('成功率 1/2、一次成型率 1/2、满配率的分母是「有交付的组」＝1', () => {
    const sum = summarizeRuns(twoRuns());
    expect(sum.success).toEqual({ n: 1, d: 2 });
    expect(sum.firstParse).toEqual({ n: 1, d: 2 });
    expect(sum.matched).toEqual({ n: 1, d: 1 });
    expect(sum.questionDelivery).toEqual({ n: 1, d: 2 });
    expect(sum.byGrade.failed).toBe(1);
  });

  it('逐题型请求数来自配比、不是来自实收（否则「少出」永远量不出来）', () => {
    const sum = summarizeRuns([
      runOf([choiceQuestion('题干')], { mix: { ...MIX, single: 3 }, delivered: payloadOf([choiceQuestion('题干')]) }),
    ]);
    expect(sum.byType.single.requested).toBe(3);
    expect(sum.byType.single.delivered).toBe(1);
    expect(sum.byType.judge.requested).toBe(0);
  });

  it('传输失败单独计数，不混进「模型答得差」', () => {
    const sum = summarizeRuns([runOf([choiceQuestion('题干')], { rawText: '', delivered: null, transportError: '429' })]);
    expect(sum.transportErrors).toBe(1);
    expect(sum.byGrade.failed).toBe(1);
  });

  it('延迟 p50/p95/max 取实测值，空输入时给 null 而不是 0', () => {
    const sum = summarizeRuns([runOf([choiceQuestion('a')], { latencyMs: 100 }), runOf([choiceQuestion('b')], { latencyMs: 300 })]);
    expect(sum.latencyMs).not.toBe(null);
    expect(sum.latencyMs?.max).toBe(300);
    expect(summarizeRuns([]).latencyMs).toBe(null);
  });
});
