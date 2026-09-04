import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb } from '../storage/db.js';
import type { QuizMix, QuizPayload, QuizQuestion } from '@sb/shared';
import {
  DEFAULT_QUIZ_MIX,
  DEFAULT_ANSWER_STYLE,
  MAX_QUIZ_PER_TYPE,
  MAX_QUIZ_TOTAL,
  normalizeQuizMix,
  mixTotal,
  emptyQuizImageReport,
  countQuizImages,
} from '@sb/shared';
import {
  parseQuizBlock,
  normalizeQuiz,
  buildMixInstruction,
  applyQuizMix,
  buildImageInstruction,
  generateQuiz,
  saveQuizImage,
  QUIZ_PROTOCOL,
} from './quiz.js';
import { saveAnswerStyle, loadAnswerStyle } from '../storage/answer-style.js';

// generateQuiz 的 LLM 调用走 mock（捕获出站 prompt；本文件其余用例不触 LLM）——同 terms.test.ts 手法
let lastPrompt = '';
vi.mock('../llm/router.js', () => ({
  routeRole: () => ({
    adapter: {
      chat: (opts: { messages: Array<{ role: string; content: string }> }) => ({
        async *[Symbol.asyncIterator]() {
          lastPrompt = opts.messages[0]?.content ?? '';
          yield {
            content:
              '[QUIZ]{"title":"T","questions":[{"type":"essay","question":"Q","answer":"a","explanation":"e"}]}[/QUIZ]',
            done: true,
          };
        },
      }),
    },
    model: 'test-model',
    apiKey: 'k',
    baseUrl: 'b',
  }),
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-'));
  openIsolated(dir);
  lastPrompt = '';
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const MIX: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1 };

/** 造题：选择题给足选项（否则 normalize 会丢），填空给数组答案 */
const q = (type: QuizQuestion['type'], i: number): QuizQuestion =>
  type === 'single' || type === 'multiple'
    ? { type, question: `Q${i}`, options: ['a', 'b'], answer: [0] }
    : { type, question: `Q${i}`, answer: type === 'fill' ? ['x'] : '要点' };

const payload = (...types: Array<QuizQuestion['type']>): QuizPayload => ({
  title: 'T',
  questions: types.map((t, i) => q(t, i)),
});

describe('learning/quiz — [QUIZ] 协议解析（AI 输出容错）', () => {
  it('标准 [QUIZ]...[/QUIZ] 包裹解析成功', () => {
    const out = parseQuizBlock(`好的，这是题目：\n[QUIZ]{"title":"T","questions":[{"type":"single","question":"Q?","options":["a","b"],"answer":[1],"explanation":"e"}]}[/QUIZ]`);
    expect(out?.title).toBe('T');
    expect(out?.questions).toHaveLength(1);
  });

  it('围栏/杂质容错（```json 与前后文本）', () => {
    const out = parseQuizBlock('前置说明\n```json\n{"questions":[{"type":"fill","question":"1+1=____","answer":["2"]}]}\n```\n后置');
    expect(out?.questions[0]?.type).toBe('fill');
  });

  it('非法 JSON → null（走降级，不崩 ADR-4）', () => {
    expect(parseQuizBlock('[QUIZ]not-json[/QUIZ]')).toBeNull();
    expect(parseQuizBlock('完全无关文本')).toBeNull();
  });

  it('normalize 丢弃无选项选择题 / 无题干题', () => {
    const out = normalizeQuiz({
      questions: [
        { type: 'single', question: '缺选项', options: ['x'] }, // 选项不足 2 → 丢
        { type: 'single', question: '', options: ['a', 'b'] }, // 无题干 → 丢
        { type: 'essay', question: '正常解答题' },
      ],
    });
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.type).toBe('essay');
  });
});

describe('learning/quiz — 题型配比归一化（契约由 shared 收口）', () => {
  it('负数/小数/非数字 → 钳到 0 或取整，单题型不超上限', () => {
    const out = normalizeQuizMix({ single: -3, multiple: 2.9, fill: 'x', essay: 99 });
    expect(out).toEqual({ single: 0, multiple: 2, fill: 0, essay: MAX_QUIZ_PER_TYPE });
  });

  it('总题数超上限时从后往前削，先保单选与多选', () => {
    const out = normalizeQuizMix({ single: 10, multiple: 10, fill: 10, essay: 10 });
    expect(mixTotal(out)).toBe(MAX_QUIZ_TOTAL);
    expect(out.single).toBe(MAX_QUIZ_PER_TYPE);
    expect(out.multiple).toBe(MAX_QUIZ_PER_TYPE);
    expect(out.fill).toBe(0);
    expect(out.essay).toBe(0);
  });

  it('四档全 0 回退默认配比（0 题的题组没意义，不静默出空气）', () => {
    expect(normalizeQuizMix({ single: 0, multiple: 0, fill: 0, essay: 0 })).toEqual(DEFAULT_QUIZ_MIX);
    expect(normalizeQuizMix(undefined)).toEqual(DEFAULT_QUIZ_MIX);
  });
});

describe('learning/quiz — 配比指令与裁剪（模型不数数时的兜底）', () => {
  it('指令写明总题数、各题型几道，并点名 0 档不要出', () => {
    const text = buildMixInstruction(MIX);
    expect(text).toContain('总共恰好 4 道题');
    expect(text).toContain('单选题 2 道');
    expect(text).toContain('填空题 1 道');
    expect(text).toContain('解答题 1 道');
    expect(text).toContain('不要出多选题');
  });

  it('出齐了：matched true 且一题不多一题不少', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'fill', 'essay'), MIX);
    expect(quiz?.questions).toHaveLength(4);
    expect(report.matched).toBe(true);
    expect(report.actual).toEqual(MIX);
  });

  it('多出的裁掉：模型给了 3 道单选也只留 2 道，且保留原题顺序', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'single', 'fill', 'essay'), MIX);
    expect(quiz?.questions).toHaveLength(4);
    expect(report.actual.single).toBe(2);
    expect(quiz?.questions[2]?.type).toBe('fill');
  });

  it('少出的如实报：matched false 且不补题（ADR-5 三态反馈）', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'fill'), MIX);
    expect(quiz?.questions).toHaveLength(3);
    expect(report.matched).toBe(false);
    expect(report.actual.essay).toBe(0);
    expect(report.requested.essay).toBe(1);
  });

  it('模型自造题型不在四档内 → 丢弃（宁缺勿乱）', () => {
    const { quiz, report } = applyQuizMix(payload('judge' as QuizQuestion['type'], 'single'), MIX);
    expect(quiz?.questions.map((x) => x.type)).toEqual(['single']);
    expect(report.matched).toBe(false);
  });

  it('裁完 0 题返回 null（调用方走 502，不发空题组）', () => {
    const { quiz, report } = applyQuizMix(payload('judge' as QuizQuestion['type']), MIX);
    expect(quiz).toBeNull();
    expect(report.actual).toEqual({ single: 0, multiple: 0, fill: 0, essay: 0 });
  });
});

describe('learning/quiz — 出题配图（契约 docs/QUIZ-IMAGE-SPEC.md）', () => {
  const SVG = '<svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20" fill="none" stroke="#333"/></svg>';
  /** 合法 JSON 里的 SVG：内部双引号必须转义 */
  const SVG_ESC = SVG.replace(/"/g, '\\"');

  it('合法配图原样保留，不影响判分字段', () => {
    const out = parseQuizBlock(
      `[QUIZ]{"title":"T","questions":[{"type":"essay","question":"画个圆","answer":"要点","svg":"${SVG_ESC}"}]}[/QUIZ]`,
    );
    expect(out?.questions[0]?.svg).toBe(SVG);
    expect(out?.questions[0]?.answer).toBe('要点');
  });

  it('图缺 </svg> 闭合 → 只丢图，题还在（丢图保题）', () => {
    const out = parseQuizBlock(
      '[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"<svg viewBox=\\"0 0 10 10\\"><circle"}]}[/QUIZ]',
    );
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.svg).toBeUndefined();
  });

  it('图字段是描述文字不是源码 → 只丢图，题还在', () => {
    const out = parseQuizBlock('[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"一个直角三角形"}]}[/QUIZ]');
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.svg).toBeUndefined();
  });

  it('★ 核心兜底：SVG 漏转义导致 JSON 非法 → 剥图重试，题一道不丢', () => {
    // 值内 viewBox 的引号没转义，原样 parse 必挂；重试后 4 道题应全部保住
    const broken =
      '[QUIZ]{"title":"T","questions":[' +
      '{"type":"single","question":"Q1","options":["a","b"],"answer":[0]},' +
      '{"type":"single","question":"Q2","options":["a","b"],"answer":[1]},' +
      '{"type":"fill","question":"Q3","answer":["x"]},' +
      '{"type":"essay","question":"Q4","svg":"<svg viewBox="0 0 10 10"><circle/></svg>"}' +
      ']}[/QUIZ]';
    expect(() => JSON.parse(broken.slice(7, -8))).toThrow(); // 先证明确实是非法 JSON
    const out = parseQuizBlock(broken);
    expect(out?.questions).toHaveLength(4);
    expect(out?.questions[3]?.svg).toBeUndefined();
    expect(out?.questions[0]?.question).toBe('Q1');
  });

  it('★ 升级：剥图 + 逐题回退都上了的垃圾输入 → 题保住、只丢图（v1.0 在这直接整组 null）', () => {
    const junk =
      '[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"<svg viewBox="0 0 10 10"<circle/></svg>"}[/QUIZ]';
    const report = emptyQuizImageReport(true);
    const out = parseQuizBlock(junk, report);
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.svg).toBeUndefined();
    expect(report.droppedSvg).toBe(1);
    // 这种输入缺收尾 `]}`，靠逐题回退才救回来——成因分不开，但「输出没写完」得如实报
    expect(report.truncated).toBe(true);
  });

  it('彻底救不出的输入仍 null（不硬凑半题，走既有 502 降级）', () => {
    expect(parseQuizBlock('[QUIZ]{"title":"T","questions":[{"type":"essay","meta":{"k":"v"}')).toBeNull();
  });

  it('normalizeQuiz 逐题校验：坏图丢、好图留，题目一律保留', () => {
    const out = normalizeQuiz({
      questions: [
        { type: 'essay', question: '带好图', svg: SVG },
        { type: 'essay', question: '带坏图', svg: '<svg 没闭合' },
        { type: 'essay', question: '无图' },
      ],
    });
    expect(out?.questions.map((x) => x.question)).toEqual(['带好图', '带坏图', '无图']);
    expect(out?.questions[0]?.svg).toBe(SVG);
    expect(out?.questions[1]?.svg).toBeUndefined();
    expect(out?.questions[2]?.svg).toBeUndefined();
  });
});

describe('learning/quiz — 配图指令（v1.1：正面强制 + 留合法出口）', () => {
  it('关 → 给「一律空字符串」的正面指令（不再用模型会无视的负面措辞）', () => {
    const text = buildImageInstruction(false);
    expect(text).toContain('不配图');
    expect(text).toContain('空字符串');
    expect(text).not.toContain('必须给 svg');
  });

  it('开 → 硬性要求 + 不给逃逸口，仍保留 viewBox / 禁外链 等硬约束', () => {
    const text = buildImageInstruction(true);
    expect(text).toContain('必须给 svg');
    expect(text).toContain('空字符串');
    expect(text).toContain('单引号');
    expect(text).toContain('viewBox');
    expect(text).toContain('<image>');
    expect(text).not.toContain('不要为凑数画图');
    expect(text).not.toContain('不要输出 svg');
  });

  it('开 → 带「每组最多 3 张」限流（实测带图出题最长 96.8s，逼近适配器 120s 硬断流）', () => {
    expect(buildImageInstruction(true)).toContain('最多 3 道题配图');
  });
});

describe('learning/quiz — 协议示例自证（配图 0 产率的根因闸门，契约 §2.7）', () => {
  it('★ 格式示例里四个题对象全部带 svg 字段', () => {
    const sample = QUIZ_PROTOCOL.match(/\[QUIZ\](\{[\s\S]*\})\[\/QUIZ\]/)?.[1] ?? '';
    expect(sample).not.toBe('');
    expect((sample.match(/"svg"\s*:/g) ?? []).length).toBe(4);
  });

  it('★ 示例自己就得能解析：4 道题、其中 1 张合法图（示例是模型唯一的依据）', () => {
    const sample = QUIZ_PROTOCOL.match(/\[QUIZ\](\{[\s\S]*\})\[\/QUIZ\]/)?.[1] ?? '';
    const out = parseQuizBlock(`[QUIZ]${sample}[/QUIZ]`);
    expect(out?.questions).toHaveLength(4);
    expect(countQuizImages(out)).toBe(1);
  });

  it('★ svg 写进了字段清单，不是只在末尾追加一段说明', () => {
    expect(QUIZ_PROTOCOL).toContain('explanation、svg');
  });
});

describe('learning/quiz — 撞 max_tokens 截断的逐题回退（契约 §2.6 更正）', () => {
  const Q1 = '{"type":"single","question":"Q1","options":["a","b"],"answer":[0]}';
  const Q2 = '{"type":"fill","question":"Q2","answer":["x"]}';
  /** 真实截断形状：前几题完整，最后一题的 svg 写到一半没气 */
  const TRUNCATED =
    `[QUIZ]{"title":"T","questions":[${Q1},${Q2},` +
    '{"type":"essay","question":"Q3","svg":"<svg viewBox="0 0 1 1"><circle';

  it('★ 尾部残缺 → 砍掉残缺题、保住前面的完整题，并如实报 truncated', () => {
    const report = emptyQuizImageReport(true);
    const out = parseQuizBlock(TRUNCATED, report);
    expect(out?.questions.map((x) => x.question)).toEqual(['Q1', 'Q2']);
    expect(report.truncated).toBe(true);
  });

  it('不截断就不误报 truncated', () => {
    const report = emptyQuizImageReport(true);
    parseQuizBlock('[QUIZ]{"questions":[{"type":"essay","question":"Q"}]}[/QUIZ]', report);
    expect(report.truncated).toBe(false);
  });
});

describe('learning/quiz — 配图总闸硬门与丢图上报（契约 §2.2 修正① / §2.4）', () => {
  const SVG = '<svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20" fill="none" stroke="#333"/></svg>';
  const SVG_ESC = SVG.replace(/"/g, '\\"');

  it('allowSvg=false → 合法 svg 也无条件剥掉，且不计 droppedSvg（关着不出图是预期不是损失）', () => {
    const report = emptyQuizImageReport(false);
    const out = parseQuizBlock(`[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"${SVG_ESC}"}]}[/QUIZ]`, report, false);
    expect(out?.questions[0]?.svg).toBeUndefined();
    expect(report.droppedSvg).toBe(0);
  });

  it('normalizeQuiz 自己就收硬门：不经过解析器的调用方也漏不掉', () => {
    const out = normalizeQuiz({ questions: [{ type: 'essay', question: 'Q', svg: SVG }] }, { allowSvg: false });
    expect(out?.questions[0]?.svg).toBeUndefined();
  });

  it('开关开着但图画坏了 → 丢图保题，逐题计入 droppedSvg（不静默）', () => {
    const report = emptyQuizImageReport(true);
    const out = parseQuizBlock(
      '[QUIZ]{"questions":[{"type":"essay","question":"Q1","svg":"一个直角三角形"},{"type":"essay","question":"Q2","svg":"<svg 没闭合"}]}[/QUIZ]',
      report,
    );
    expect(out?.questions).toHaveLength(2);
    expect(report.droppedSvg).toBe(2);
    expect(countQuizImages(out)).toBe(0);
  });

  it('★ 剥图重试那条路也要报：图在 JSON 文本里就被清空了，进到 normalize 前根本看不到', () => {
    const report = emptyQuizImageReport(true);
    const broken = '[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"<svg viewBox="0 0 10 10"><circle/></svg>"}]}[/QUIZ]';
    expect(() => JSON.parse(broken.slice(6, -7))).toThrow();
    const out = parseQuizBlock(broken, report);
    expect(out?.questions[0]?.question).toBe('Q');
    expect(report.droppedSvg).toBe(1);
  });

  it('图正常交付 → droppedSvg 0，countQuizImages 数得出交付张数', () => {
    const report = emptyQuizImageReport(true);
    const out = parseQuizBlock(`[QUIZ]{"questions":[{"type":"essay","question":"Q","svg":"${SVG_ESC}"}]}[/QUIZ]`, report);
    expect(out?.questions[0]?.svg).toBe(SVG);
    expect(report.droppedSvg).toBe(0);
    expect(countQuizImages(out)).toBe(1);
    expect(countQuizImages(null)).toBe(0);
  });
});

describe('generateQuiz 出站提示词 — 回答方式偏好真进了 prompt（契约 ANSWER-STYLE §3.2）', () => {
  it('未配置偏好 → prompt 带默认档，且出题侧带「不动协议字段」护栏', async () => {
    const out = await generateQuiz('牛顿第二定律', '材料正文');
    expect(out?.questions).toHaveLength(1);
    expect(lastPrompt).toContain('以下只是表达偏好，只影响题干与解析的写法');
    expect(lastPrompt).toContain('结论先行'); // 默认 verbosity=standard
    expect(lastPrompt).toContain('题型配比'); // 护栏句点名不动配比与配图
  });

  it('不传 style → 读库内偏好（设置页选的就算数）', async () => {
    saveAnswerStyle({ shape: 'bullets', support: 'worked' });
    await generateQuiz('T', 'M');
    expect(lastPrompt).toContain('多用短列点');
    expect(lastPrompt).toContain('带具体数字');
    expect(lastPrompt).not.toContain('以整段叙述为主'); // 换档后旧措辞必须消失
    expect(lastPrompt).toContain('结论先行'); // verbosity 未动 → 默认档仍在场（逐字段，不是整份替换）
  });

  it('显式传 style 只覆盖本次，库内那份不受影响也不两段并存', async () => {
    saveAnswerStyle({ verbosity: 'detailed' });
    await generateQuiz('T', 'M', undefined, undefined, { ...DEFAULT_ANSWER_STYLE, verbosity: 'brief' });
    expect(lastPrompt).toContain('两三句内');
    expect(lastPrompt).not.toContain('宁长勿短'); // 库里那份不得同时在场
    expect(loadAnswerStyle().verbosity).toBe('detailed'); // 本次覆盖不写库
  });

  it('段落顺序固定：配比 → 配图 → 偏好（偏好排最后，不插进协议与配图之间）', async () => {
    saveQuizImage(true);
    await generateQuiz('T', 'M');
    const iMix = lastPrompt.indexOf('本次出题数量要求');
    const iImg = lastPrompt.indexOf('配图要求');
    const iStyle = lastPrompt.indexOf('以下只是表达偏好');
    expect(iMix).toBeGreaterThan(-1);
    expect(iImg).toBeGreaterThan(iMix);
    expect(iStyle).toBeGreaterThan(iImg);
  });
});
