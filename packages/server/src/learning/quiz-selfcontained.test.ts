import { describe, expect, it, vi } from 'vitest';
import { emptyQuizCompletenessReport, stemOf, type QuizPayload, type QuizQuestion } from '@sb/shared';
import { enforceSelfContained, foldMaterial, parseRepairPlan, type RepairFix } from './quiz-selfcontained.js';

const q = (over: Partial<QuizQuestion>): QuizQuestion => ({ type: 'single', question: '光合作用的场所是（　）', options: ['叶绿体', '线粒体'], answer: [0], ...over });
const pay = (...questions: QuizQuestion[]): QuizPayload => ({ title: 't', questions });
const PASSAGE = '一八七二年，李鸿章在奏折中写道：“今日之事，实为三千年未有之变局。”洋务运动由此展开，先办军工，后办民用企业。';
const HEADLESS = q({ question: '阅读材料可知，洋务运动的目的是（　）' });
const FINE = q({});
const noImage = { find: (async () => ({ images: [], tried: 0 })) as never };

describe('enforceSelfContained', () => {
  it('整组干净：零调用、原样返回', async () => {
    const repair = vi.fn();
    const out = await enforceSelfContained(pay(FINE), { ownerId: null, allowPhoto: true, deps: { repair } });
    expect(repair).not.toHaveBeenCalled();
    expect(out?.questions).toHaveLength(1);
  });

  it('rewrite：补上 material 后放行，选项与答案原样不动，计入 repaired', async () => {
    const report = emptyQuizCompletenessReport();
    const repair = vi.fn(async (): Promise<RepairFix[]> => [{ index: 1, action: 'rewrite', material: PASSAGE, question: '阅读材料可知，洋务运动的目的是（　）' }]);
    const out = await enforceSelfContained(pay(FINE, HEADLESS), { ownerId: null, allowPhoto: false, report, deps: { repair } });
    expect(out?.questions).toHaveLength(2);
    expect(out?.questions[1]?.material).toBe(PASSAGE);
    expect(out?.questions[1]?.options).toEqual(HEADLESS.options);
    expect(out?.questions[1]?.answer).toEqual(HEADLESS.answer);
    expect(report).toMatchObject({ checked: 2, dangling: 1, repaired: 1, dropped: 0 });
  });

  it('模型说「补好了」不算数：改写后题干仍引用图，再审不过 ⇒ 剔除', async () => {
    const report = emptyQuizCompletenessReport();
    const repair = async (): Promise<RepairFix[]> => [{ index: 0, action: 'rewrite', material: PASSAGE, question: '如图所示，作者的态度是（　）' }];
    const out = await enforceSelfContained(pay(HEADLESS, FINE), { ownerId: null, allowPhoto: false, report, deps: { repair } });
    expect(out?.questions).toHaveLength(1);
    expect(report.dropped).toBe(1);
    expect(report.reasons[0]).toContain('仍有悬空引用');
  });

  it('修复调用抛错/返回 null：无头题一律剔除，不放行（与验算失败放行相反）', async () => {
    for (const repair of [async () => null, async () => { throw new Error('boom'); }]) {
      const report = emptyQuizCompletenessReport();
      const out = await enforceSelfContained(pay(FINE, HEADLESS), { ownerId: null, allowPhoto: false, report, deps: { repair } });
      expect(out?.questions).toEqual([FINE]);
      expect(report.dropped).toBe(1);
    }
  });

  it('全剔光 ⇒ null（与配比裁空同一条降级路）', async () => {
    const out = await enforceSelfContained(pay(HEADLESS), { ownerId: null, allowPhoto: false, deps: { repair: async () => [{ index: 0, action: 'drop' }] } });
    expect(out).toBeNull();
  });

  it('image：缺图的题搬来原图并标 essential；找不到图 ⇒ 剔除；缺文段的题不搬图', async () => {
    const figureQ = q({ question: '如图所示，图中②是什么结构（　）' });
    const found = { images: [{ src: '/api/images/x.png', alt: '叶绿体', source: 'commons', pageUrl: 'https://c.test/x', license: 'CC0', author: null, verified: true }], tried: 1 };
    const repair = async (): Promise<RepairFix[]> => [{ index: 0, action: 'image', query: 'chloroplast', subject: '叶绿体' }];
    const ok = await enforceSelfContained(pay(figureQ), { ownerId: null, allowPhoto: true, deps: { repair, find: (async () => found) as never } });
    expect(ok?.questions[0]?.photo).toMatchObject({ src: '/api/images/x.png', essential: true });
    const none = await enforceSelfContained(pay(figureQ), { ownerId: null, allowPhoto: true, deps: { repair, find: noImage.find } });
    expect(none).toBeNull();
    const wrongKind = await enforceSelfContained(pay(HEADLESS), { ownerId: null, allowPhoto: true, deps: { repair: async () => [{ index: 0, action: 'image', query: 'x', subject: 'x' }], find: (async () => found) as never } });
    expect(wrongKind).toBeNull();
  });

  it('allowPhoto=false（对战/开关关）时 image 方案不可用', async () => {
    const find = vi.fn();
    const out = await enforceSelfContained(pay(q({ question: '如图所示，求 x' })), { ownerId: null, allowPhoto: false, deps: { repair: async () => [{ index: 0, action: 'image', query: 'x', subject: 'x' }], find: find as never } });
    expect(out).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
});

describe('parseRepairPlan', () => {
  it('过滤越界/重复 index，残缺 rewrite 降级为 drop', () => {
    const plan = parseRepairPlan('前言{"fixes":[{"index":0,"action":"rewrite","material":"m","question":""},{"index":0,"action":"drop"},{"index":9,"action":"drop"},{"index":1,"action":"image","query":"q"}]}', 2);
    expect(plan).toEqual([{ index: 0, action: 'drop' }, { index: 1, action: 'image', query: 'q', subject: 'q' }]);
  });
  it('非 JSON ⇒ null', () => expect(parseRepairPlan('没有', 2)).toBeNull());
});

describe('foldMaterial / stemOf', () => {
  it('材料折进题干、删掉 material；无 material 的题原样', () => {
    const folded = foldMaterial(pay(q({ question: '问什么', material: PASSAGE }), FINE));
    expect(folded.questions[0]?.material).toBeUndefined();
    expect(folded.questions[0]?.question).toBe(stemOf({ question: '问什么', material: PASSAGE }));
    expect(folded.questions[0]?.question).toContain(PASSAGE);
    expect(folded.questions[1]).toEqual(FINE);
  });
  it('stemOf 没有 material 时就是题干本身', () => expect(stemOf({ question: 'a' })).toBe('a'));
});
