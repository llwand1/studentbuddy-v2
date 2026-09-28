/**
 * shared/spell-chant.test — 魔法吟唱的口径锁（契约 `docs/SPELL-CHANT-SPEC.md`）。
 *
 * ★ 锁的是三件事：① **切节的次序与形状**（一条提问只配它后面第一条 AI 消息；题卡只收可判分的四型并封顶）；
 *   ② **相似度与阈值**（同义改写要过、无关句不过、长句阈值要降）；③ **数值由学习行为解释**
 *   （威力 = 命中数、共鸣 ×2、脏值不打出负伤害）。遮罩另锁「确定性 + 至少遮一个字」——
 *   遮得每次不一样，用户刷新几次就能拼出整句，那就不是回忆了。
 */
import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from './content-blocks.js';
import {
  SPELL_MASK_CHAR,
  SPELL_MAX_QUIZ_PER_CARD,
  SPELL_MAX_VERSES,
  SPELL_RESONANCE_MULTIPLIER,
  SPELL_THRESHOLD_MAX,
  SPELL_THRESHOLD_MIN,
  buildChantVerses,
  chantPower,
  chantable,
  echoOf,
  maskPrompt,
  promptSimilarity,
  resonanceThreshold,
  resonates,
  spellDamage,
  spellResonates,
  type ChantTurn,
} from './spell-chant.js';

const single: QuizQuestion = { type: 'single', question: '闭包捕获的是什么？', options: ['值', '词法环境', '线程', '文件'], answer: [1] };
const judge: QuizQuestion = { type: 'judge', question: '闭包会延长变量生命周期', answer: [0] };
const fill: QuizQuestion = { type: 'fill', question: '函数与其词法环境的组合叫 ____', answer: ['闭包'] };
const essay: QuizQuestion = { type: 'essay', question: '谈谈闭包的内存影响', answer: '要点' };

describe('chantable：哪些题能进吟唱', () => {
  it('单选 / 判断 / 填空可进，解答题不进', () => {
    expect(chantable(single)).toBe(true);
    expect(chantable(judge)).toBe(true);
    expect(chantable(fill)).toBe(true);
    expect(chantable(essay)).toBe(false);
  });

  it('答案形状不完整的题不进（下标越界 / 填空无答案 / 题干为空）', () => {
    expect(chantable({ ...single, answer: [9] })).toBe(false);
    expect(chantable({ ...fill, answer: [] })).toBe(false);
    expect(chantable({ ...fill, answer: '' })).toBe(false);
    expect(chantable({ ...single, question: '  ' })).toBe(false);
    expect(chantable({ type: 'multiple', question: 'x', options: ['a'], answer: [0] })).toBe(false);
  });
});

describe('buildChantVerses：把对话切成节', () => {
  const turns: ChantTurn[] = [
    { role: 'user', content: '什么是闭包？' },
    { role: 'assistant', content: '**闭包**是函数与它所引用的词法环境的组合。\n\n```js\nfunction f(){}\n```' },
    { role: 'user', content: '考我几道' },
    { role: 'assistant', content: '', quiz: [single, essay, judge, fill, { ...single, question: '第五题' }], quizTitle: '闭包小测' },
    { role: 'assistant', content: '做得不错。' },
    { role: 'user', content: '   ' },
    { role: 'user', content: '最后一问' },
  ];

  it('提问 → 复述节（配后面第一条 AI 消息），题卡 → 逐题成节且只收可判分的、封顶 3 题', () => {
    const { verses, truncated } = buildChantVerses(turns);
    expect(truncated).toBe(0);
    expect(verses.map((v) => v.kind)).toEqual(['recall', 'recall', 'quiz', 'quiz', 'quiz', 'recall']);
    const first = verses[0];
    if (first?.kind !== 'recall') throw new Error('首节应为复述');
    expect(first.prompt).toBe('什么是闭包？');
    // 回响去掉了 Markdown 记号与代码围栏
    expect(first.echo).toBe('闭包是函数与它所引用的词法环境的组合。');
    const second = verses[1];
    if (second?.kind !== 'recall') throw new Error('第二节应为复述');
    expect(second.echo).toBe('出了一组题：闭包小测');
    const quizzes = verses.filter((v) => v.kind === 'quiz');
    expect(quizzes).toHaveLength(SPELL_MAX_QUIZ_PER_CARD);
    expect(quizzes.every((v) => v.kind === 'quiz' && v.question.type !== 'essay')).toBe(true);
    // 末尾提问没有回答：仍成节、回响为空（UI 说「没有留下回响」）
    const last = verses[verses.length - 1];
    if (last?.kind !== 'recall') throw new Error('末节应为复述');
    expect(last.prompt).toBe('最后一问');
    expect(last.echo).toBe('');
  });

  it('超过上限只取前 N 节并如实报截掉几节；空对话 0 节', () => {
    const many: ChantTurn[] = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({ role: 'user', content: `第 ${i} 问` }, { role: 'assistant', content: `第 ${i} 答` });
    }
    const plan = buildChantVerses(many);
    expect(plan.verses).toHaveLength(SPELL_MAX_VERSES);
    expect(plan.truncated).toBe(12 - SPELL_MAX_VERSES);
    expect(buildChantVerses([]).verses).toEqual([]);
    expect(buildChantVerses([{ role: 'assistant', content: '独白' }]).verses).toEqual([]);
  });

  it('echoOf 剥登记块与围栏并截断', () => {
    expect(echoOf('[QUIZ]{"questions":[]}[/QUIZ] 题在上面')).toBe('题在上面');
    const long = '字'.repeat(200);
    const echo = echoOf(long, 10);
    expect([...echo]).toHaveLength(11);
    expect(echo.endsWith('…')).toBe(true);
  });
});

describe('promptSimilarity / resonanceThreshold：复述过不过关', () => {
  it('同句 1、空句 0、改写过关、无关句不过', () => {
    expect(promptSimilarity('什么是闭包？', '什么是闭包')).toBe(1);
    expect(promptSimilarity('', '什么是闭包')).toBe(0);
    expect(promptSimilarity('什么是闭包', '')).toBe(0);
    expect(resonates('什么是傅里叶变换？', '傅里叶变换是什么')).toBe(true);
    expect(resonates('什么是傅里叶变换？', '今天晚饭吃什么')).toBe(false);
    // 大小写 / 全角半角 / 空白不影响
    expect(promptSimilarity('What is a Closure?', 'what is a closure')).toBe(1);
  });

  it('阈值随原句长度线性递减且有界', () => {
    expect(resonanceThreshold(0)).toBe(SPELL_THRESHOLD_MAX);
    expect(resonanceThreshold(20)).toBe(SPELL_THRESHOLD_MAX);
    expect(resonanceThreshold(60)).toBe(SPELL_THRESHOLD_MIN);
    expect(resonanceThreshold(999)).toBe(SPELL_THRESHOLD_MIN);
    const mid = resonanceThreshold(40);
    expect(mid).toBeCloseTo((SPELL_THRESHOLD_MAX + SPELL_THRESHOLD_MIN) / 2, 6);
    expect(resonanceThreshold(30)).toBeGreaterThan(resonanceThreshold(50));
    expect(resonanceThreshold(Number.NaN)).toBe(SPELL_THRESHOLD_MAX);
  });

  it('单字凑不出二元组时只认相等', () => {
    expect(promptSimilarity('好', '好')).toBe(1);
    expect(promptSimilarity('好', '好的')).toBe(0);
  });
});

describe('maskPrompt：遮罩确定且至少遮一字', () => {
  it('同输入同输出、长度不变、首字必露、标点保留、约三分之一露出', () => {
    const p = '为什么傅里叶变换可以把时域信号变成频域？';
    const a = maskPrompt(p, 'seed-1');
    expect(maskPrompt(p, 'seed-1')).toBe(a);
    expect([...a]).toHaveLength([...p].length);
    expect(a[0]).toBe('为');
    expect(a.endsWith('？')).toBe(true);
    const letters = [...p].filter((c) => c !== '？').length;
    const shown = [...a].filter((c) => c !== SPELL_MASK_CHAR && c !== '？').length;
    expect(shown / letters).toBeGreaterThan(0.15);
    expect(shown / letters).toBeLessThan(0.6);
    // 换 seed 遮的位置不同（不是写死的固定位）
    expect(maskPrompt(p, 'seed-2')).not.toBe(a);
  });

  it('两字句也至少遮住一个字；空串原样', () => {
    expect(maskPrompt('闭包', 's')).toBe(`闭${SPELL_MASK_CHAR}`);
    expect(maskPrompt('', 's')).toBe('');
    expect(maskPrompt('？', 's')).toBe('？');
  });
});

describe('威力 / 伤害 / 共鸣：数值由学习行为解释', () => {
  it('威力 = 命中数；伤害 = 威力 ×（共鸣 ? 2 : 1）；脏值不打出负伤害', () => {
    expect(chantPower(['hit', 'miss', 'hit'])).toBe(2);
    expect(chantPower([])).toBe(0);
    expect(spellDamage(3, false)).toBe(3);
    expect(spellDamage(3, true)).toBe(3 * SPELL_RESONANCE_MULTIPLIER);
    expect(spellDamage(0, true)).toBe(0);
    expect(spellDamage(-2, true)).toBe(0);
    expect(spellDamage(Number.NaN, false)).toBe(0);
  });

  it('共鸣 = 任一消息正文含词条名（归一后比）；空词条恒不共鸣', () => {
    expect(spellResonates(['先讲讲 Closure 的定义', '再来两道题'], 'closure')).toBe(true);
    expect(spellResonates(['傅里叶变换很有意思'], '闭包')).toBe(false);
    expect(spellResonates(['闭包'], '  ')).toBe(false);
    expect(spellResonates([], '闭包')).toBe(false);
  });
});
