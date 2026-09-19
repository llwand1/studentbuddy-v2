/**
 * learning/quiz-weak 回归（契约 docs/QUIZ-WEAK-SPEC.md）：
 * ① AI 是主路径——模型输出经归一后落成多主题薄弱点（旧实现是两句固定文案）；
 * ② 三条降级真因（no-model / call-failed / parse）各自如实上报，且降级内容是本地规则版；
 * ③ 「还没做题」是正常空态（fallback=false），**不与降级混淆**（混了就会出现
 *    「模型没配」被说成「你还没做题」，用户照着去刷题，刷完还是那句）；
 * ④ 错选快照与题干选项确实进了提示词——那是「真洞察」的唯一来源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizPayload } from '@sb/shared';
import type { TokenChunk } from '../llm/types.js';
import { openIsolated, closeDb } from '../storage/db.js';
import { saveQuiz, recordAnswer } from './quiz.js';
import { saveScenario } from './scenario.js';
import { upsertNoteFromAnswer } from './notes.js';
import {
  analyzeWeakPoints,
  localWeakPoints,
  parseWeakJson,
  WEAK_MAX_QUESTIONS,
} from './quiz-weak.js';

/** 受控桩：target=null 模拟「没有启用的服务商」，turn=Error 模拟调用抛错 */
const stub = vi.hoisted(() => ({
  target: null as null | { model: string },
  turn: [] as TokenChunk[] | Error,
  lastPrompt: '',
}));

vi.mock('../llm/router.js', () => ({
  routeRole: () => {
    if (!stub.target) return null;
    return {
      model: stub.target.model,
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:1/v1',
      adapter: {
        type: 'openai' as const,
        async *chat(args: { messages: Array<{ role: string; content: string }> }) {
          stub.lastPrompt = args.messages[0]?.content ?? '';
          if (stub.turn instanceof Error) throw stub.turn;
          for (const chunk of stub.turn) yield chunk;
        },
        async listModels() {
          return [];
        },
      },
    };
  },
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-weak-'));
  openIsolated(dir);
  stub.target = { model: 'test-model' };
  stub.turn = [];
  stub.lastPrompt = '';
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const single = (i: number): QuizPayload['questions'][number] => ({
  type: 'single',
  question: `Q${i}`,
  options: ['a', 'b', 'c'],
  answer: [2],
});

const seed = (count = 3): string => saveQuiz({ title: '二重积分练习', questions: Array.from({ length: count }, (_, i) => single(i)) }, 'test', null);

/** 让某题成为错题：默认 2 次全错（正确率 0 < 0.6） */
function markWrong(quizId: string, index: number, times = 2): void {
  for (let i = 0; i < times; i++) recordAnswer(quizId, index, false, null);
}

const ok = (body: unknown): TokenChunk[] => [{ content: JSON.stringify(body), done: true }];

describe('analyzeWeakPoints — AI 实时分析为主路径', () => {
  it('模型正常输出 → 多主题薄弱点，fallback=false', async () => {
    const id = seed();
    markWrong(id, 0);
    markWrong(id, 2);
    stub.turn = ok([
      { topic: '二重积分换元', questionIndexes: [0, 2], reason: '极坐标换元时漏乘 r', suggestion: '先画积分区域再定 r 的范围' },
      { topic: '积分次序', questionIndexes: [1], reason: '交换次序后上下限没跟着换', suggestion: '交换次序后重画区域图' },
    ]);
    const r = await analyzeWeakPoints(id, null);
    expect(r.fallback).toBe(false);
    expect(r.failure).toBeUndefined();
    expect(r.analyzed).toBe(2);
    expect(r.weak).toHaveLength(2);
    expect(r.weak[0]?.topic).toBe('二重积分换元');
    expect(r.weak[0]?.questionIndexes).toEqual([0, 2]);
    expect(r.weak[1]?.topic).toBe('积分次序');
  });

  it('提示词带上题干/选项/正确答案/学生所选/正确率——错选是「真洞察」的唯一来源', async () => {
    const id = seed();
    markWrong(id, 0);
    upsertNoteFromAnswer(id, 0, false, null, [1]);
    stub.turn = ok([]);
    await analyzeWeakPoints(id, null);
    expect(stub.lastPrompt).toContain('[0] 单选');
    expect(stub.lastPrompt).toContain('题干：Q0');
    expect(stub.lastPrompt).toContain('选项：A. a B. b C. c');
    expect(stub.lastPrompt).toContain('正确答案：C. c');
    expect(stub.lastPrompt).toContain('学生所选：B. b');
    expect(stub.lastPrompt).toContain('历史正确率：0/2（0%）');
  });

  it('从没带 answer 提交过 → 错选显示「未记录」，不编造', async () => {
    const id = seed();
    markWrong(id, 0);
    stub.turn = ok([]);
    await analyzeWeakPoints(id, null);
    expect(stub.lastPrompt).toContain('学生所选：未记录');
  });

  it('模型给出越界题号时被归一闸门滤掉，但整条合法主题仍保留', async () => {
    const id = seed();
    markWrong(id, 1);
    stub.turn = ok([{ topic: 'T', questionIndexes: [1, 99], reason: 'r', suggestion: 's' }]);
    const r = await analyzeWeakPoints(id, null);
    expect(r.fallback).toBe(false);
    expect(r.weak[0]?.questionIndexes).toEqual([1]);
  });
});

describe('analyzeWeakPoints — 正常空态与降级必须分开说', () => {
  it('还没做题 → 空态，fallback=false（不是降级）', async () => {
    const id = seed();
    const r = await analyzeWeakPoints(id, null);
    expect(r).toEqual({ weak: [], fallback: false, analyzed: 0 });
  });

  it('题库不存在 → 空态，且不触模型调用', async () => {
    const r = await analyzeWeakPoints('no-such-quiz', null);
    expect(r).toEqual({ weak: [], fallback: false, analyzed: 0 });
    expect(stub.lastPrompt).toBe('');
  });

  it('全对 → 空态（正确率 1.0 不算错题）', async () => {
    const id = seed();
    recordAnswer(id, 0, true, null);
    expect((await analyzeWeakPoints(id, null)).analyzed).toBe(0);
  });
});

describe('analyzeWeakPoints — 三条降级真因（ADR-5 谁真知道谁填）', () => {
  it('没有启用的服务商 → no-model，内容是本地规则版', async () => {
    stub.target = null;
    const id = seed();
    markWrong(id, 0);
    const r = await analyzeWeakPoints(id, null);
    expect(r.fallback).toBe(true);
    expect(r.failure).toBe('no-model');
    expect(r.analyzed).toBe(1);
    expect(r.weak[0]?.reason).toBe('正确率低于 60% 的题目');
    expect(r.weak[0]?.questionIndexes).toEqual([0]);
  });

  it('角色绑定了但模型名为空 → 也算 no-model（该去设置页，不是「可重试」）', async () => {
    stub.target = { model: '' };
    const id = seed();
    markWrong(id, 0);
    expect((await analyzeWeakPoints(id, null)).failure).toBe('no-model');
  });

  it('模型调用抛错 → call-failed', async () => {
    const id = seed();
    markWrong(id, 0);
    stub.turn = new Error('boom');
    const r = await analyzeWeakPoints(id, null);
    expect(r.failure).toBe('call-failed');
    expect(r.fallback).toBe(true);
  });

  it('模型输出纯散文 → parse（与 call-failed 是两条路）', async () => {
    const id = seed();
    markWrong(id, 0);
    stub.turn = [{ content: '你的薄弱点主要在于基础不牢，建议多练习。', done: true }];
    expect((await analyzeWeakPoints(id, null)).failure).toBe('parse');
  });

  it('模型输出空串 → parse', async () => {
    const id = seed();
    markWrong(id, 0);
    stub.turn = [{ content: '', done: true }];
    expect((await analyzeWeakPoints(id, null)).failure).toBe('parse');
  });

  it('模型给了 JSON 但题号全部越界 → parse（不拿半成品糊弄用户）', async () => {
    const id = seed();
    markWrong(id, 0);
    stub.turn = ok([{ topic: 'T', questionIndexes: [99], reason: 'r', suggestion: 's' }]);
    const r = await analyzeWeakPoints(id, null);
    expect(r.failure).toBe('parse');
    expect(r.weak[0]?.reason).toBe('正确率低于 60% 的题目'); // 退回规则版
  });

  it('降级时 analyzed 仍如实报真实错题数（不因降级而虚报 0）', async () => {
    stub.target = null;
    const id = seed();
    markWrong(id, 0);
    markWrong(id, 1);
    markWrong(id, 2);
    expect((await analyzeWeakPoints(id, null)).analyzed).toBe(3);
  });
});

describe('localWeakPoints — 降级落点，不许删', () => {
  it('判据与旧实现一致：正确率 < 0.6 才算错题', async () => {
    const id = seed();
    recordAnswer(id, 0, false, null);
    recordAnswer(id, 0, false, null);
    recordAnswer(id, 0, true, null); // 1/3 ≈ 0.33 → 错题
    recordAnswer(id, 1, true, null);
    recordAnswer(id, 1, true, null);
    recordAnswer(id, 1, false, null); // 2/3 ≈ 0.67 → 不算
    const r = await analyzeWeakPoints(id, null);
    expect(r.analyzed).toBe(1);
    expect(localWeakPoints(id, null)[0]?.questionIndexes).toEqual([0]);
  });

  it('没有错题时返回空数组（不是造一条空的）', () => {
    const id = seed();
    expect(localWeakPoints(id, null)).toEqual([]);
  });

  it(`错题超过 ${WEAK_MAX_QUESTIONS} 道时封顶（窗口与可读性双约束）`, async () => {
    const id = seed(15);
    for (let i = 0; i < 15; i++) markWrong(id, i);
    stub.target = null;
    expect((await analyzeWeakPoints(id, null)).analyzed).toBe(WEAK_MAX_QUESTIONS);
  });
});

describe('parseWeakJson — 四道阶梯（弱模型给围栏/给散文是常态）', () => {
  it('原样 JSON 直接解析', () => {
    expect(parseWeakJson('[{"topic":"T"}]')).toEqual([{ topic: 'T' }]);
  });

  it('剥掉 markdown 围栏', () => {
    expect(parseWeakJson('```json\n[{"topic":"T"}]\n```')).toEqual([{ topic: 'T' }]);
  });

  it('模型前后加了说明文字时截取首尾方括号', () => {
    expect(parseWeakJson('好的，分析如下：[{"topic":"T"}] 以上。')).toEqual([{ topic: 'T' }]);
  });

  it('补模型漏写的 ]（复用 quiz-json-repair 的无损修复）', () => {
    const broken = '[{"topic":"T","questionIndexes":[0,1,"reason":"r","suggestion":"s"}]';
    expect(parseWeakJson(broken)).toEqual([{ topic: 'T', questionIndexes: [0, 1], reason: 'r', suggestion: 's' }]);
  });

  it('纯散文返回 null（由调用方判 parse 失败并降级）', () => {
    expect(parseWeakJson('你的问题在于基础不牢')).toBeNull();
  });
});


// ── 情景题覆盖（SCENARIO-SPEC §8 M4，2026-09-17）──

describe('analyzeWeakPoints — 情景题（tasks 形状）', () => {
  /** 登记一套 3 评分点的情景题并让指定任务全错 */
  const seedScenario = (wrongAt: number[] = []): string => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: 't' + (i + 1),
      prompt: '情景任务' + (i + 1) + '：' + (i === 0 ? '选出危险源' : i === 1 ? '完成断电操作' : '按顺序合闸'),
      criteria:
        i === 0
          ? { kind: 'choice' as const, answer: [1] }
          : i === 1
            ? { kind: 'state' as const, value: 'off' }
            : { kind: 'order' as const, answer: ['a', 'b', 'c'] },
    }));
    const saved = saveScenario({ title: '用电安全情景演练', tasks }, '<!doctype html><html><body></body></html>', null);
    if (!saved) throw new Error('seed 失败');
    for (const i of wrongAt) markWrong(saved.quizId, i);
    return saved.quizId;
  };

  it('提示词用任务+判据做素材（不是题干选项），学生操作如实「未记录」', async () => {
    const id = seedScenario([0]);
    stub.turn = ok([]);
    await analyzeWeakPoints(id, null);
    expect(stub.lastPrompt).toContain('[0] 情景任务');
    expect(stub.lastPrompt).toContain('任务：情景任务1：选出危险源');
    expect(stub.lastPrompt).toContain('对错标准：应选选项 [1]');
    expect(stub.lastPrompt).toContain('学生操作：未记录');
    expect(stub.lastPrompt).toContain('历史正确率：0/2（0%）');
  });

  it('AI 聚类回填任务下标，越界任务号被归一闸门滤掉（上界=tasks.length）', async () => {
    const id = seedScenario([0, 2]);
    stub.turn = ok([
      { topic: '危险源识别', questionIndexes: [0, 99], reason: 'r', suggestion: 's' },
      { topic: '操作顺序', questionIndexes: [2], reason: 'r', suggestion: 's' },
    ]);
    const r = await analyzeWeakPoints(id, null);
    expect(r.fallback).toBe(false);
    expect(r.weak).toHaveLength(2);
    expect(r.weak[0]?.questionIndexes).toEqual([0]);
    expect(r.weak[1]?.questionIndexes).toEqual([2]);
  });

  it('没有模型 → 降级规则版照常出（情景题不错过兜底）', async () => {
    const id = seedScenario([1]);
    stub.target = null;
    const r = await analyzeWeakPoints(id, null);
    expect(r.fallback).toBe(true);
    expect(r.failure).toBe('no-model');
    expect(r.weak[0]?.questionIndexes).toEqual([1]);
  });
});
