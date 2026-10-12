import type { OpenQuizRound, QuizDraftAnswer, QuizQuestion } from '@sb/shared';
import { QUIZ_ROUND_MAX, QUIZ_THOUGHT_MAX, parseQuizDraft } from '@sb/shared';
import { normalizeQuiz } from './quiz.js';
import { getScenario, getScenarioDemoId } from './scenario.js';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseOpenRound(v: unknown, owner: string | null = null): OpenQuizRound | null {
  if (record(v) && v.origin === 'scenario') {
    if (typeof v.quizId !== 'string' || typeof v.title !== 'string'
      || (v.sessionId !== undefined && (typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 200))) return null;
    const payload = getScenario(v.quizId, owner), demoId = getScenarioDemoId(v.quizId, owner);
    if (!payload || !demoId) return null;
    return { title: payload.title, origin: 'scenario', quizId: v.quizId,
      ...(typeof v.sessionId === 'string' ? { sessionId: v.sessionId } : {}),
      questions: payload.tasks.map(t => ({ type: 'essay', question: t.prompt, explanation: t.hint,
        scenarioTask: { id: t.id, criteria: t.criteria, demoId } })) };
  }
  if (!record(v) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 500
    || !['chat', 'arrival', 'desktop'].includes(String(v.origin)) || !Array.isArray(v.questions)
    || !v.questions.length || v.questions.length > QUIZ_ROUND_MAX || JSON.stringify(v).length > 120000) return null;
  if (v.quizId !== undefined && (typeof v.quizId !== 'string' || !/^[\w-]{1,80}$/.test(v.quizId))) return null;
  if (v.sessionId !== undefined && (typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 200)) return null;
  if (v.questions.some(q => !record(q) || typeof q.question !== 'string' || q.question.length > 5000
    || !['single', 'multiple', 'judge', 'fill', 'essay'].includes(String(q.type))
    || (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => typeof o !== 'string' || o.length > 4000)))
    || ['explanation', 'solution'].some(k => q[k] !== undefined && (typeof q[k] !== 'string' || q[k].length > 8000))
    || (q.source !== undefined && (!record(q.source) || typeof q.source.title !== 'string' || (q.source.url !== undefined && typeof q.source.url !== 'string')))
    || (q.photo !== undefined && (!record(q.photo) || typeof q.photo.src !== 'string' || typeof q.photo.alt !== 'string' || typeof q.photo.credit !== 'string'))
    || (q.material !== undefined && (typeof q.material !== 'string' || q.material.length > 16000)))) return null;
  const normalized = normalizeQuiz({ title: v.title, questions: v.questions as QuizQuestion[] }, { keepPhoto: true });
  if (!normalized || normalized.questions.length !== v.questions.length) return null;
  for (const q of normalized.questions) {
    delete q.scenarioTask;
    if (q.source?.url && !/^https?:\/\//i.test(q.source.url)) delete q.source.url;
    if (q.photo && (!( /^https?:\/\//i.test(q.photo.src) || (q.photo.src.startsWith('/api/') && !q.photo.src.includes('\\')) ) || typeof q.photo.alt !== 'string' || typeof q.photo.credit !== 'string')) delete q.photo;
    if (q.photo?.pageUrl && !/^https?:\/\//i.test(q.photo.pageUrl)) delete q.photo.pageUrl;
  }
  return { title: v.title, questions: normalized.questions, origin: v.origin as OpenQuizRound['origin'],
    ...(typeof v.quizId === 'string' ? { quizId: v.quizId } : {}), ...(typeof v.sessionId === 'string' ? { sessionId: v.sessionId } : {}) };
}
export interface DraftChange { index: number; revision: number; draft: QuizDraftAnswer; thought: string }
export function parseDraftChange(v: unknown, questions: QuizQuestion[]): DraftChange | null {
  if (!record(v) || typeof v.index !== 'number' || !Number.isInteger(v.index) || v.index < 0
    || typeof v.revision !== 'number' || !Number.isInteger(v.revision) || v.revision < 0 || !record(v.draft)
    || typeof v.thought !== 'string' || v.thought.length > QUIZ_THOUGHT_MAX) return null;
  const q = questions[v.index];
  if (!q) return null;
  const draft = parseQuizDraft(v.draft, q);
  return draft ? { index: v.index, revision: v.revision, thought: v.thought, draft } : null;
}
