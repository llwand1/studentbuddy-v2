import { createHash, randomUUID } from 'node:crypto';
import type { OpenQuizRound, QuizRound, QuizRoundResponse, QuizQuestion, QuestionReviewStatus, GradeResult, QuizExplanation, QuizReviewItem, QuizRoundHistory } from '@sb/shared';
import { blankQuizAnswer, checkQuizAnswer, quizAnswerReady } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import type { DraftChange } from './quiz-round-input.js';

interface RoundRow { id: string; owner_id: string; quiz_key: string; quiz_id: string; session_id: string | null; title: string; origin: OpenQuizRound['origin']; round_number: number; state: QuizRound['state']; revision: number; questions_json: string; created_at: string }
interface ResponseRow { question_index: number; revision: number; draft_json: string; thought: string; result_json: string | null; grade_json: string | null; review_status: QuestionReviewStatus; generation: number; analysis: string; analysis_ready: number; illustration_json: string | null; error: string; recorded: number }
export class RoundConflict extends Error {}
export class RoundInputError extends Error {}
const decode = <T>(text: string | null): T | null => text ? JSON.parse(text) as T : null;
function rowFor(id: string, owner: string | null): RoundRow | undefined {
  return getDb().prepare('SELECT * FROM quiz_round WHERE id = ? AND owner_id = ?').get(id, ownerForWrite(owner)) as RoundRow | undefined;
}
export function roundSession(id: string, owner: string | null): string | null | undefined { return rowFor(id, owner)?.session_id; }
export function loadQuizRound(id: string, owner: string | null): QuizRound | null {
  const row = rowFor(id, owner);
  if (!row) return null;
  const params = [row.owner_id, row.quiz_key];
  const previous = getDb().prepare('SELECT id FROM quiz_round WHERE owner_id = ? AND quiz_key = ? AND round_number < ? ORDER BY round_number DESC LIMIT 1').get(...params, row.round_number) as { id: string } | undefined;
  const latest = getDb().prepare('SELECT id FROM quiz_round WHERE owner_id = ? AND quiz_key = ? ORDER BY round_number DESC LIMIT 1').get(...params) as { id: string };
  const rows = getDb().prepare('SELECT * FROM quiz_response WHERE round_id = ? ORDER BY question_index').all(id) as ResponseRow[];
  return { id, quizKey: row.quiz_key, quizId: row.quiz_id, title: row.title, origin: row.origin, sessionId: row.session_id, number: row.round_number, state: row.state, revision: row.revision,
    questions: JSON.parse(row.questions_json) as QuizQuestion[], previousId: previous?.id ?? null, latestId: latest.id,
    responses: rows.map(r => ({ index: r.question_index, revision: r.revision, draft: JSON.parse(r.draft_json), thought: r.thought,
      result: decode<QuizReviewItem>(r.result_json), grade: decode<GradeResult>(r.grade_json), status: r.review_status,
      generation: r.generation, analysis: r.analysis, analysisReady: !!r.analysis_ready, recorded: !!r.recorded, illustration: decode<QuizExplanation>(r.illustration_json), error: r.error })) };
}
export function listQuizRoundHistory(owner: string | null, beforeId?: string): QuizRoundHistory {
  const before = beforeId ? rowFor(beforeId, owner) : undefined;
  if (beforeId && !before) return { items: [], nextCursor: null };
  const rows = getDb().prepare(`SELECT * FROM quiz_round AS r WHERE owner_id = ? AND (session_id IS NULL OR EXISTS(SELECT 1 FROM sessions AS s WHERE s.id = r.session_id AND s.deleted_at IS NULL)) ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT 21`)
    .all(ownerForWrite(owner), ...(before ? [before.created_at, before.created_at, before.id] : [])) as RoundRow[];
  return { items: rows.slice(0, 20).map(r => ({ id: r.id, title: r.title, number: r.round_number, state: r.state,
    origin: r.origin, createdAt: r.created_at, questionCount: (JSON.parse(r.questions_json) as QuizQuestion[]).length })),
    nextCursor: rows.length > 20 ? rows[19]!.id : null };
}
function insertRound(input: OpenQuizRound, owner: string | null, key: string, number: number): QuizRound {
  const db = getDb(), id = randomUUID();
  db.prepare('INSERT INTO quiz_round(id,owner_id,quiz_key,quiz_id,session_id,title,origin,round_number,questions_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, ownerForWrite(owner), key, input.quizId ?? `qr-${key}`, input.sessionId ?? null, input.title, input.origin, number, JSON.stringify(input.questions), new Date().toISOString());
  const insert = db.prepare('INSERT INTO quiz_response(round_id,question_index,draft_json) VALUES(?,?,?)');
  input.questions.forEach((q, i) => insert.run(id, i, JSON.stringify(blankQuizAnswer(q))));
  return loadQuizRound(id, owner)!;
}
export function openQuizRound(input: OpenQuizRound, owner: string | null): QuizRound {
  const key = createHash('sha256').update(JSON.stringify([ownerForWrite(owner), input.sessionId ?? '', input.quizId ?? '', input.origin, input.title, input.questions])).digest('hex');
  return getDb().transaction(() => {
    const latest = getDb().prepare('SELECT id FROM quiz_round WHERE owner_id = ? AND quiz_key = ? ORDER BY round_number DESC LIMIT 1').get(ownerForWrite(owner), key) as { id: string } | undefined;
    return latest ? loadQuizRound(latest.id, owner)! : insertRound(input, owner, key, 1);
  })();
}
export function newQuizRound(id: string, owner: string | null): QuizRound | null {
  return getDb().transaction(() => {
    const old = rowFor(id, owner), current = old && loadQuizRound(id, owner);
    if (!old || !current) return null;
    if (current.latestId !== id) return loadQuizRound(current.latestId, owner);
    if (current.state !== 'submitted') throw new RoundConflict('请先交卷，再开始新一轮。');
    return insertRound({ title: old.title, questions: current.questions, origin: old.origin as OpenQuizRound['origin'], quizId: old.quiz_id,
      ...(old.session_id ? { sessionId: old.session_id } : {}) }, owner, old.quiz_key, old.round_number + 1);
  })();
}
export function saveQuizDraft(id: string, owner: string | null, change: DraftChange): QuizRoundResponse | null {
  const round = loadQuizRound(id, owner);
  if (!round) return null;
  if (round.state !== 'draft' || round.latestId !== id) throw new RoundConflict('本轮已交卷，思考与答案已作为提交快照保留。');
  const saved = getDb().prepare('UPDATE quiz_response SET draft_json = ?, thought = ?, revision = revision + 1 WHERE round_id = ? AND question_index = ? AND revision = ?')
    .run(JSON.stringify(change.draft), change.thought, id, change.index, change.revision);
  if (!saved.changes) throw new RoundConflict('这道题已在另一处修改。你的输入仍在页面上，请重新加载后核对。');
  getDb().prepare('UPDATE quiz_round SET revision = revision + 1 WHERE id = ?').run(id);
  return loadQuizRound(id, owner)!.responses[change.index]!;
}
export function submitQuizRound(id: string, owner: string | null, changes: DraftChange[]): QuizRound | null {
  return getDb().transaction(() => {
    const round = loadQuizRound(id, owner);
    if (!round) return null;
    if (round.state === 'submitted') return round;
    if (changes.length !== round.questions.length || new Set(changes.map(c => c.index)).size !== changes.length) throw new RoundInputError('请提交本组所有题目的作答。');
    for (const change of changes) {
      const q = round.questions[change.index];
      if (!q || !quizAnswerReady(q, change.draft)) throw new RoundInputError('还有题目未作答，思考不是必填项。');
      if (q.scenarioTask) { try { JSON.parse(change.draft.essay); } catch { throw new RoundInputError('情景操作记录格式不正确，请重新操作。'); } }
      saveQuizDraft(id, owner, change);
      const result = checkQuizAnswer(q, change.draft);
      getDb().prepare("UPDATE quiz_response SET result_json = ?, review_status = 'queued' WHERE round_id = ? AND question_index = ?").run(JSON.stringify(result), id, change.index);
    }
    getDb().prepare("UPDATE quiz_round SET state = 'submitted', submitted_at = ?, revision = revision + 1 WHERE id = ?").run(new Date().toISOString(), id);
    return loadQuizRound(id, owner)!;
  })();
}
type ReviewPatch = Partial<Pick<QuizRoundResponse, 'result' | 'grade' | 'status' | 'generation' | 'analysis' | 'analysisReady' | 'illustration' | 'error'>>;
/** Static column allowlist; a model cannot choose a SQL field or another question. */
export function updateRoundReview(id: string, owner: string | null, index: number, patch: ReviewPatch, withRound = true): QuizRound | null {
  if (!rowFor(id, owner)) return null;
  const fields = { result: 'result_json', grade: 'grade_json', status: 'review_status', generation: 'generation', analysis: 'analysis', analysisReady: 'analysis_ready', illustration: 'illustration_json', error: 'error' } as const;
  const columns: string[] = [], values: Array<string | number | null> = [];
  for (const key of Object.keys(fields) as Array<keyof ReviewPatch>) if (key in patch) {
    columns.push(`${fields[key]} = ?`);
    const v = patch[key];
    values.push(typeof v === 'object' ? v === null ? null : JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v ?? null);
  }
  if (columns.length) getDb().transaction(() => {
    getDb().prepare(`UPDATE quiz_response SET ${columns.join(',')} WHERE round_id = ? AND question_index = ?`).run(...values, id, index);
    getDb().prepare('UPDATE quiz_round SET revision = revision + 1 WHERE id = ?').run(id);
  })();
  return withRound ? loadQuizRound(id, owner) : null;
}
export function quizRoundRevision(id: string, owner: string | null): number { return rowFor(id, owner)?.revision ?? -1; }
export function recordRoundOnce(id: string, owner: string | null, index: number, record: (round: QuizRound, response: QuizRoundResponse) => void): void {
  getDb().transaction(() => {
    const round = loadQuizRound(id, owner), response = round?.responses[index];
    if (!round || !response) return;
    const changed = getDb().prepare('UPDATE quiz_response SET recorded = 1 WHERE round_id = ? AND question_index = ? AND recorded = 0').run(id, index);
    if (changed.changes) record(round, response);
  })();
}
