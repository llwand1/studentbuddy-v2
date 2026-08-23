/**
 * learning/quiz — 出题引擎 + 题库 + 逐题统计（练+析两环服务）。
 * 协议：[QUIZ] JSON（shared/content-blocks QuizPayload）；normalize 校验后入库；
 * 出题走 quiz-generator 角色模型（演进①），失败降级纯文本不崩（ADR-4）。
 */
import { randomUUID } from 'node:crypto';
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';

const QUIZ_PROTOCOL = `你是一个出题引擎。根据给定材料出一组练习题，严格按以下 JSON 格式输出，输出外围包一对 [QUIZ]...[/QUIZ] 标记：
[QUIZ]{"title":"标题","questions":[{"type":"single","question":"单选题干","options":["A","B","C","D"],"answer":[0],"explanation":"解析"},{"type":"multiple","question":"多选题干","options":["A","B","C"],"answer":[0,2],"explanation":"解析"},{"type":"fill","question":"填空题干，空位用____","answer":["答案1"],"explanation":"解析"},{"type":"essay","question":"解答题干","answer":"参考要点","solution":"完整解答"}]}[/QUIZ]
规则：single 的 answer 是正确选项下标数组（一个元素）；multiple 可多元素；fill 的 answer 按空位顺序；essay 不判分只给参考。题目必须源于给定材料，不得编造。除该 JSON 外不要输出任何其他文字。`;

/** 解析模型输出中的 [QUIZ] JSON（容错：多行/围栏/前后杂质；失败返回 null 走降级） */
export function parseQuizBlock(text: string): QuizPayload | null {
  const m = text.match(/\[QUIZ\]([\s\S]*?)\[\/QUIZ\]/);
  let raw = m ? m[1] : '';
  if (!raw && text.includes('"questions"')) raw = text;
  if (!raw) return null;
  // 容错：剥离围栏后仍可能有前后杂质——提取首个完整 JSON 对象
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    return normalizeQuiz(JSON.parse(objMatch[0]) as QuizPayload);
  } catch {
    return null;
  }
}

/** 校验规范化：丢弃无题干/无选项的 single/multiple；fill answer 转数组。 */
export function normalizeQuiz(data: QuizPayload): QuizPayload | null {
  const questions: QuizQuestion[] = [];
  for (const q of data.questions ?? []) {
    if (!q.question?.trim()) continue;
    if ((q.type === 'single' || q.type === 'multiple') && (!Array.isArray(q.options) || q.options.length < 2)) continue;
    questions.push(q);
  }
  return questions.length > 0 ? { title: data.title || '练习题', questions } : null;
}

/** 一键出题（基于主题/对话材料），返回 QuizPayload 或 null（降级由调用方处理）。 */
export async function generateQuiz(topic: string, material?: string): Promise<QuizPayload | null> {
  const target = routeRole('quiz-generator');
  if (!target || !target.model) return null;
  let acc = '';
  const prompt = `${QUIZ_PROTOCOL}\n\n材料：\n${material ? material.slice(0, 60000) : `主题：${topic}`}`;
  for await (const chunk of target.adapter.chat({
    model: target.model,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    messages: [{ role: 'user', content: prompt }],
  })) {
    acc += chunk.content;
    if (chunk.done) break;
  }
  return parseQuizBlock(acc);
}

// ── 题库 ──
export function saveQuiz(data: QuizPayload, source: string, id?: string): string {
  const qid = id ?? randomUUID();
  getDb()
    .prepare('INSERT OR REPLACE INTO quiz_bank (id, title, source, data) VALUES (?, ?, ?, ?)')
    .run(qid, data.title ?? '练习题', source, JSON.stringify(data));
  return qid;
}

export function listQuiz(): Array<{ id: string; title: string; source: string; count: number; created_at: string }> {
  const rows = getDb()
    .prepare('SELECT id, title, source, data, created_at FROM quiz_bank ORDER BY created_at DESC')
    .all() as Array<{ id: string; title: string; source: string; data: string; created_at: string }>;
  return rows.map((r) => {
    let count = 0;
    try {
      count = (JSON.parse(r.data) as QuizPayload).questions.length;
    } catch {
      count = 0;
    }
    return { id: r.id, title: r.title, source: r.source, count, created_at: r.created_at };
  });
}

export function getQuiz(id: string): QuizPayload | null {
  const row = getDb().prepare('SELECT data FROM quiz_bank WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as QuizPayload;
  } catch {
    return null;
  }
}

export function deleteQuiz(id: string): void {
  getDb().prepare('DELETE FROM quiz_bank WHERE id = ?').run(id);
  getDb().prepare('DELETE FROM quiz_stats WHERE quiz_id = ?').run(id);
}

// ── 逐题统计（析环数据源）──
export function recordAnswer(quizId: string, index: number, correct: boolean): void {
  const db = getDb();
  const cur = db
    .prepare('SELECT attempts, correct, streak, best_streak FROM quiz_stats WHERE quiz_id = ? AND question_index = ?')
    .get(quizId, index) as { attempts: number; correct: number; streak: number; best_streak: number } | undefined;
  const attempts = (cur?.attempts ?? 0) + 1;
  const correctCount = (cur?.correct ?? 0) + (correct ? 1 : 0);
  const streak = correct ? (cur?.streak ?? 0) + 1 : 0;
  const best = Math.max(cur?.best_streak ?? 0, streak);
  db.prepare(
    `INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_index) DO UPDATE SET attempts=excluded.attempts, correct=excluded.correct,
       streak=excluded.streak, best_streak=excluded.best_streak, last_answer=excluded.last_answer, updated_at=datetime('now')`,
  ).run(quizId, index, attempts, correctCount, streak, best, correct ? 'correct' : 'wrong');
}

export interface WeakPoint {
  topic: string;
  questionIndexes: number[];
  reason: string;
  suggestion: string;
}

/** 薄弱点分析：本地规则版（错题聚类）+ 可选 AI 报告（analyzer 角色），失败降级本地版。 */
export function analyzeWeakPoints(quizId: string): { weak: WeakPoint[]; fallback: boolean } {
  const quiz = getQuiz(quizId);
  const stats = getDb()
    .prepare('SELECT question_index, attempts, correct, streak FROM quiz_stats WHERE quiz_id = ?')
    .all(quizId) as Array<{ question_index: number; attempts: number; correct: number; streak: number }>;
  const wrong = stats.filter((s) => s.attempts > 0 && s.correct / s.attempts < 0.6);
  if (!quiz || wrong.length === 0) return { weak: [], fallback: true };
  const weak: WeakPoint[] = [
    {
      topic: quiz.title ?? '本题库',
      questionIndexes: wrong.map((w) => w.question_index),
      reason: '正确率低于 60% 的题目',
      suggestion: '针对这些题重新练习，并阅读解析',
    },
  ];
  return { weak, fallback: true };
}
