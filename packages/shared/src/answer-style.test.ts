/**
 * 回答方式偏好契约（docs/ANSWER-STYLE-SPEC.md §1）：卡片文案与提示词措辞的同一份事实源。
 * 核心不变量两条：**默认值等于引入本功能之前的行为**（不设置就不漂），
 * 以及**四维各有一句专属措辞**（写成"按偏好回答"这种含糊话＝假实现，测不出来）。
 */
import { describe, it, expect } from 'vitest';
import {
  ANSWER_STYLE_FIELDS,
  DEFAULT_ANSWER_STYLE,
  SETTING_KEY_ANSWER_STYLE,
  buildAnswerStyleBlock,
  normalizeAnswerStyle,
  styleSummary,
} from './answer-style.js';
import type { AnswerStyle } from './answer-style.js';

const ALL_LINES = ANSWER_STYLE_FIELDS.flatMap((f) => f.options.map((o) => o.line));

describe('ANSWER_STYLE_FIELDS — 卡片与提示词共用一份文案', () => {
  it('正好四道题（对齐宿主问答「一次最多 4 题」的形态），key 不重复', () => {
    expect(ANSWER_STYLE_FIELDS).toHaveLength(4);
    expect(new Set(ANSWER_STYLE_FIELDS.map((f) => f.key)).size).toBe(4);
  });

  it('每题 2~4 个互斥选项，同题内 value 不重复', () => {
    for (const f of ANSWER_STYLE_FIELDS) {
      expect(f.options.length).toBeGreaterThanOrEqual(2);
      expect(f.options.length).toBeLessThanOrEqual(4);
      expect(new Set(f.options.map((o) => o.value)).size).toBe(f.options.length);
    }
  });

  it('题面与 label/hint 都非空，label 短到能进 chip（≤6 字）', () => {
    for (const f of ANSWER_STYLE_FIELDS) {
      expect(f.question.trim().length).toBeGreaterThan(0);
      for (const o of f.options) {
        expect(o.label.trim().length).toBeGreaterThan(0);
        expect(o.label.length).toBeLessThanOrEqual(6);
        expect(o.hint.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('12 句指令措辞两两不同（同题换档必须换话，跨题也不许复用同一句）', () => {
    expect(new Set(ALL_LINES).size).toBe(ALL_LINES.length);
    expect(ALL_LINES.length).toBe(12);
  });

  it('每个选项的 value 都在该字段类型联合的取值内（防文案与类型各跑一头）', () => {
    const domain: Record<keyof AnswerStyle, string[]> = {
      verbosity: ['brief', 'standard', 'detailed'],
      tone: ['peer', 'teacher', 'socratic'],
      support: ['none', 'life', 'worked'],
      shape: ['prose', 'bullets', 'mixed'],
    };
    for (const f of ANSWER_STYLE_FIELDS) {
      for (const o of f.options) expect(domain[f.key]).toContain(o.value);
    }
  });
});

describe('normalizeAnswerStyle — 逐字段回落，绝不整体作废', () => {
  it('null / undefined / 数字 / 数组 / 空串 → 默认值且不抛', () => {
    for (const bad of [null, undefined, 123, 'x', [], {}, ['verbosity']]) {
      expect(normalizeAnswerStyle(bad)).toEqual(DEFAULT_ANSWER_STYLE);
    }
  });

  it('四维都给合法值 → 原样采纳', () => {
    const style = normalizeAnswerStyle({ verbosity: 'brief', tone: 'socratic', support: 'worked', shape: 'bullets' });
    expect(style).toEqual({ verbosity: 'brief', tone: 'socratic', support: 'worked', shape: 'bullets' });
  });

  it('合法 + 非法 + 缺失混在一起 → 合法的进，其余各自保默认（不是整份作废）', () => {
    const style = normalizeAnswerStyle({ verbosity: 'detailed', tone: 'sassy', support: 42 });
    expect(style.verbosity).toBe('detailed');
    expect(style.tone).toBe(DEFAULT_ANSWER_STYLE.tone);
    expect(style.support).toBe(DEFAULT_ANSWER_STYLE.support);
    expect(style.shape).toBe(DEFAULT_ANSWER_STYLE.shape);
  });
});

describe('默认值 = 引入本功能之前的行为（契约 §0 硬约束 2）', () => {
  it('四维默认逐个钉死：改这里＝改所有未设置用户的 AI 口吻，须先批复', () => {
    expect(DEFAULT_ANSWER_STYLE).toEqual({
      verbosity: 'standard',
      tone: 'teacher',
      support: 'none',
      shape: 'prose',
    });
  });

  it('默认指令段只含现状等价口径，不含任何新增的强指令', () => {
    const block = buildAnswerStyleBlock(DEFAULT_ANSWER_STYLE);
    expect(block).toContain('不超过三段'); // 现状「回答简洁好用」
    expect(block).toContain('讲人话'); // 现 SYSTEM_PROMPT 原话
    // 反向锁：这几句属于「用户特意选才该出现」的话，默认段里出现即为口吻漂移
    for (const drift of ['多用短列点', '宁长勿短', '先反问', '生活化', '带具体数字']) {
      expect(block).not.toContain(drift);
    }
  });
});

describe('buildAnswerStyleBlock — 四维真在影响出站提示词', () => {
  it('默认段＝ 1 行护栏 + 4 行指令（一维一句，不少不并）', () => {
    expect(buildAnswerStyleBlock(DEFAULT_ANSWER_STYLE).split('\n')).toHaveLength(5);
  });

  for (const field of ANSWER_STYLE_FIELDS) {
    it(`${field.key} 任换一档，生成的指令段必须随之改变`, () => {
      const base = buildAnswerStyleBlock(DEFAULT_ANSWER_STYLE);
      for (const o of field.options) {
        const next = Object.assign({ ...DEFAULT_ANSWER_STYLE }, { [field.key]: o.value });
        const block = buildAnswerStyleBlock(next);
        expect(block).toContain(o.line);
        if (o.value !== DEFAULT_ANSWER_STYLE[field.key]) expect(block).not.toBe(base);
      }
    });
  }

  it('quiz 场景带协议护栏；对话场景不提 [QUIZ]', () => {
    const quiz = buildAnswerStyleBlock(DEFAULT_ANSWER_STYLE, 'quiz');
    expect(quiz).toContain('[QUIZ]');
    expect(quiz).toContain('题型配比');
    expect(quiz.split('\n')).toHaveLength(5);
    // 实测补上的一条（SPEC §8）：详细档解析里 LaTeX 漏第二根斜杠就会把整组题变成 502
    expect(quiz).toContain('反斜杠必须写成两根');
    expect(buildAnswerStyleBlock(DEFAULT_ANSWER_STYLE, 'answer')).not.toContain('[QUIZ]');
  });
});

describe('styleSummary 与设置键', () => {
  it('摘要是四段 chip 文案，与卡片显示同字', () => {
    expect(styleSummary(DEFAULT_ANSWER_STYLE)).toBe('适中 · 像老师 · 不用 · 整段叙述');
    expect(styleSummary({ verbosity: 'brief', tone: 'peer', support: 'life', shape: 'bullets' })).toBe(
      '简短 · 像同学 · 生活例子 · 列点为主',
    );
  });

  it('设置键落 app_settings，与 quiz_mix / quiz_image 同级', () => {
    expect(SETTING_KEY_ANSWER_STYLE).toBe('answer_style');
  });
});
