/**
 * choice 契约纯函数测试（方案选择框，docs/ASK-CHOICE-SPEC.md §2）。
 *
 * 这些边界是**前后端共用的唯一一份规则**：归一在 shared 做，服务端只落库、前端只渲染。
 * 故此处把边界钉死，任何一侧想放宽都得先改这里。
 */
import { describe, expect, it } from 'vitest';
import {
  CHOICE_CUSTOM_MAX,
  CHOICE_DESC_MAX,
  CHOICE_LABEL_MAX,
  CHOICE_MAX_OPTIONS,
  CHOICE_MIN_OPTIONS,
  CHOICE_QUESTION_MAX,
  choiceOptionId,
  describeChoiceReply,
  normalizeChoiceInput,
  normalizeChoiceReply,
} from './choice.js';

const baseInput = { question: '这次怎么复习？', options: [{ label: '先补基础' }, { label: '直接刷题' }] };

describe('normalizeChoiceInput', () => {
  it('最小合法输入通过；选项 id 由服务端重排（外部传入的 id 一律忽略）', () => {
    const r = normalizeChoiceInput({
      ...baseInput,
      options: [{ label: '  先补基础  ', id: 'hack' }, { label: '直接刷题' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(r.options[0]?.label).toBe('先补基础'); // label 去首尾空白
    expect(r.question).toBe('这次怎么复习？');
  });

  it('两个默认值：allowCustom 默认开（选择题不该把答案框死）、multi 默认关', () => {
    const r = normalizeChoiceInput(baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allowCustom).toBe(true);
    expect(r.multi).toBe(false);
  });

  it('显式 allowCustom=false 生效（AI 可以明确不给自由输入出口）', () => {
    const r = normalizeChoiceInput({ ...baseInput, allowCustom: false });
    expect(r.ok && r.allowCustom).toBe(false);
  });

  it('description 缺省/空白时不落字段（不留空键，序列化与前端判空都干净）', () => {
    const r = normalizeChoiceInput({ ...baseInput, options: [{ label: 'A', description: '   ' }, { label: 'B' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('description' in (r.options[0] ?? {})).toBe(false);
  });

  it('question 空/纯空白/超长 → 拒绝', () => {
    expect(normalizeChoiceInput({ ...baseInput, question: '' }).ok).toBe(false);
    expect(normalizeChoiceInput({ ...baseInput, question: '   ' }).ok).toBe(false);
    expect(normalizeChoiceInput({ ...baseInput, question: 'x'.repeat(CHOICE_QUESTION_MAX + 1) }).ok).toBe(false);
  });

  it(`选项少于 ${CHOICE_MIN_OPTIONS} 个或多于 ${CHOICE_MAX_OPTIONS} 个 → 拒绝`, () => {
    expect(normalizeChoiceInput({ ...baseInput, options: [{ label: '只有一项' }] }).ok).toBe(false);
    const tooMany = Array.from({ length: CHOICE_MAX_OPTIONS + 1 }, (_, i) => ({ label: `方案${i}` }));
    expect(normalizeChoiceInput({ ...baseInput, options: tooMany }).ok).toBe(false);
  });

  it('选项缺 label / label 超长 / description 超长 → 拒绝', () => {
    expect(normalizeChoiceInput({ ...baseInput, options: [{ label: '' }, { label: 'B' }] }).ok).toBe(false);
    expect(
      normalizeChoiceInput({ ...baseInput, options: [{ label: 'x'.repeat(CHOICE_LABEL_MAX + 1) }, { label: 'B' }] }).ok,
    ).toBe(false);
    expect(
      normalizeChoiceInput({
        ...baseInput,
        options: [{ label: 'A', description: 'x'.repeat(CHOICE_DESC_MAX + 1) }, { label: 'B' }],
      }).ok,
    ).toBe(false);
  });

  it('options 不是数组（模型给了字符串/对象）→ 按 0 个处理并拒绝，不抛异常', () => {
    expect(normalizeChoiceInput({ ...baseInput, options: '先补基础,直接刷题' }).ok).toBe(false);
    expect(normalizeChoiceInput({ ...baseInput, options: { 0: { label: 'A' } } }).ok).toBe(false);
  });

  it('返回 {ok:false,error} 而非抛异常——调用方要把它当可回灌文本交给模型自纠', () => {
    const r = normalizeChoiceInput({ question: '', options: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });
});

describe('normalizeChoiceReply', () => {
  const req = {
    options: [
      { id: 'o1', label: 'A' },
      { id: 'o2', label: 'B' },
    ],
    allowCustom: true,
  };

  it('选中合法 optionId → 通过，不带 custom', () => {
    const r = normalizeChoiceReply({ optionId: 'o2' }, req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.optionId).toBe('o2');
    expect(r.custom).toBeUndefined();
  });

  it('optionId 不属于本条提问 → 拒绝（防止跨题串答）', () => {
    expect(normalizeChoiceReply({ optionId: 'o9' }, req).ok).toBe(false);
  });

  it('optionId 与 custom 都不给 / 都是空串 → 拒绝', () => {
    expect(normalizeChoiceReply({}, req).ok).toBe(false);
    expect(normalizeChoiceReply({ optionId: '', custom: '   ' }, req).ok).toBe(false);
  });

  it('本条未开放自由输入时给 custom → 拒绝', () => {
    expect(normalizeChoiceReply({ custom: '我自己的想法' }, { ...req, allowCustom: false }).ok).toBe(false);
  });

  it('custom 超长 → 拒绝', () => {
    expect(normalizeChoiceReply({ custom: 'x'.repeat(CHOICE_CUSTOM_MAX + 1) }, req).ok).toBe(false);
  });

  it('custom 与 optionId 同时给 → optionId 归 null（互斥，不留歧义记录）', () => {
    const r = normalizeChoiceReply({ optionId: 'o1', custom: '两者都给' }, req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.optionId).toBeNull();
    expect(r.custom).toBe('两者都给');
  });
});

describe('describeChoiceReply（给 AI 读的一行文本）', () => {
  const options = [
    { id: 'o1', label: '先补基础' },
    { id: 'o2', label: '直接刷题' },
  ];

  it('选选项 → 「用户选择：<label>」', () => {
    expect(describeChoiceReply({ requestId: 'r', optionId: 'o1', ts: 0 }, options)).toBe('用户选择：先补基础');
  });

  it('自由输入 → 「用户自定义答复：…」', () => {
    expect(describeChoiceReply({ requestId: 'r', optionId: null, custom: '先看错题', ts: 0 }, options)).toBe(
      '用户自定义答复：先看错题',
    );
  });

  it('选项已失效（回复对不上任何选项、也没有 custom）→ 兜底文案，不抛', () => {
    expect(describeChoiceReply({ requestId: 'r', optionId: 'o9', ts: 0 }, options)).toBe('用户已答复（选项已失效）');
  });
});

describe('choiceOptionId', () => {
  it('1 基编号（o1/o2/o3…）', () => {
    expect(choiceOptionId(0)).toBe('o1');
    expect(choiceOptionId(3)).toBe('o4');
  });
});
