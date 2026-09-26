/**
 * routes/quiz-tenancy — **M2d-3 其余表归主**的端到端（契约 `docs/TENANCY-SPEC.md` §8.2，迁移 v33）。
 *
 * ★ 这批与 M2d-1 性质不同：`quiz_*` 的主键全是**全局唯一 uuid**，天然不撞键 ⇒ 加列即可。
 *   要消灭的洞只有一个形状：**读侧不带归属 ⇒ A 能看见/删到 B 的题库**。
 * ★ 2026-09-25：`flow_*`/`knowledge_*` 的归主段随「学习流＋知识图」功能整体下线而删除
 *   （批次 K；铁律口径对将来的每张新表仍然成立）。
 * ★ 2026-09-25 同批：`quiz_notes` 的归主段随「刷题笔记」下线删除——那张表不再有读写方，
 *   等 v45 DROP，本文件不留空壳用例。
 *
 * ★ 三条锁的口径（照抄 terms-tenancy 的铁律）：
 *   ① **"不串"要用"另一人拿到空"来断言**，不能只断言"不含 A 的那条"（值相等时偶然通过）；
 *   ② **跨用户按 id 取行必须 404/空**——不向别人确认 id 存在（同 M2a 口径）；
 *   ③ **孤儿行（owner_id=''）对登录用户不可见**，但未登录（本地单人模式）仍可见——
 *     「看到的就是自己全部历史」没有被破坏（契约 §9 第 5 条）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { boot } from '../testing/http.js';

const { getDb, closeDb, signUp, req } = await boot('routes-quiz-tcy');
const { saveQuiz } = await import('../learning/quiz.js');

const { cookie: cookieA, id: idA } = await signUp('qa@example.com');
const { cookie: cookieB } = await signUp('qb@example.com');
const quizA = {
  title: 'A 的题组',
  questions: [{ type: 'single' as const, question: 'Q', options: ['a', 'b'], answer: [0] }],
};

beforeEach(() => {
  const db = getDb();
  for (const t of ['quiz_bank', 'quiz_stats']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterAll(() => {
  closeDb();
});

describe('quiz_bank 归主（v33）', () => {
  it('A 存的题组：A 的 bank 列表可见，B 的列表是空的（不是"不含那条"，是长度 0）', async () => {
    saveQuiz(quizA, 'ai', idA);
    expect((await req.get('/api/quiz/bank', cookieA)).body).toHaveLength(1);
    expect((await req.get('/api/quiz/bank', cookieB)).body).toHaveLength(0);
  });

  it('B 按 id 直接取 A 的题组 → 404（不向跨用户请求确认 id 存在）', async () => {
    const quizId = saveQuiz(quizA, 'ai', idA);
    expect((await req.get(`/api/quiz/bank/${quizId}`, cookieB)).status).toBe(404);
    expect((await req.get(`/api/quiz/bank/${quizId}`, cookieA)).status).toBe(200);
  });

  it('B 删 A 的题组：响应仍 ok（幂等语义），★ 但库里那行必须还在——状态码在这里证明不了任何事', async () => {
    const quizId = saveQuiz(quizA, 'ai', idA);
    expect((await req.delete(`/api/quiz/bank/${quizId}`, cookieB)).body).toEqual({ ok: true });
    const row = getDb().prepare(`SELECT COUNT(*) AS c FROM quiz_bank WHERE id = ?`).get(quizId) as { c: number };
    expect(row.c).toBe(1);
    expect((await req.delete(`/api/quiz/bank/${quizId}`, cookieA)).body).toEqual({ ok: true });
    const after = getDb().prepare(`SELECT COUNT(*) AS c FROM quiz_bank WHERE id = ?`).get(quizId) as { c: number };
    expect(after.c).toBe(0);
  });

});

