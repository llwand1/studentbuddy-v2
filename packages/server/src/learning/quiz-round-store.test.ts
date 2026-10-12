import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blankQuizAnswer, type OpenQuizRound } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { loadQuizRound, openQuizRound, saveQuizDraft, submitQuizRound, newQuizRound, updateRoundReview, listQuizRoundHistory, RoundConflict, recordRoundOnce } from './quiz-round-store.js';
import { parseDraftChange, parseOpenRound } from './quiz-round-input.js';
const input: OpenQuizRound = { title: '记忆', origin: 'chat', quizId: 'quiz-one', questions: [
  { type: 'single', question: '哪种学习方法更好？', options: ['集中重复', '间隔检索'], answer: [1], explanation: '间隔检索。' },
  { type: 'essay', question: '解释原因', answer: '检索促进记忆。' },
] };
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-round-store-')); openIsolated(dir); });
afterEach(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
const changes = (id: string, owner: string | null = null) => loadQuizRound(id, owner)!.responses.map(r => ({ index: r.index, revision: r.revision,
  draft: { ...r.draft, picked: r.index === 0 ? [0] : [], essay: r.index === 1 ? '检索让记忆更牢固' : '' }, thought: r.index === 0 ? '我认为正确答案是 B，但这次选了 A。' : '' }));
it('opens one stable draft per quiz and owner, saves optional thinking and rejects stale writes', () => {
  const a = openQuizRound(input, 'a');
  expect(openQuizRound(input, 'a').id).toBe(a.id);
  const b = openQuizRound(input, 'b'); expect(b.id).not.toBe(a.id); expect(loadQuizRound(a.id, 'b')).toBeNull();
  const update = { ...changes(a.id, 'a')[0]!, thought: '不确定这一步' };
  const saved = saveQuizDraft(a.id, 'a', update)!;
  expect(saved.revision).toBe(1); expect(loadQuizRound(a.id, 'a')!.responses[0]!.thought).toBe('不确定这一步');
  expect(() => saveQuizDraft(a.id, 'a', { ...update, thought: '迟到的旧输入' })).toThrow(RoundConflict);
  expect(loadQuizRound(a.id, 'a')!.responses[0]!.thought).toBe('不确定这一步');
  expect(listQuizRoundHistory('b').items.map(r => r.id)).toEqual([b.id]);
  const legacy = { ...input, quizId: undefined };
  const fallbackA = openQuizRound(legacy, 'a'), fallbackB = openQuizRound(legacy, 'b');
  expect(fallbackA.quizId).not.toBe(fallbackB.quizId);
  expect(openQuizRound(legacy, 'a').quizId).toBe(fallbackA.quizId);
});
it('submits atomically, checks answers independently from thinking and starts a blank separate round', () => {
  const first = openQuizRound(input, null);
  expect(() => submitQuizRound(first.id, null, changes(first.id).slice(0, 1))).toThrow();
  expect(loadQuizRound(first.id, null)!.state).toBe('draft');
  const submitted = submitQuizRound(first.id, null, changes(first.id))!;
  expect(submitted.responses[0]!.result!.verdict).toBe('wrong');
  expect(submitted.responses[0]!.thought).toContain('正确答案是 B');
  expect(submitted.responses[1]!.thought).toBe('');
  expect(() => saveQuizDraft(first.id, null, changes(first.id)[0]!)).toThrow(RoundConflict);
  expect(submitQuizRound(first.id, null, changes(first.id))!.id).toBe(first.id);
  updateRoundReview(first.id, null, 0, { analysis: '具体指出了误区', analysisReady: true, status: 'error', error: '图示未完成' });
  const next = newQuizRound(first.id, null)!;
  expect(next.number).toBe(2); expect(next.previousId).toBe(first.id);
  expect(next.responses[0]!.draft).toEqual(blankQuizAnswer(input.questions[0]!));
  expect(next.responses.every(r => !r.thought && !r.analysis)).toBe(true);
  expect(loadQuizRound(first.id, null)!.responses[0]!.analysis).toBe('具体指出了误区');
  expect(newQuizRound(first.id, null)!.id).toBe(next.id);
});
it('rolls back the entire submission if one draft has a conflicting revision', () => {
  const r = openQuizRound(input, null), all = changes(r.id);
  all[1]!.revision = 99;
  expect(() => submitQuizRound(r.id, null, all)).toThrow(RoundConflict);
  expect(loadQuizRound(r.id, null)!.responses[0]!.revision).toBe(0);
  expect(loadQuizRound(r.id, null)!.state).toBe('draft');
});
it('records each question once across retries and cascades records when its owning session is deleted', () => {
  getDb().prepare("INSERT INTO sessions(id,title) VALUES('s','测试')").run();
  const r = openQuizRound({ ...input, sessionId: 's' }, null);
  let count = 0;
  recordRoundOnce(r.id, null, 0, () => count++); recordRoundOnce(r.id, null, 0, () => count++);
  expect(count).toBe(1);
  getDb().prepare("DELETE FROM sessions WHERE id = 's'").run();
  expect(loadQuizRound(r.id, null)).toBeNull();
  expect(getDb().prepare('SELECT count(*) AS n FROM quiz_response WHERE round_id = ?').get(r.id)).toEqual({ n: 0 });
});
it('validates optional notes, draft structure and question bounds before persistence', () => {
  expect(parseOpenRound(input)).not.toBeNull();
  const change = changes(openQuizRound(input, null).id)[0]!;
  expect(parseDraftChange(change, input.questions)).not.toBeNull();
  for (const bad of [{ ...change, thought: 'x'.repeat(4001) }, { ...change, index: -1 }, { ...change, revision: 1.5 },
    { ...change, draft: { ...change.draft, picked: [0, 0] } }, { ...change, draft: { ...change.draft, picked: [50] } }]) {
    expect(parseDraftChange(bad, input.questions)).toBeNull();
  }
  expect(parseOpenRound({ ...input, questions: Array(21).fill(input.questions[0]) })).toBeNull();
});
