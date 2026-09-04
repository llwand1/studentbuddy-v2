/**
 * answer-style — 「你喜欢我怎么答」的四维偏好（契约 docs/ANSWER-STYLE-SPEC.md §1）。
 *
 * 本文件是**唯一事实源**：前端渲染选项卡、服务端拼提示词、设置摘要都读这里，两处不各写一份
 * （根治 v1 前后端文案双写漂移）。
 *
 * ★ 默认值必须等于引入本功能之前的行为：四维全取默认时，出站指令段只是把原话重述一遍，
 *   AI 口吻不得有任何漂移（锁在 answer-style.test.ts 的默认值断言里）。
 */

export type StyleVerbosity = 'brief' | 'standard' | 'detailed';
export type StyleTone = 'peer' | 'teacher' | 'socratic';
export type StyleSupport = 'none' | 'life' | 'worked';
export type StyleShape = 'prose' | 'bullets' | 'mixed';

export interface AnswerStyle {
  verbosity: StyleVerbosity;
  tone: StyleTone;
  support: StyleSupport;
  shape: StyleShape;
}

/** 设置键（落 app_settings，与 quiz_mix / quiz_image 同级） */
export const SETTING_KEY_ANSWER_STYLE = 'answer_style';

/** 默认 = 现状行为（适中长度 · 讲人话的老师 · 不主动举例 · 整段叙述） */
export const DEFAULT_ANSWER_STYLE: AnswerStyle = {
  verbosity: 'standard',
  tone: 'teacher',
  support: 'none',
  shape: 'prose',
};

/** 指令段的适用场景：对话回答 / 出题（出题侧多一句「别动协议字段」的护栏） */
export type StyleTarget = 'answer' | 'quiz';

interface StyleOption {
  value: string;
  label: string;
  hint: string;
  /** 拼给模型的指令句——每档一句专属措辞，不写成「按偏好回答」这种含糊话（含糊等于没生效） */
  line: string;
}

interface StyleField {
  key: keyof AnswerStyle;
  question: string;
  options: StyleOption[];
}

/** 选项文案与指令措辞的单一来源：卡片按此渲染，提示词按此拼装 */
export const ANSWER_STYLE_FIELDS: StyleField[] = [
  {
    key: 'verbosity',
    question: '回答要多详细？',
    options: [
      { value: 'brief', label: '简短', hint: '三两句给结论', line: '回答控制在两三句内，只给结论和最关键的一条理由，细节等追问再展开。' },
      { value: 'standard', label: '适中', hint: '结论 + 关键步骤', line: '结论先行，再补关键步骤或理由，整体不超过三段。' },
      { value: 'detailed', label: '详细', hint: '分步讲透，宁长勿短', line: '分步讲透：定义、推导过程、边界条件和易错点都写出来，宁长勿短。' },
    ],
  },
  {
    key: 'tone',
    question: '喜欢什么口吻？',
    options: [
      { value: 'peer', label: '像同学', hint: '大白话、少术语', line: '用同学口吻：大白话优先，必须用术语时紧跟一句白话解释。' },
      { value: 'teacher', label: '像老师', hint: '术语准确、仍讲人话', line: '用老师口吻：术语准确、该给定义就给定义，同时讲人话不端架子。' },
      { value: 'socratic', label: '引导式', hint: '先反问，你自己想一步', line: '引导式：先反问一两个关键问题让学习者自己想一步，再给出答案与理由。' },
    ],
  },
  {
    key: 'support',
    question: '要不要举例子？',
    options: [
      { value: 'none', label: '不用', hint: '就说正题', line: '不主动举例，直接讲正题；对方要例子时再给。' },
      { value: 'life', label: '生活例子', hint: '熟悉场景类比', line: '每个核心概念配一个生活化的熟悉场景类比。' },
      { value: 'worked', label: '学科例题', hint: '带数字的算例', line: '每个核心概念配一道学科内的小例题，带具体数字算一遍。' },
    ],
  },
  {
    key: 'shape',
    question: '排版怎么排？',
    options: [
      { value: 'prose', label: '整段叙述', hint: '像文章那样连写', line: '以整段叙述为主，不强行拆成列表。' },
      { value: 'bullets', label: '列点为主', hint: '能列就列', line: '多用短列点，能列就列，避免长段落。' },
      { value: 'mixed', label: '混合', hint: '短段 + 表或清单', line: '短段落叙述，凡是并列项、对比项、步骤改用清单或表格呈现。' },
    ],
  },
];

/** 逐字段白名单归一：非法/缺失/非对象都回落该字段默认值，绝不整体丢弃、绝不抛错 */
export function normalizeAnswerStyle(raw: unknown): AnswerStyle {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AnswerStyle = { ...DEFAULT_ANSWER_STYLE };
  for (const field of ANSWER_STYLE_FIELDS) {
    const v = src[field.key];
    // 只认白名单里的 value：不在列表里就保留默认值（而不是整个偏好作废）
    if (typeof v === 'string' && field.options.some((o) => o.value === v)) {
      Object.assign(out, { [field.key]: v });
    }
  }
  return out;
}

/** 一行摘要（设置卡与出题按钮旁共用）：适中 · 像老师 · 不举例 · 整段 */
export function styleSummary(style: AnswerStyle): string {
  return ANSWER_STYLE_FIELDS.map((field) => {
    const picked = field.options.find((o) => o.value === style[field.key]);
    return picked ? picked.label : '?';
  }).join(' · ');
}

/**
 * 拼给模型的指令段。逐维各一句，措辞取自 ANSWER_STYLE_FIELDS（改文案即改行为，不分两处写）。
 * 只影响**表达**：不动协议字段、不动题型配比、不动配图契约。
 */
export function buildAnswerStyleBlock(style: AnswerStyle, target: StyleTarget = 'answer'): string {
  const lines = ANSWER_STYLE_FIELDS.map((field) => {
    const picked = field.options.find((o) => o.value === style[field.key]);
    return picked ? picked.line : '';
  }).filter(Boolean);
  const scope =
    target === 'quiz'
      ? // 两根斜杠那句是实测补上的：详细档解析长、LaTeX 多，模型漏写第二根就变成非法 JSON 转义
        // （quiz-json-repair 会兜底，但少错一次比多修一次好）；源码里 \\\\ 才是发给模型的两根
        '以下只是表达偏好，只影响题干与解析的写法；[QUIZ] 的字段格式、题型配比、配图要求一概照旧，不得因此改动。解析里写公式时，字符串内的反斜杠必须写成两根（如 \\\\sin），整套题必须一次写完。'
      : '以下只是表达偏好，不改变回答的事实内容与准确性。';
  return `${scope}\n${lines.join('\n')}`;
}
