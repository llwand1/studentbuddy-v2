import { describe, expect, it } from 'vitest';
import {
  frozenDetect, parseJudgement, pickAgrees, summarizeArm, renderCompleteSummary, ratio,
  type EvalCard, type GenRecord, type JudgedCard, type Need, type Judgement,
} from './complete-eval-metrics.js';

const card = (over: Partial<EvalCard> = {}): EvalCard => ({ type: 'single', question: '光合作用的场所是（　）', options: ['叶绿体', '线粒体'], answer: [0], hasFigure: false, ...over });
const j = (over: Partial<Judgement> = {}): Judgement => ({ selfContained: true, missing: 'none', reason: '', pick: [0], ...over });

describe('frozenDetect —— 冻结版悬空检测（与产品检测器分开维护）', () => {
  it('引用了、卡上没有 ⇒ 悬空', () => {
    expect(frozenDetect(card({ question: '阅读材料可知，作者的态度是（　）' }))).toBe(true);
    expect(frozenDetect(card({ question: '如图所示，求 x' }))).toBe(true);
    expect(frozenDetect(card({ question: '根据下表，占比最大的是' }))).toBe(true);
  });
  it('material / 图在场 ⇒ 不算悬空', () => {
    expect(frozenDetect(card({ question: '阅读材料可知……', material: '一八七二年，李鸿章写道……洋务运动展开' }))).toBe(false);
    expect(frozenDetect(card({ question: '如图所示，求 x', hasFigure: true }))).toBe(false);
  });
  it('题干内联足够长的材料 ⇒ 不算悬空', () => {
    const long = '我看见他戴着黑布小帽，穿着黑布大马褂，深青布棉袍，蹒跚地走到铁道边，慢慢探身下去，尚不大难。可是他穿过铁道，要爬上那边月台，就不容易了。';
    expect(frozenDetect(card({ question: `${long}\n根据上述材料，作者写了什么？` }))).toBe(false);
  });
  it('无引用的概念题 ⇒ 不算', () => expect(frozenDetect(card())).toBe(false));
});

describe('parseJudgement', () => {
  it('解析自包含/缺失类别/盲解（字母或下标），越界丢弃', () => {
    expect(parseJudgement('{"self_contained":true,"missing":"none","reason":"ok","pick":"B"}', 4)).toMatchObject({ selfContained: true, pick: [1] });
    expect(parseJudgement('{"self_contained":false,"missing":"figure","reason":"缺图","pick":null}', 4)).toMatchObject({ selfContained: false, missing: 'figure', pick: null });
    expect(parseJudgement('{"self_contained":true,"pick":["A","D","Z"]}', 3)?.pick).toEqual([0]);
  });
  it('自相矛盾时以 self_contained 为准（不自包含却说 none ⇒ other）', () => {
    expect(parseJudgement('{"self_contained":false,"missing":"none"}', 2)?.missing).toBe('other');
    expect(parseJudgement('{"self_contained":true,"missing":"figure"}', 2)?.missing).toBe('none');
  });
  it('非 JSON / 缺字段 ⇒ null', () => {
    expect(parseJudgement('无法判断', 2)).toBeNull();
    expect(parseJudgement('{"missing":"none"}', 2)).toBeNull();
  });
});

describe('pickAgrees', () => {
  it('集合相等才算一致；没作答 ⇒ 不一致', () => {
    expect(pickAgrees(j({ pick: [0, 2] }), [2, 0])).toBe(true);
    expect(pickAgrees(j({ pick: [0] }), [0, 2])).toBe(false);
    expect(pickAgrees(j({ pick: null }), [0])).toBe(false);
  });
});

describe('summarizeArm', () => {
  const needs: Record<string, Need> = { A: 'passage', B: 'figure', C: 'none' };
  const rec = (caseId: string, over: Partial<GenRecord> = {}): GenRecord => ({ caseId, channel: 'gen', latencyMs: 1000, promptTokens: 100, completionTokens: 50, droppedByProduct: null, cards: [], ...over });
  const row = (caseId: string, c: EvalCard, judged: Judgement | null, over: Partial<JudgedCard> = {}): JudgedCard => ({ caseId, channel: 'gen', need: needs[caseId]!, card: c, judged, frozenDangling: false, ...over });

  it('自包含率、可用 case、盲解一致率只在自包含选择题上算；评审失败留在分母外但单列', () => {
    const rows = [
      row('A', card(), j()),
      row('A', card({ question: '阅读材料可知' }), j({ selfContained: false, missing: 'passage', pick: null }), { frozenDangling: true }),
      row('B', card({ hasFigure: true }), j({ pick: [1] })),
      row('C', card(), null),
    ];
    const s = summarizeArm([rec('A'), rec('B'), rec('C')], rows, (id) => needs[id]!);
    expect(s.delivered).toBe(4);
    expect(s.judgeFailures).toBe(1);
    expect(s.selfContained).toEqual(ratio(2, 3));
    expect(s.frozenDangling).toEqual(ratio(1, 4));
    expect(s.casesUsable).toEqual(ratio(2, 3));
    expect(s.blindAgree).toEqual(ratio(1, 2)); // A 的一致，B 的盲解选了 B 但标答是 A
    expect(s.figureAttached).toEqual(ratio(1, 1));
    expect(s.missingBy.passage).toBe(1);
    expect(s.usablePerCase).toBeCloseTo(2 / 3);
  });

  it('搜集：产品放行 ok:false 的候选不算交付，单列为 rejected', () => {
    const rows = [
      row('A', card({ ok: true }), j(), { channel: 'collect' }),
      row('A', card({ ok: false, reason: '依赖图' }), null, { channel: 'collect' }),
    ];
    const s = summarizeArm([rec('A', { channel: 'collect' })], rows, (id) => needs[id]!);
    expect(s.delivered).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.judgeFailures).toBe(0);
  });

  it('对照组误杀：基线无自报数据 ⇒ 无分母（不写 0%）；本分支有 ⇒ 剔除/(交付+剔除)', () => {
    const rows = [row('C', card(), j())];
    const base = summarizeArm([rec('C')], rows, (id) => needs[id]!);
    expect(base.controlDropped).toEqual(ratio(0, 0));
    const fix = summarizeArm([rec('C', { droppedByProduct: 1 })], rows, (id) => needs[id]!);
    expect(fix.controlDropped).toEqual(ratio(1, 2));
  });

  it('零交付：比率无分母，不是 0%；用量缺失 ⇒ null', () => {
    const s = summarizeArm([rec('A', { promptTokens: null, completionTokens: null, error: 'x' })], [], (id) => needs[id]!);
    expect(s.selfContained.d).toBe(0);
    expect(s.tokensPerUsable).toBeNull();
    expect(s.promptTokens).toBeNull();
    expect(s.errors).toBe(1);
  });
});

describe('renderCompleteSummary', () => {
  it('分母为 0 渲染「—（无分母）」而不是 0%', () => {
    const empty = summarizeArm([], [], () => 'none');
    const md = renderCompleteSummary({ gen: empty, collect: empty }, { gen: empty, collect: empty }, { n: 0, selfContained: ratio(0, 0), blindAgree: ratio(0, 0), fromWeb: 0, composed: 0 }, {
      date: '2026-09-29', model: 'm', judgeModel: 'j', judgeVision: false, dataset: 'complete-v1', baseSha: 'a', fixSha: 'b', replay: true,
    });
    expect(md).toContain('—（无分母）');
    expect(md).not.toContain('0.0%');
    expect(md).toContain('仅文字评审');
  });
});
