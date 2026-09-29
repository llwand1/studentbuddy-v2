/**
 * pk/question-pool — 对战 AI 的**预生成题池**（AI 深度 Step 4）。
 *
 * ★ 为什么要池：PVE 里 AI 出一道题要走 `generateQuiz` + 联网检索 + 盲解验算（issue #71），
 *   实测经常二三十秒；这段时间玩家只能看着「AI 正在出题」干等。池里有现成的、**已经过验算**的题，
 *   AI 到点就能出，体感从「等半分钟」变成「立刻」。
 * ★ 池怎么补：后台任务 `pk.pregen`（按主题 dedupe），每个主题补到 `POOL_TARGET` 道。
 *   触发点只有一个——AI 出题时（不管池命中还是没命中）顺手要求补这个主题。
 *   ⇒ 从没人打过的主题不会被预生成（不替没人用的东西花钱）；打过一次之后，下一局就有现成题。
 * ★ 同一局不出重复题：取题时排除本局已出现过的题干。用过的题标 `used_at`，不再发给任何人。
 * ★ 预生成只在任务 worker 在跑时进行（生产进程）：单测与脚本导入时 `requestRefill` 什么也不做，
 *   否则 `dispatchJob` 的内联兜底会在测试里真去调出题管道。
 * ★ 走平台通道（ownerId=null），与 `runAiQuiz` 同口径：AI 对手是平台扮演的角色。
 * ★ 本文件不 import match（match → ai-bot → 本文件），合法性判定自己写一份最小版。
 */
import { randomUUID } from 'node:crypto';
import { PK_QUIZ_MIX } from '@sb/shared';
import type { QuizQuestion } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { generateQuiz } from '../learning/quiz.js';
import { dispatchJob, jobWorkerRunning, registerJobHandler } from '../jobs/worker.js';

export const PK_PREGEN_JOB = 'pk.pregen';
export const POOL_TARGET = 3;
/** 一次补池最多真调几次（生成失败/不合法也算一次），防止坏主题无限烧钱 */
const MAX_ATTEMPTS = 5;
const POOL_TTL_DAYS = 30;

export function poolTopicKey(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
}

/** 与 match.ts `pushGeneratedQuestion` 的门槛一致：有选项、答案是合法下标 */
export function isUsableSingle(q: QuizQuestion | undefined): q is QuizQuestion {
  if (!q || q.type !== 'single' || !Array.isArray(q.options) || q.options.length < 2) return false;
  const a = Array.isArray(q.answer) && q.answer.length === 1 ? q.answer[0] : q.answer;
  return typeof a === 'number' && Number.isInteger(a) && a >= 0 && a < q.options.length;
}

export function poolSize(topic: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM pk_question_pool WHERE topic = ? AND used_at IS NULL AND created_at >= datetime('now', ?)`)
      .get(poolTopicKey(topic), `-${POOL_TTL_DAYS} days`) as { c: number }
  ).c;
}

/** 取一道现成题（最早入池的先出），排除本局已出过的题干；取到即标记已用 */
export function takePooled(topic: string, excludeStems: ReadonlySet<string> = new Set()): QuizQuestion | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, stem, question FROM pk_question_pool
        WHERE topic = ? AND used_at IS NULL AND created_at >= datetime('now', ?)
        ORDER BY created_at, rowid LIMIT 20`,
    )
    .all(poolTopicKey(topic), `-${POOL_TTL_DAYS} days`) as Array<{ id: string; stem: string; question: string }>;
  for (const r of rows) {
    if (excludeStems.has(r.stem)) continue;
    // 条件更新防并发：两个房间同时取到同一行时，只有一个 changes=1
    if (db.prepare(`UPDATE pk_question_pool SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(r.id).changes !== 1) continue;
    try {
      const q = JSON.parse(r.question) as QuizQuestion;
      if (isUsableSingle(q)) return q;
    } catch {
      /* 坏行已标记用过，继续下一条 */
    }
  }
  return null;
}

export function addToPool(topic: string, q: QuizQuestion): void {
  getDb()
    .prepare('INSERT INTO pk_question_pool (id, topic, stem, question) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), poolTopicKey(topic), String(q.question), JSON.stringify(q));
}

/** 把一个主题补到 `POOL_TARGET`；返回新入池题数。`gen` 可注入（测试） */
export async function refillPool(
  topic: string,
  gen: (topic: string) => Promise<QuizQuestion | undefined> = defaultGen,
): Promise<number> {
  getDb().prepare(`DELETE FROM pk_question_pool WHERE created_at < datetime('now', ?)`).run(`-${POOL_TTL_DAYS} days`);
  let added = 0;
  const have = new Set(
    (getDb().prepare('SELECT stem FROM pk_question_pool WHERE topic = ? AND used_at IS NULL').all(poolTopicKey(topic)) as Array<{ stem: string }>).map((r) => r.stem),
  );
  for (let i = 0; i < MAX_ATTEMPTS && poolSize(topic) < POOL_TARGET; i += 1) {
    const q = await gen(topic).catch(() => undefined);
    if (!isUsableSingle(q) || have.has(String(q.question))) continue;
    addToPool(topic, q);
    have.add(String(q.question));
    added += 1;
  }
  return added;
}

async function defaultGen(topic: string): Promise<QuizQuestion | undefined> {
  // 与 runAiQuiz 的实时出题完全同参：联网 + 盲解验算（对战题的质量门不因为预生成而放宽）
  const payload = await generateQuiz(topic, undefined, PK_QUIZ_MIX, undefined, undefined, true, null, true);
  return payload?.questions.find((x) => x.type === 'single');
}

export function requestRefill(topic: string): void {
  if (!jobWorkerRunning() || !topic.trim()) return;
  if (poolSize(topic) >= POOL_TARGET) return;
  dispatchJob({ kind: PK_PREGEN_JOB, ownerId: null, payload: { topic }, dedupeKey: `pk.pregen:${poolTopicKey(topic)}` });
}

let wired = false;
export function wireQuestionPool(): void {
  if (wired) return;
  wired = true;
  registerJobHandler(PK_PREGEN_JOB, '对战题预生成', async (payload) => {
    const topic = typeof (payload as { topic?: unknown })?.topic === 'string' ? (payload as { topic: string }).topic : '';
    if (topic) await refillPool(topic);
  });
}
