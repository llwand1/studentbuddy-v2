import { describe, it, expect } from 'vitest';
import { emptyQuizImageReport, countQuizImages } from '@sb/shared';
import { repairJsonBrackets, repairJsonEscapes } from './quiz-json-repair.js';
import { parseQuizBlock } from './quiz.js';

/**
 * 真机复验（2026-09-04，probe6-机械波.txt）抓到的原始缺陷，删了无关文字、保留形状：
 * 模型 finish=stop、输出完整，但两处 `"options":[…,"answer":[0]` 漏了数组收尾的 `]`，
 * 三道题全好着却整组 502。
 */
const BROKEN = `{"title":"简谐横波传播与振动方程分析","questions":[{"type":"single","question":"该波的周期为？","options":["A. 0.5 s","B. 2 s","C. 4 s","D. 8 s","answer":[0],"explanation":"T=λ/v=0.5 s","svg":"<svg viewBox='0 0 120 90'><path d='M 20 45 Q 35 15 50 45 T 80 45' fill='none' stroke='#555'/></svg>"},{"type":"single","question":"x=1 m 处质点的振动速度方向为？","options":["A. 沿 y 轴正方向","B. 沿 y 轴负方向","C. 为零","D. 无法确定","answer":[1],"explanation":"上坡下、下坡上。","svg":""},{"type":"fill","question":"该波的周期 T=____ s。","answer":["0.5"],"explanation":"由 T=λ/v。","svg":""}]}`;

describe('learning/quiz-json-repair — 漏括号无损修复', () => {
  it('合法 JSON 一个字不动：选项文字里的「3:1」不误伤', () => {
    const src = '{"options":["A. 比例 3:1","B. 比例 2:1"],"answer":[0]}';
    const r = repairJsonBrackets(src);
    expect(r.fixed).toBe(0);
    expect(r.text).toBe(src);
  });

  it('合法 JSON：数组套对象时，对象里的键值冒号不误伤', () => {
    const src = '{"rows":[{"a":1},{"a":2}],"answer":[0]}';
    expect(repairJsonBrackets(src).fixed).toBe(0);
  });

  it('★ 真机样本：两处漏括号都补上，补完是合法 JSON 且题/图原样保留', () => {
    const r = repairJsonBrackets(BROKEN);
    expect(r.fixed).toBe(2);
    const back = JSON.parse(r.text) as { questions: Array<Record<string, unknown>> };
    expect(back.questions).toHaveLength(3);
    expect(back.questions[0]?.options).toEqual(['A. 0.5 s', 'B. 2 s', 'C. 4 s', 'D. 8 s']);
    expect(back.questions[0]?.answer).toEqual([0]);
    expect(String(back.questions[2]?.svg)).toBe('');
  });

  it('数组没收尾就撞上 }：就地补 ]，让那个 } 去关外层对象', () => {
    const r = repairJsonBrackets('{"options":["A","B"}');
    expect(r.fixed).toBe(1);
    expect(JSON.parse(r.text)).toEqual({ options: ['A', 'B'] });
  });

  it('② 的变体：} 前还有个悬空逗号时，`[` 的收尾把逗号顶掉，不留尾逗号', () => {
    const r = repairJsonBrackets('{"options":["A","B",}');
    expect(r.fixed).toBe(1);
    expect(JSON.parse(r.text)).toEqual({ options: ['A', 'B'] });
  });

  it('★ ① 的 ] 插在分隔逗号之前：补完不能留下 `["a","b",]` 那种尾逗号', () => {
    const r = repairJsonBrackets('{"options":["A","B","answer":[0]}');
    expect(r.text).toBe('{"options":["A","B"],"answer":[0]}');
  });

  it('末尾残缺不乱补：那是逐题回退的活，凭猜编 JSON 会造出错题', () => {
    const src = '{"title":"T","questions":[{"type":"fill","question":"Q1","answer":["a"],"svg":"<svg viewBox=\'0 0 9 9\'><rect';
    expect(repairJsonBrackets(src).fixed).toBe(0);
  });

  it('转义引号不破坏扫描：值里的 \\" 不会被当成字符串结束', () => {
    const src = '{"options":["A. 说\\"甲\\"","B. 说\\"乙\\""],"answer":[1]}';
    expect(repairJsonBrackets(src).fixed).toBe(0);
  });
});

describe('learning/quiz — 漏括号输出经 parseQuizBlock 的端到端', () => {
  it('★ 原来那句 502 现在出 3 题 1 图，且报告零损失（没丢图、没截断）', () => {
    const report = emptyQuizImageReport(true);
    const out = parseQuizBlock(`[QUIZ]${BROKEN}[/QUIZ]`, report);
    expect(out?.questions.map((x) => x.question)).toEqual([
      '该波的周期为？',
      'x=1 m 处质点的振动速度方向为？',
      '该波的周期 T=____ s。',
    ]);
    expect(countQuizImages(out)).toBe(1);
    expect(report).toEqual({ on: true, delivered: 0, droppedSvg: 0, truncated: false });
  });

  it('开关关着时漏括号照样补：修复与配图无关，两件事不能互相拖累', () => {
    const report = emptyQuizImageReport(false);
    const out = parseQuizBlock(`[QUIZ]${BROKEN}[/QUIZ]`, report, false);
    expect(out?.questions).toHaveLength(3);
    expect(countQuizImages(out)).toBe(0);
    expect(report.droppedSvg).toBe(0);
  });
});

/**
 * 真机跑出来的第二种死法（2026-09-04，verify-answer-style/verify-502-cause 两轮）：
 * 回答方式选「详细 + 列点」后解析变长、LaTeX 变多，模型开始漏写第二根斜杠——
 * JSON 里 `\s` 是非法转义 → JSON.parse 抛 → 四道题全在却 502（7 次里 3 次，默认档 6 次 0 次）。
 * 下列样本用 String.raw 写，保持与模型原始输出一样的字符形状。
 */
const LATEX_BROKEN = String.raw`{"title":"全反射临界角","questions":[{"type":"single","question":"光从介质射向空气，临界角满足哪个式子？","options":["A. $\sin C=1/n$","B. $\cos C=1/n$","C. $\tan C=1/n$","D. $\sin C=n$"],"answer":[0],"explanation":"由折射定律 $n_1 \sin\theta_1 = n_2 \sin\theta_2$，令折射角 90° 即得 $\sin C=1/n$；波长变短、频率 $\nu$ 不变。","svg":""}]}`;

describe('learning/quiz-json-repair — 非法转义（LaTeX 漏一根斜杠）无损修复', () => {
  it('合法 JSON 一个字不动：n/t/引号/反斜杠/uXXXX 都是正当转义', () => {
    const src = String.raw`{"a":"换行\n 制表\t 引号\" 杠\\ 重音é"}`;
    const r = repairJsonEscapes(src);
    expect(r.fixed).toBe(0);
    expect(r.text).toBe(src);
  });

  it('★ 真机样本：补完能 parse，且解析出的文字里 \\sin 还在（这题原先直接 502）', () => {
    const r = repairJsonEscapes(LATEX_BROKEN);
    expect(r.fixed).toBeGreaterThan(0);
    const back = JSON.parse(r.text) as { questions: Array<{ explanation: string; options: string[] }> };
    expect(back.questions[0]?.explanation).toContain('\\sin C=1/n');
    expect(back.questions[0]?.options[0]).toBe('A. $\\sin C=1/n$');
  });

  it('逐个点名：首字母不像转义的命令都补得到（unit 的 \\u 后面不是 hex，也算非法）', () => {
    for (const word of ['sin', 'alpha', 'mu', 'mathrm', 'approx', 'unit']) {
      const src = `{"a":"$\\${word} x$"}`;
      const r = repairJsonEscapes(src);
      expect(r.fixed, word).toBe(1);
      expect((JSON.parse(r.text) as { a: string }).a, word).toBe(`$\\${word} x$`);
    }
  });

  it('已知局限（如实钉住，不是漏改）：\\theta / \\nu 撞上合法转义，只能当控制字符过去', () => {
    const r = repairJsonEscapes(String.raw`{"a":"\theta\nu"}`);
    expect(r.fixed).toBe(0); // 不猜：猜就会把真正的制表符/换行也改坏
    expect((JSON.parse(r.text) as { a: string }).a).toBe('\t' + 'heta' + '\n' + 'u'); // 字坏了但题保住了
  });

  it('幂等：修好的文本再过一遍不再动手（不重复加斜杠）', () => {
    const once = repairJsonEscapes(LATEX_BROKEN);
    const twice = repairJsonEscapes(once.text);
    expect(twice.fixed).toBe(0);
    expect(twice.text).toBe(once.text);
  });
});

describe('learning/quiz — 漏转义输出经 parseQuizBlock 的端到端', () => {
  it('★ 原来那句 502 现在出 1 题，选项与解析都还在', () => {
    const out = parseQuizBlock(`[QUIZ]${LATEX_BROKEN}[/QUIZ]`);
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.explanation).toContain('\\sin C=1/n');
    expect(out?.questions[0]?.options).toHaveLength(4);
  });
});
