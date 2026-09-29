/**
 * learning/quiz-grade.test — 评分的后效：误区入模型、答对消误区、进学习事件流；失败如实分类。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ai = vi.hoisted(() => ({ out: null as unknown }));
vi.mock('../ai/gateway.js', () => ({
  aiJson: async (opts: { parse: (t: string) => unknown; messages: Array<{ content: string }> }) => {
    const o = ai.out as { fail?: string; text?: string };
    if (o.fail) return { ok: false, reason: o.fail, error: '失败原因' };
    return { ok: true, value: opts.parse(o.text ?? ''), text: o.text, repaired: false };
  },
}));

const { openIsolated, closeDb } = await import('../storage/db.js');
const { subscribeEvents } = await import('../events/bus.js');
const { gradeAnswer, buildGradeMessages } = await import('./quiz-grade.js');
const { openMisconceptions, recordMisconception } = await import('./learner-model.js');

let dir: string;
let events: Array<Record<string, unknown>> = [];
let off = () => undefined as void;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-grade-'));
  openIsolated(dir);
  events = [];
  off = subscribeEvents((e) => {
    if (e.type === 'quiz_answered') events.push(e as unknown as Record<string, unknown>);
  });
});
afterEach(() => {
  off();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = { question: '光合作用的原料？', reference: '水；二氧化碳', answer: 'H2O；CO2', qtype: 'fill' as const, topic: '光合作用' };

describe('gradeAnswer', () => {
  it('答错带误区 ⇒ 记进学习者模型，事件 correct=false、题型 fill', async () => {
    ai.out = { text: '{"verdict":"wrong","score":0,"feedback":"原料不对","misconception":"把产物氧气当成原料"}' };
    const r = await gradeAnswer(req, 'u1');
    expect(r.ok && r.result.verdict).toBe('wrong');
    expect(openMisconceptions('u1')[0]).toMatchObject({ topic: '光合作用', note: '把产物氧气当成原料' });
    expect(events[0]).toMatchObject({ correct: false, qtype: 'fill', source: 'chat-quiz', ownerId: 'u1' });
  });

  it('★ 答对挂在词条上的题 ⇒ 该词条的误区标为已解决；解答题记成 short', async () => {
    recordMisconception('u1', { termId: 't1', topic: '', note: '旧误区' });
    ai.out = { text: '{"verdict":"correct","score":1,"feedback":"对"}' };
    await gradeAnswer({ ...req, qtype: 'essay', termId: 't1' }, 'u1');
    expect(openMisconceptions('u1')).toEqual([]);
    expect(events[0]).toMatchObject({ correct: true, qtype: 'short', termId: 't1' });
  });

  it('★ 失败 ⇒ 如实返回原因，不记事件、不记误区', async () => {
    ai.out = { fail: 'no-model' };
    const r = await gradeAnswer(req, 'u1');
    expect(!r.ok && r.reason).toBe('no-model');
    expect(events).toEqual([]);
  });

  it('提示词带齐题型、题目、参考与作答；超长截断', () => {
    const [sys, user] = buildGradeMessages({ ...req, answer: '长'.repeat(5000) });
    expect(sys!.content).toContain('意思是否等价');
    expect(user!.content).toContain('【题型】填空题');
    expect(user!.content).toContain('【参考答案】水；二氧化碳');
    expect(user!.content.length).toBeLessThan(4300);
  });
});
