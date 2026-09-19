/**
 * routes/quiz-tenancy — **M2d-3 其余表归主**的端到端（契约 `docs/TENANCY-SPEC.md` §8.2，迁移 v33）。
 *
 * ★ 这批与 M2d-1/M2d-2 性质不同：`quiz_*`/`flow_*`/`knowledge_*` 的主键全是**全局唯一 uuid**，
 *   天然不撞键 ⇒ 加列即可。要消灭的洞只有一个形状：**读侧不带归属 ⇒ A 能看见/删到 B 的题库、
 *   学习流与知识图谱**——其中 `knowledge_node`/`knowledge_edge` 此前**无任何归属过滤**
 *   （M2d-1 普查发现的已上线旧洞，本文件 §「知识图谱」段就是它的收口锁）。
 *
 * ★ 三条锁的口径（照抄 terms-tenancy 的铁律）：
 *   ① **"不串"要用"另一人拿到空"来断言**，不能只断言"不含 A 的那条"（值相等时偶然通过）；
 *   ② **跨用户按 id 取行必须 404/空**——不向别人确认 id 存在（同 M2a 口径）；
 *   ③ **孤儿行（owner_id=''）对登录用户不可见**，但未登录（本地单人模式）仍可见——
 *     「看到的就是自己全部历史」没有被破坏（契约 §9 第 5 条）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-quiz-tcy-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { saveQuiz } = await import('../learning/quiz.js');
const { upsertNoteFromAnswer } = await import('../learning/notes.js');
const { ensureNode } = await import('../learning/knowledge-graph.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<{ cookie: string; id: string }> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return { cookie: `${AUTH_COOKIE_NAME}=${token}`, id: user.id };
}

const req = {
  get: (url: string, cookie = '') => {
    const r = request(app).get(url).set('Origin', origin);
    return cookie ? r.set('Cookie', cookie) : r;
  },
  post: (url: string, cookie: string, body: unknown) =>
    request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body as object),
  delete: (url: string, cookie: string) => request(app).delete(url).set('Origin', origin).set('Cookie', cookie),
};

const { cookie: cookieA, id: idA } = await signUp('qa@example.com');
const { cookie: cookieB } = await signUp('qb@example.com');
const quizA = {
  title: 'A 的题组',
  questions: [{ type: 'single' as const, question: 'Q', options: ['a', 'b'], answer: [0] }],
};

beforeEach(() => {
  const db = getDb();
  for (const t of ['quiz_bank', 'quiz_stats', 'quiz_notes', 'flow_def', 'flow_step', 'flow_edge', 'knowledge_node', 'knowledge_edge']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterAll(() => {
  closeDb();
});

describe('quiz_bank / quiz_notes 归主（v33）', () => {
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

  it('笔记随归属隔离：A 的作答笔记 B 看不见；★ 无主行（owner_id=\'\'）登录用户也看不见', async () => {
    const quizId = saveQuiz(quizA, 'ai', idA);
    upsertNoteFromAnswer(quizId, 0, false, idA, [0]);
    // 直接落一条无主笔记（模拟 v33 之前的历史行）
    getDb()
      .prepare(`INSERT INTO quiz_notes (id, quiz_id, question_index, quiz_title, question_data, correct, owner_id)
                VALUES ('legacy-n', ?, 1, '老题', '{}', 0, '')`)
      .run(quizId);
    expect((await req.get('/api/notes', cookieA)).body).toHaveLength(1);
    expect((await req.get('/api/notes', cookieB)).body).toHaveLength(0);
  });
});

describe('flow_def 归主（v33）', () => {
  it('A 建的学习流：A 列表可见，B 列表为空、按 id 取 → 404', async () => {
    const made = await req.post('/api/study-flow/defs', cookieA, {
      name: 'A 的流',
      steps: [{ id: 's1', kind: 'explain', label: '讲', params: { topic: '闭包' }, position: { x: 0, y: 0 }, orderIndex: 0 }],
      edges: [],
    });
    expect(made.status).toBe(201);
    const defId = (made.body as { id: string }).id;
    expect((await req.get('/api/study-flow/defs', cookieA)).body).toHaveLength(1);
    expect((await req.get('/api/study-flow/defs', cookieB)).body).toHaveLength(0);
    expect((await req.get(`/api/study-flow/defs/${defId}`, cookieB)).status).toBe(404);
  });
});

describe('knowledge_node / knowledge_edge 归主（v33，★ 已上线旧洞收口）', () => {
  it('A 的知识节点：B 的 stats 是零图、邻域查询 → 404——改前 B 能看见 A 的整张图', async () => {
    const node = ensureNode({ kind: 'term', refId: null, refText: 'A 学到的概念', ownerId: idA });
    const statsB = (await req.get('/api/study-flow/graph/stats', cookieB)).body as { nodes: number };
    expect(statsB.nodes).toBe(0);
    const statsA = (await req.get('/api/study-flow/graph/stats', cookieA)).body as { nodes: number };
    expect(statsA.nodes).toBe(1);
    expect((await req.get(`/api/study-flow/graph/neighborhood/${node.id}`, cookieB)).status).toBe(404);
  });
});
