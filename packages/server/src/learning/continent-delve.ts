/**
 * learning/continent-delve — 地块「追问」升级：玩家就这块地的词条追问一句 → AI 作答并据此出几道题 →
 * 全部答对 ⇒ 地块 +1 级（`levelUpCell`）。
 *
 * ★ 降级链与伙伴对话同一口径（`resolveNpcTarget`）：没有可用模型 ⇒ 用词条释义作答、本地出题，
 *   并以 `source: 'fallback'` 如实告诉前端（降级可以，假装没降级不行）。
 * ★ 判分在服务端：题目与答案只存在进程内的待答表里（15 分钟过期）；前端拿到的是**去掉答案**的题面。
 */
import {
  buildQuestion,
  cellKey,
  delveQuizSize,
  gradeAnswer,
  type ContinentAnswer,
  type ContinentQuestion,
} from '@sb/shared';
import type { ChatMessage } from '../llm/types.js';
import { ownerForWrite } from '../auth/ownership.js';
import { resolveNpcTarget } from './npc-genesis.js';
import { levelUpCell, loadWorld, type WorldPayload, type WorldResult } from './continent-world.js';

const TTL_MS = 15 * 60_000;
const pending = new Map<string, { questions: ContinentQuestion[]; exp: number }>();

/** 给前端的题面（不含答案） */
export type DelveQuestion =
  | { type: 'judge'; prompt: string; statement: string }
  | { type: 'choice'; prompt: string; options: string[] };

function strip(q: ContinentQuestion): DelveQuestion {
  if (q.type === 'judge') return { type: 'judge', prompt: q.prompt, statement: q.statement };
  if (q.type === 'choice' || q.type === 'scene') return { type: 'choice', prompt: q.prompt, options: q.options };
  return { type: 'choice', prompt: q.prompt, options: [] };
}

function pickJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function aiQuiz(raw: unknown): ContinentQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ContinentQuestion[] = [];
  for (const it of raw) {
    const o = it as { q?: unknown; options?: unknown; answer?: unknown };
    const opts = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    const ans = Number(o.answer);
    if (typeof o.q !== 'string' || !o.q.trim() || opts.length < 3 || opts.length > 5 || !Number.isInteger(ans) || ans < 0 || ans >= opts.length) continue;
    out.push({ type: 'choice', prompt: o.q.trim().slice(0, 200), options: opts.map((x) => x.trim().slice(0, 120)), answerIndex: ans });
  }
  return out;
}

export interface DelveAsk extends Record<string, unknown> {
  answer: string;
  source: 'ai' | 'fallback';
  questions: DelveQuestion[];
  term: string;
}

export async function delveAsk(ownerId: string | null, body: Record<string, unknown>): Promise<WorldResult<DelveAsk>> {
  const row = Number(body.row);
  const col = Number(body.col);
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!Number.isInteger(row) || !Number.isInteger(col)) return { ok: false, status: 400, error: '坐标不对' };
  if (question.length < 4) return { ok: false, status: 400, error: '追问至少写 4 个字——问一个你真想知道的点' };
  if (question.length > 200) return { ok: false, status: 400, error: '追问太长了，200 字以内' };
  const { world, terms } = loadWorld(ownerId);
  const cell = world.cells[cellKey(row, col)];
  if (!cell) return { ok: false, status: 404, error: '这一格还没开拓' };
  if (!cell.t) return { ok: false, status: 409, error: '这是一块荒地，还没有词条落户——多学一条词条它就有主了' };
  if (cell.lv >= 3) return { ok: false, status: 409, error: '这块地已经是最高级了' };
  const term = terms.find((t) => t.id === cell.t);
  if (!term) return { ok: false, status: 409, error: '这块地的词条不见了，刷新一下' };
  const n = delveQuizSize(cell.lv);

  let answer = '';
  let quiz: ContinentQuestion[] = [];
  const target = resolveNpcTarget(ownerId);
  if (target?.model && target.apiKey) {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          `你是知识大陆上的贤者。学习者正在深入研习词条「${term.term}」（领域：${term.domain}；释义：${term.definition}）。`,
          '先用 3~6 句中文口语回答他的追问，要准确、具体，可举一个例子；然后根据你的回答出单选题检验他是否读懂。',
          `严格只回一个 JSON：{"answer":"你的回答","quiz":[{"q":"题干","options":["A","B","C","D"],"answer":0}]}，quiz 恰好 ${n} 道，answer 为正确选项下标。`,
          '题目必须能从你的回答里找到依据，干扰项要似是而非但明确错误。',
        ].join('\n'),
      },
      { role: 'user', content: question },
    ];
    let acc = '';
    try {
      for await (const chunk of target.adapter.chat({
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        messages,
        temperature: 0.5,
        maxTokens: 1400,
        streamMode: 'once',
      })) {
        if (chunk.content) acc += chunk.content;
        if (chunk.done) break;
      }
    } catch {
      acc = '';
    }
    const j = pickJson(acc);
    if (j && typeof j.answer === 'string' && j.answer.trim()) {
      answer = j.answer.trim().slice(0, 1200);
      quiz = aiQuiz(j.quiz).slice(0, n);
    }
  }
  const source: 'ai' | 'fallback' = answer ? 'ai' : 'fallback';
  if (!answer) {
    answer = `（本地贤者：还没有绑定 AI，只能照着词条释义回答）关于「${term.term}」：${term.definition}。你问的「${question}」，建议带着这条释义去对话里追问 AI，会得到更具体的解答。`;
  }
  // 题不够（或降级）就用本地出题器补齐：判断 / 选择轮流
  for (let i = 0; quiz.length < n && i < n * 3; i += 1) {
    const q = buildQuestion(i % 2 === 0 ? 'choice' : 'judge', term, terms, `${term.id}#delve${cell.lv}#${i}`);
    if (q && (q.type === 'judge' || ((q.type === 'choice' || q.type === 'scene') && q.options.length >= 2))) quiz.push(q);
  }
  pending.set(`${ownerForWrite(ownerId)}|${cellKey(row, col)}`, { questions: quiz, exp: Date.now() + TTL_MS });
  return { ok: true, answer, source, questions: quiz.map(strip), term: term.term };
}

export function delveFinish(
  ownerId: string | null,
  body: Record<string, unknown>,
): WorldResult<Partial<WorldPayload> & { passed: boolean; wrong: number[]; lv?: number }> {
  const row = Number(body.row);
  const col = Number(body.col);
  const key = `${ownerForWrite(ownerId)}|${cellKey(row, col)}`;
  const p = pending.get(key);
  if (!p || p.exp < Date.now()) {
    pending.delete(key);
    return { ok: false, status: 409, error: '这次追问已经过期了，重新追问一次吧' };
  }
  const answers = Array.isArray(body.answers) ? (body.answers as ContinentAnswer[]) : [];
  const wrong = p.questions.map((q, i) => (gradeAnswer(q, answers[i] as ContinentAnswer) ? -1 : i)).filter((i) => i >= 0);
  if (wrong.length > 0) return { ok: true, passed: false, wrong };
  pending.delete(key);
  const up = levelUpCell(ownerId, row, col);
  if (!up.ok) return up;
  return { ok: true, passed: true, wrong: [], world: up.world, termCount: up.termCount, day: up.day, lv: up.lv };
}
