import { vi } from 'vitest';
import { blankQuizAnswer, checkQuizAnswer, type OpenQuizRound, type QuizRound, type QuizRoundEvent } from '@sb/shared';
export const roundMocks = { open: vi.fn(), get: vi.fn(), save: vi.fn(), submit: vi.fn(), next: vi.fn(), retry: vi.fn(), cancel: vi.fn(), history: vi.fn(), events: (id: string) => `/api/quiz/rounds/${id}/events` };
export const attemptMocks = { list: vi.fn(), record: vi.fn() };
const rows = new Map<string, QuizRound>();
let serial = 0;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export class RoundEventSource {
  static instances: RoundEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { RoundEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(event: QuizRoundEvent) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
export function makeRound(input: OpenQuizRound): QuizRound {
  const id = `round-${++serial}`;
  return { id, title: input.title, origin: input.origin, sessionId: input.sessionId ?? null, quizId: input.quizId ?? id, quizKey: id,
    number: 1, revision: 0, state: 'draft', questions: clone(input.questions), previousId: null, latestId: id,
    responses: input.questions.map((q, index) => ({ index, revision: 0, draft: blankQuizAnswer(q), thought: '', result: null, grade: null,
      status: 'none', generation: 0, analysis: '', analysisReady: false, recorded: false, illustration: null, error: '' })) };
}
export function resetRoundMocks() {
  rows.clear(); serial = 0; RoundEventSource.instances = [];
  Object.values(roundMocks).forEach(fn => { if ('mockReset' in fn) fn.mockReset(); });
  attemptMocks.list.mockReset().mockResolvedValue({ rows: [] }); attemptMocks.record.mockReset();
  roundMocks.open.mockImplementation(async (input: OpenQuizRound) => { const r = makeRound(input); rows.set(r.id, r); return clone(r); });
  roundMocks.get.mockImplementation(async (id: string) => clone(rows.get(id)!));
  roundMocks.save.mockImplementation(async (id, change) => {
    const r = rows.get(id)!, a = r.responses[change.index]!;
    Object.assign(a, clone(change), { revision: a.revision + 1 }); r.revision++;
    return clone(a);
  });
  roundMocks.submit.mockImplementation(async (id, changes) => {
    const r = rows.get(id)!;
    for (const change of changes) {
      const a = r.responses[change.index]!; Object.assign(a, clone(change));
      a.result = checkQuizAnswer(r.questions[a.index]!, a.draft); a.status = 'complete'; a.analysisReady = true; a.recorded = true; a.analysis = '本题分析文字'; a.generation = 1;
    }
    r.state = 'submitted'; r.revision++; return clone(r);
  });
  roundMocks.next.mockImplementation(async (id: string) => {
    const previous = rows.get(id)!, r = makeRound({ title: previous.title, questions: previous.questions, origin: previous.origin, quizId: previous.quizId });
    r.number = previous.number + 1; r.previousId = previous.id; previous.latestId = r.id; rows.set(r.id, r); return clone(r);
  });
  roundMocks.history.mockResolvedValue({ items: [], nextCursor: null });
  vi.stubGlobal('EventSource', RoundEventSource);
}
export const roundState = (id: string) => rows.get(id)!;
