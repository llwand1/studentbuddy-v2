import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizExplanation, QuizRoundEvent } from '@sb/shared';
const mocks = vi.hoisted(() => ({ text: vi.fn(), grade: vi.fn(), effects: vi.fn(), diagram: vi.fn() }));
vi.mock('../ai/gateway.js', () => ({ aiText: mocks.text }));
vi.mock('./quiz-grade.js', () => ({ gradeAnswer: mocks.grade, applyGradeEffects: mocks.effects }));
vi.mock('./quiz-explanation.js', () => ({ generateExplanation: mocks.diagram }));
const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const { openQuizRound, submitQuizRound, loadQuizRound } = await import('./quiz-round-store.js');
const { startQuizRoundAnalysis, cancelQuizRoundAnalysis, subscribeQuizRound, recoverInterruptedRound } = await import('./quiz-question-agent.js');
let dir: string;
const diagram: QuizExplanation = { summary: '原理', sections: [{ title: '因果', questions: [1], explanation: '说明', svg: "<svg viewBox='0 0 10 10'><rect width='8' height='8'/><text>检索</text></svg>", caption: '原理图' }], transfer: { question: '换个条件', answer: '参考' } };
const ids: string[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-question-agent-')); openIsolated(dir); ids.length = 0;
  mocks.text.mockReset(); mocks.grade.mockReset(); mocks.effects.mockReset(); mocks.diagram.mockReset();
  mocks.text.mockImplementation(async (opts) => { opts.onChunk({ content: '针对这一题的解释', done: false }); return { ok: true, text: '针对这一题的解释' }; });
  mocks.diagram.mockResolvedValue(diagram);
  mocks.grade.mockResolvedValue({ ok: true, result: { verdict: 'correct', score: 1, feedback: '意思等价', misconception: null } });
});
afterEach(async () => { ids.forEach(id => cancelQuizRoundAnalysis(id, null)); await new Promise(resolve => setTimeout(resolve, 20)); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
function submitted(count = 2, essay = false) {
  const r = openQuizRound({ title: '并行复盘', origin: 'chat', questions: Array.from({ length: count }, (_, i) => essay
    ? { type: 'essay' as const, question: `题 ${i}`, answer: '标准' }
    : { type: 'single' as const, question: `题 ${i}`, options: ['甲', '乙'], answer: [0] }) }, null);
  ids.push(r.id);
  return submitQuizRound(r.id, null, r.responses.map(a => ({ index: a.index, revision: 0, draft: { ...a.draft, picked: essay ? [] : [0], essay: essay ? '正式作答' : '' }, thought: `这题 ${a.index} 的思考` })))!;
}
const finished = (id: string) => vi.waitFor(() => expect(loadQuizRound(id, null)!.responses.every(r => ['complete', 'error', 'cancelled'].includes(r.status))).toBe(true));
it('unanswered essay is recorded as wrong once, never sent for subjective grading or awarded a score from thinking',async()=>{
  const r=openQuizRound({title:'空白复盘',origin:'chat',questions:[{type:'essay',question:'解释过程',answer:'标准'}]},null);ids.push(r.id);
  submitQuizRound(r.id,null,r.responses.map(a=>({index:a.index,revision:a.revision,draft:a.draft,thought:'思考中有参考答案，但正式作答留空'})));
  startQuizRoundAnalysis(r.id,null);await finished(r.id);
  expect(mocks.grade).not.toHaveBeenCalled();expect(mocks.effects).not.toHaveBeenCalled();
  const saved=loadQuizRound(r.id,null)!.responses[0]!;expect(saved.result).toMatchObject({verdict:'wrong',answer:'未作答'});expect(saved.recorded).toBe(true);
  expect(JSON.parse(mocks.text.mock.calls[0]![0].messages[1].content).item.answer).toBe('未作答');
});
it('streams each question separately, passes only its thinking and keeps checking separate from notes', async () => {
  const r = submitted(2, true), events: QuizRoundEvent[] = [];
  const off = subscribeQuizRound(r.id, e => events.push(e)); startQuizRoundAnalysis(r.id, null); await finished(r.id); off();
  expect(mocks.grade).toHaveBeenCalledTimes(2);
  for (const args of mocks.grade.mock.calls) { expect(args[0].answer).toBe('正式作答'); expect(JSON.stringify(args[0])).not.toContain('思考'); expect(args[3]).toBe(false); }
  const notes = mocks.text.mock.calls.map(([opts]) => JSON.parse(opts.messages[1].content));
  expect(notes.map(n => n.thought)).toEqual(['这题 0 的思考', '这题 1 的思考']);
  expect(events.filter(e => e.type === 'delta').map(e => e.index).sort()).toEqual([0, 1]);
  expect(mocks.effects).toHaveBeenCalledTimes(2);
  expect(loadQuizRound(r.id, null)!.responses.every(a => a.analysisReady && a.illustration)).toBe(true);
});
it('isolates diagram failure and retries only that stage without repeating text, grading or attempts', async () => {
  mocks.diagram.mockRejectedValueOnce(new Error('图示格式不完整'));
  const r = submitted(); startQuizRoundAnalysis(r.id, null); await finished(r.id);
  const before = loadQuizRound(r.id, null)!;
  const failed = before.responses.find(a => a.status === 'error')!;
  expect(failed.analysisReady).toBe(true); expect(before.responses.some(a => a.status === 'complete')).toBe(true);
  const textCalls = mocks.text.mock.calls.length;
  startQuizRoundAnalysis(r.id, null, failed.index); await finished(r.id);
  expect(mocks.text).toHaveBeenCalledTimes(textCalls);
  expect(loadQuizRound(r.id, null)!.responses.every(a => a.status === 'complete')).toBe(true);
  expect(getDb().prepare('SELECT attempts FROM quiz_stats WHERE quiz_id = ?').all(r.quizId)).toEqual([{ attempts: 1 }, { attempts: 1 }]);
});
it('limits all quiz groups of the same owner to three simultaneous agents and allows faster questions first', async () => {
  const release: Array<() => void> = [];
  mocks.text.mockImplementation(opts => new Promise(resolve => {
    release.push(() => { opts.onChunk({ content: '先完成的题', done: false }); resolve({ ok: true, text: '先完成的题' }); });
  }));
  const r = submitted(3), second = submitted(2); startQuizRoundAnalysis(r.id, null); startQuizRoundAnalysis(second.id, null);
  expect(mocks.text).toHaveBeenCalledTimes(3);
  release[1]!(); await vi.waitFor(() => expect(loadQuizRound(r.id, null)!.responses[1]!.status).toBe('complete'));
  expect(loadQuizRound(r.id, null)!.responses[0]!.status).toBe('analyzing');
  expect(mocks.text).toHaveBeenCalledTimes(4);
  release[0]!(); release[2]!(); release[3]!(); await vi.waitFor(() => expect(release.length).toBe(5)); release[4]!(); await finished(r.id); await finished(second.id);
});
it('cancels running and queued questions while retaining streamed text and never starts cancelled queued work', async () => {
  mocks.text.mockImplementation(opts => new Promise((_, reject) => {
    opts.onChunk({ content: '已出现的文字', done: false });
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
  }));
  const r = submitted(5); startQuizRoundAnalysis(r.id, null); cancelQuizRoundAnalysis(r.id, null); await finished(r.id);
  expect(mocks.text).toHaveBeenCalledTimes(3);
  expect(loadQuizRound(r.id, null)!.responses.slice(0, 3).every(a => a.status === 'cancelled' && a.analysis === '已出现的文字')).toBe(true);
  expect(loadQuizRound(r.id, null)!.responses.slice(3).every(a => a.status === 'cancelled' && !a.recorded)).toBe(true);
});
it('marks persisted orphaned work as interrupted rather than pretending it is running forever', () => {
  const r = submitted();
  const recovered = recoverInterruptedRound(r.id, null)!;
  expect(recovered.responses.every(a => a.status === 'cancelled' && a.error.includes('中断'))).toBe(true);
});
