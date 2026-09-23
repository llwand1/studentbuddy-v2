/**
 * chat/tools/generate-quiz —— `generate_quiz`（2026-09-23「出题工具化」批新建）。
 *
 * ★ 本批的**症状**是「聊天模型只会用文字打字出题，没有题卡」，所以这里锁的第一优先级不是
 *   文案好不好看，而是**模型到底拿不拿得到这个工具**、以及**它调了之后到底出不出卡**：
 *   ① 注册＋下发（`toolDefinitions()` 里没有它 = 本批白做，模型根本看不见出题能力）；
 *   ② `system-prompt.ts` 点名了它（模型手里有工具但提示词教它别在正文里打字出题，两边都到位才成立）；
 *   ③ 走完整链路后题库真有一行、会话里真有 `[QUIZ]` 登记行、回灌文本**不含答案**（老板拍板口径 2）；
 *   ④ `affected` 记 1 而不是题数（口径 3）：记成题数会让 `by_size` 每次出题都弹批准卡，
 *      而在没有会话的上下文里 gate 是**保守拒绝** ⇒ 症状正好是「AI 说它出了题，屏幕上没有卡」。
 *
 * 出题模型调用换桩（手法同 `learning/quiz.test.ts` 的 `routeRole` mock）：本批要验的是
 * 工具这一层的接线与口径，不是模型能力；真模型出得好不好由真人测试单（MT-19）判。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizImageReport, QuizMix, QuizPayload } from '@sb/shared';
import {
  DEFAULT_QUIZ_MIX,
  MAX_QUIZ_PER_TYPE,
  MAX_QUIZ_TOTAL,
  TOOL_LLM_INNER_TIMEOUT_MS,
  emptyQuizImageReport,
  mixTotal,
} from '@sb/shared';

let quizJson = '';
let modelAvailable = true;
/** 真题搜集侧的桩：本批不验搜集链路，只验它**该不该被触发**（拍板口径 1） */
const collectCalls: string[] = [];

vi.mock('../../llm/router.js', () => ({
  routeRole: () =>
    !modelAvailable
      ? null
      : {
          adapter: {
            type: 'openai',
            chat: () => ({
              async *[Symbol.asyncIterator]() {
                yield { content: `[QUIZ]${quizJson}[/QUIZ]`, done: true };
              },
            }),
          },
          model: 'test-model',
          apiKey: 'k',
          baseUrl: 'b',
        },
}));

vi.mock('../../learning/collect.js', () => ({
  collectQuiz: async (topic: string) => {
    collectCalls.push(topic);
    return { report: {}, candidates: [] };
  },
  normalizeCollectedQuiz: () => null,
}));

const { openIsolated, closeDb, getDb } = await import('../../storage/db.js');
// ★ 只走 `./index.js` 这一条路拿工具（不 import generate-quiz.js 本体）：
//   否则注册副作用是自己 import 出来的，「index 里那行没了」就测不出来
const { runTool, toolMeta, toolNames, toolDefinitions } = await import('./index.js');
const { scaleMixToCount, quizToolSummary } = await import('./generate-quiz-format.js');
const { saveQuizMix } = await import('../../learning/quiz.js');
const { saveQuizSourceMix } = await import('../../learning/quiz-source-mix.js');
const { SYSTEM_PROMPT } = await import('../system-prompt.js');
const { CONFIRM_DENY_HINT } = await import('./write-gate.js');
const { quizRowContent } = await import('../../learning/quiz-announce.js');
import type { ToolContext } from './registry.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-generate-quiz-'));
  openIsolated(dir);
  quizJson = GOOD_JSON;
  modelAvailable = true;
  collectCalls.length = 0;
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 三道题（2 单选 + 1 填空）；答案/解析/要点里都埋了可辨识的暗号，用于「不许回灌答案」那条锁 */
const GOOD_JSON = JSON.stringify({
  title: '词根 spect',
  questions: [
    { type: 'single', question: 'aspect 的本义最接近哪一项？', options: ['外表', '旁观', '观点'], answer: [1], explanation: 'ANSWER_LEAK_ex1' },
    { type: 'single', question: 'perspective 里的 per- 表达什么？', options: ['穿过', '向上'], answer: [0], explanation: 'ANSWER_LEAK_ex2' },
    { type: 'fill', question: 'retro_____（回顾）空格处的词根是什么', answer: ['spect'], solution: 'ANSWER_LEAK_sol' },
  ],
});

/** 造一批题（4 单选 + 2 填空）：题数 > 确认门默认阈值 5，专门用来验「affected 记的是入库对象、不是题数」 */
function manyJson(n: number): string {
  const qs = Array.from({ length: n }, (_, i) =>
    i % 3 === 2
      ? { type: 'fill', question: `第 ${i + 1} 题：_____ 处填什么`, answer: [`x${i}`] }
      : { type: 'single', question: `第 ${i + 1} 题？`, options: ['甲', '乙'], answer: [0] },
  );
  return JSON.stringify({ title: '一批题', questions: qs });
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  onStep: () => {},
  ownerId: null,
  sessionId: 'sess-tool-test',
  ...over,
});

function newSession(id = 'sess-tool-test'): void {
  getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, '工具出题');
}

function rows(sql: string, ...args: unknown[]): Array<Record<string, unknown>> {
  return getDb().prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

describe('注册与下发（模型拿不到工具 = 本批全部白做）', () => {
  it('generate_quiz 在注册表里，且出现在下发给模型的清单里', () => {
    expect(toolNames()).toContain('generate_quiz');
    expect(toolDefinitions().map((d) => d.function.name)).toContain('generate_quiz');
  });

  it('元数据：kind=write + 内部再调 LLM 的 120s 档（30s 档会把出题掐死）', () => {
    const t = toolMeta('generate_quiz');
    expect(t?.kind).toBe('write');
    expect(t?.timeoutMs).toBe(TOOL_LLM_INNER_TIMEOUT_MS);
    // 两阶段写：只给 planWrite，不给 run（写门面旁路即漏洞）
    expect(typeof t?.planWrite).toBe('function');
    expect(t?.run).toBeUndefined();
    expect(t?.scenes).toEqual(['explain']);
  });

  it('参数面：只有 topic 必填；count 有上下界（越界由预闸拦下，不进工具体）', () => {
    const fn = toolMeta('generate_quiz')!.definition.function;
    const params = fn.parameters ?? {};
    expect(params.required).toEqual(['topic']);
    const props = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(props.count?.type).toBe('integer');
    expect(props.count?.minimum).toBe(1);
    expect(props.count?.maximum).toBe(MAX_QUIZ_TOTAL);
  });

  it('★ 提示词这半边也到位：SYSTEM_PROMPT 点名 generate_quiz，并禁止正文打字出题', () => {
    expect(SYSTEM_PROMPT).toContain('generate_quiz');
    expect(SYSTEM_PROMPT).toMatch(/正文/);
    // 老那句悬空指令（「给出题时遵循协议」却从没给过协议）不许回来
    expect(SYSTEM_PROMPT).not.toContain('给出题时遵循协议');
  });

  it('参数预闸：缺 topic / count 越界 ⇒ 不执行工具，回灌「怎么改对」', async () => {
    const missing = await runTool('generate_quiz', '{}', ctx());
    expect(missing.content).toContain('参数校验失败');
    expect(missing.content).toContain('topic');
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(0);
    const tooBig = await runTool('generate_quiz', JSON.stringify({ topic: '词根', count: 99 }), ctx());
    expect(tooBig.content).toContain(`不得大于 ${MAX_QUIZ_TOTAL}`);
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(0);
  });
});

describe('scaleMixToCount（点名题量时按题型相对比例缩放，拍板口径 1）', () => {
  const mix = (over: Partial<QuizMix> = {}): QuizMix => ({ ...DEFAULT_QUIZ_MIX, ...over });

  it('默认配比要 4 道 ⇒ 照配比给 2 单选 + 1 填空 + 1 解答', () => {
    expect(scaleMixToCount(mix(), 4)).toEqual({ single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 0 });
  });

  it('要 1 道 ⇒ 恰好 1 道，且给到相对权重最高的那一档', () => {
    const out = scaleMixToCount(mix(), 1);
    expect(mixTotal(out)).toBe(1);
    expect(out.single).toBe(1);
  });

  it('单档上限可以把总数压到不足请求值：如实少给，不越界补题（ADR-5）', () => {
    const out = scaleMixToCount(mix({ single: MAX_QUIZ_PER_TYPE, multiple: 0, fill: 0, essay: 0, judge: 0 }), MAX_QUIZ_TOTAL);
    expect(out.single).toBe(MAX_QUIZ_PER_TYPE);
    expect(mixTotal(out)).toBe(MAX_QUIZ_PER_TYPE);
  });

  it('设置里 AI 侧全 0（纯真题配置）⇒ 回落默认配比，不出空题组', () => {
    const out = scaleMixToCount({ single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 }, 3);
    expect(mixTotal(out)).toBeGreaterThan(0);
    expect(out).toEqual(scaleMixToCount(DEFAULT_QUIZ_MIX, 3));
  });

  it('情景档恒为 0（它走独立引擎，一套＝一整个可玩 demo，不并进「来 3 道题」）', () => {
    expect(scaleMixToCount(mix({ scenario: 3 }), 5).scenario).toBe(0);
  });

  it('可复现：同输入两次调用逐字段相等；越界与小数按边界收口', () => {
    expect(scaleMixToCount(mix(), 7)).toEqual(scaleMixToCount(mix(), 7));
    expect(mixTotal(scaleMixToCount(mix(), 0))).toBeGreaterThanOrEqual(1);
    expect(mixTotal(scaleMixToCount(mix(), -5))).toBeGreaterThanOrEqual(1);
    expect(mixTotal(scaleMixToCount(mix(), 999))).toBeLessThanOrEqual(MAX_QUIZ_TOTAL);
    expect(scaleMixToCount(mix(), 3.9)).toEqual(scaleMixToCount(mix(), 3));
  });
});

describe('quizToolSummary（回灌给模型的文本，拍板口径 2）', () => {
  const quiz = JSON.parse(GOOD_JSON) as QuizPayload;

  it('★ 不含答案、解析与要点：只给题干清单', () => {
    const out = quizToolSummary(quiz, emptyQuizImageReport(), { realRequested: 0, scenarioSkipped: false });
    expect(out).not.toContain('ANSWER_LEAK');
    expect(out).not.toContain('"answer"');
    expect(out).toContain('aspect 的本义最接近哪一项？');
    expect(out).toContain('已出题 3 道');
    expect(out).toContain('单选2／填空1');
  });

  it('明写「不要在正文里重复题目、不要自己批改」——判分归题卡', () => {
    const out = quizToolSummary(quiz, emptyQuizImageReport(), { realRequested: 0, scenarioSkipped: false });
    expect(out).toMatch(/不要在正文里重复/);
    expect(out).toMatch(/不要自己批改/);
  });

  it('三处如实告知：丢图 / 撞长度上限 / 设置里的真题与情景档本次没出', () => {
    const rep = (over: Partial<QuizImageReport> = {}): QuizImageReport => ({
      ...emptyQuizImageReport(true),
      ...over,
    });
    expect(quizToolSummary(quiz, rep({ droppedSvg: 2 }), { realRequested: 0, scenarioSkipped: false })).toContain('2 张图未通过校验被丢弃');
    expect(quizToolSummary(quiz, rep({ truncated: true }), { realRequested: 0, scenarioSkipped: false })).toContain('尾部不完整题已丢弃');
    const s = quizToolSummary(quiz, rep(), { realRequested: 3, scenarioSkipped: true });
    expect(s).toContain('设置里配了 3 道真题');
    expect(s).toContain('情景题');
    // 没点名要题量、设置里也没配真题时不许凭空报缺
    expect(quizToolSummary(quiz, rep(), { realRequested: 0, scenarioSkipped: false })).not.toContain('如实告知学习者');
  });

  it('长题干截 80 字、清单最多 20 条（回灌是报菜名，不是让模型重抄题面）', () => {
    const many: QuizPayload = {
      title: 'T',
      questions: Array.from({ length: 25 }, (_, i) => ({
        type: 'essay' as const,
        question: `${i}-${'长'.repeat(100)}`,
        answer: '要点',
      })),
    };
    const out = quizToolSummary(many, emptyQuizImageReport(), { realRequested: 0, scenarioSkipped: false });
    const lines = out.split('\n').filter((l) => /^\d+\./.test(l));
    expect(lines).toHaveLength(20);
    expect(lines[0]!.length).toBeLessThanOrEqual(90);
    expect(out).toContain('已出题 25 道');
  });
});

describe('端到端：runTool → 计划 → 免批准 → 落库 + 出卡 + 回灌', () => {
  it('★ 一次调用三件产物：题库一行、会话一条 [QUIZ] 登记行、回灌题干清单', async () => {
    newSession();
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '词根 spect' }), ctx());
    expect(r.content).toContain('已出题 3 道');
    expect(r.meta?.affected).toBe(1);
    expect(r.meta?.confirm).toBeNull();
    const bank = rows('SELECT id, source, data FROM quiz_bank');
    expect(bank).toHaveLength(1);
    expect(bank[0]!.source).toBe('ai');
    const msgs = rows("SELECT content FROM messages WHERE session_id = 'sess-tool-test' AND role = 'assistant'");
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]!.content).startsWith('[QUIZ]')).toBe(true);
    // 登记行带得回 quizId（与题库那一行同一个 id）——否则刷新后是张「答了不记账」的死卡
    expect(String(msgs[0]!.content)).toContain(`"quizId":"${String(bank[0]!.id)}"`);
  });

  it('★ 没有会话上下文也照常出卡：affected=1 走免批准档（affected 若记成题数就会被写门面拒掉）', async () => {
    // 6 道 > 确认门默认阈值 5：这条同时锁住两件事——
    // ① `affected` 数的是**入库对象**（一行 quiz_bank），不是题数；
    // ② 没有 sessionId 时 gate 是保守拒绝，所以一旦有人把 affected 改成题数，症状就是
    //    「AI 说它出了题，屏幕上没有卡」——本批最初那个线上症状的复刻。
    quizJson = manyJson(6);
    saveQuizMix({ single: 4, multiple: 0, fill: 2, essay: 0, judge: 0, scenario: 0 }, null);
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '词根' }), ctx({ sessionId: undefined }));
    expect(r.content).toContain('已出题 6 道');
    expect(r.meta?.affected).toBe(1);
    expect(r.content).not.toContain(CONFIRM_DENY_HINT);
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(1);
  });

  it('点名 count 时本次不出真题也不出情景：设置里配了也不碰搜集引擎（拍板口径 1）', async () => {
    saveQuizMix({ single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 1 }, null);
    saveQuizSourceMix({ single: 2, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 }, { single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 1 }, null);
    newSession();
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '词根 spect', count: 2 }), ctx());
    expect(collectCalls).toHaveLength(0);
    expect(r.content).toContain('情景题');
    expect(r.content).not.toContain('设置里配了 2 道真题');
  });

  it('不点名 count 时读设置：真题配比 > 0 就走搜集侧（本工具不吞掉用户的配置）', async () => {
    saveQuizSourceMix({ single: 1, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 }, DEFAULT_QUIZ_MIX, null);
    newSession();
    await runTool('generate_quiz', JSON.stringify({ topic: '词根 spect' }), ctx());
    expect(collectCalls).toEqual(['词根 spect']);
  });

  it('出题模型没配 ⇒ 一条都不写库，回灌「去设置页绑模型」（重试没有用）', async () => {
    modelAvailable = false;
    newSession();
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '词根' }), ctx());
    expect(r.content).toContain('出题角色没有可用的模型');
    expect(r.meta?.affected).toBe(0);
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(0);
    expect(rows('SELECT id FROM messages')).toHaveLength(0);
  });

  it('模型输出解不出题组 ⇒ 文案说「解析不出」而不是「没配模型」，同样零写入', async () => {
    quizJson = '这不是 JSON';
    newSession();
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '词根' }), ctx());
    expect(r.content).toContain('没能解析成题目');
    expect(r.content).not.toContain('没有可用的模型');
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(0);
  });

  it('topic 只有空白 ⇒ 预闸放行（它是字符串）但工具体如实拒，不白跑一次模型调用', async () => {
    newSession();
    const r = await runTool('generate_quiz', JSON.stringify({ topic: '   ' }), ctx());
    expect(r.content).toContain('topic 为空');
    expect(rows('SELECT id FROM quiz_bank')).toHaveLength(0);
  });

  it('出卡与 REST 入口同一个门面：登记行 content 逐字同形（两个入口各写一份就是漂移源）', async () => {
    newSession();
    await runTool('generate_quiz', JSON.stringify({ topic: '词根' }), ctx());
    const stored = String(rows("SELECT content FROM messages WHERE session_id = 'sess-tool-test'")[0]!.content);
    const bank = rows('SELECT id, title, data FROM quiz_bank')[0]!;
    const payload = JSON.parse(String(bank.data)) as QuizPayload;
    expect(stored).toBe(quizRowContent(payload, String(bank.id)));
  });
});
