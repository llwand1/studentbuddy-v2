import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, extractReplyPractice, isReplyPracticeRequest } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reply-practice-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { cacheReplyPractice, latestReplyPractice } = await import('../learning/reply-practice.js');
const { tryReplyPracticeTurn } = await import('../chat/reply-practice.js');
const { snapshot } = await import('../chat/sse-bus.js');
const request = (await import('supertest')).default;
afterAll(() => closeDb());
const alice = await createUser('practice-alice@example.com', 'good-password-1', undefined);
const bob = await createUser('practice-bob@example.com', 'good-password-1', undefined);
const cookie = (id: string) => `${AUTH_COOKIE_NAME}=${createSession(id).token}`;
const aliceCookie = cookie(alice.id), bobCookie = cookie(bob.id);
const post = (body: object, auth = aliceCookie) => request(app).post('/api/quiz/from-reply').set('Origin', 'http://localhost:5173').set('Cookie', auth).send(body);
const answer = '> [!CORE] 牛顿第二定律\n> 合外力等于质量乘以加速度 F=ma。加速度的方向由合外力决定，不能由速度方向判断。\n\n> [!PITFALL] 方向\n> 速度为零不代表加速度为零。';
let n = 0;
function seed(text = answer): { sessionId: string; messageId: string } {
  const sessionId = `practice-session-${++n}`, messageId = `practice-message-${n}`;
  const db = getDb();
  db.prepare('INSERT INTO sessions(id,title,user_id) VALUES(?,?,?)').run(sessionId, '练习', alice.id);
  db.prepare("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'assistant',?)").run(messageId, sessionId, text);
  cacheReplyPractice(messageId, '解释牛顿第二定律', text);
  return { sessionId, messageId };
}

describe('reply practice: source-backed extraction and real HTTP delivery', () => {
  it('提取核心与误区；代码/SVG 中的假标记不成为题目，参考不公开在提示 metadata 中', async () => {
    const s = seed('```svg\n> [!CORE] 假标题\n<script>not material</script>\n```\n' + answer);
    const q = latestReplyPractice(s.sessionId, alice.id)!;
    expect(q.questions[0]).toMatchObject({ type: 'essay', source: { kind: 'ai' }, tier: 'basic' });
    expect(q.questions[0]!.question).toContain('牛顿第二定律');
    expect(q.questions[0]!.answer).toContain('速度为零不代表');
    expect(JSON.stringify(q)).not.toContain('not material');
    const history = await request(app).get(`/api/sessions/${s.sessionId}/messages`).set('Cookie', aliceCookie).expect(200);
    expect(history.body[0].replyPractice).toEqual({ messageId: s.messageId, title: q.title });
    expect(Object.keys(history.body[0].replyPractice).sort()).toEqual(['messageId', 'title']);
  });

  it('优先使用真实自检问题；推导题保留原题条件与独立步骤/表格', () => {
    const core = extractReplyPractice('解释牛顿第二定律', answer + '\n> [!CHECK] 自检\n> 当速度为零时，合外力一定为零吗？')!;
    expect(core.questions[0]!.question).toContain('合外力一定为零吗');
    const route = extractReplyPractice('求解 2(x−3)+4=14，并给出步骤', '> [!ROUTE] 方程求解\n> 先用分配律展开括号，再合并常数，通过等式的性质得到未知数。\n\n> [!STEP] 1. 展开\n\n2x−6+4=14\n\n| 步骤 | 结果 |\n|---|---|\n| 移项 | 2x=16 |\n\n> [!CHECK] 代回\n> x=8 时左边为 14，符合原等式。')!;
    expect(route.questions[0]!.question).toContain('2(x−3)+4=14');
    expect(route.questions[0]!.answer).toContain('2x=16');
    expect(route.questions[0]!.answer).toContain('x=8');
  });

  it('寒暄、短卡、停止/中断、过大回复不显示已提炼；否定/多题/新主题/真题/题型不误截', () => {
    for (const raw of ['你好', '> [!CORE] 简述\n> 暂时没有结论', answer + '（已停止）', answer + '（生成中断）', answer.repeat(1000)]) {
      expect(extractReplyPractice('解释一下', raw)).toBeNull();
    }
    for (const text of ['考我', '出题', '来一道练习题', '根据刚才的讲解出一道题', '练习一下']) expect(isReplyPracticeRequest(text)).toBe(true);
    for (const text of ['不要出题', '考我五道', '出3道题', '出一道选择题', '出高考真题', '出Java题', '别考我', '你会出题吗']) expect(isReplyPracticeRequest(text)).toBe(false);
  });

  it('真实端点即时出卡、历史还原和作答记录；别人/删会话/非法输入不能取题', async () => {
    const s = seed();
    await post({ sessionId: s.sessionId }, bobCookie).expect(404);
    await post({ sessionId: {} }).expect(400);
    await post({ sessionId: 'missing' }).expect(404);
    const result = await post({ sessionId: s.sessionId }).expect(200);
    expect(result.body.available).toBe(true);
    const rows = getDb().prepare('SELECT content FROM messages WHERE session_id=? ORDER BY rowid').all(s.sessionId) as Array<{ content: string }>;
    expect(rows[1]!.content).toContain(`[QUIZ]`);
    expect(rows[1]!.content).toContain(result.body.quizId);
    await request(app).post(`/api/quiz/${result.body.quizId}/attempts`).set('Origin', 'http://localhost:5173').set('Cookie', aliceCookie)
      .send({ questionIndex: 0, verdict: 'review', answer: '加速度由合外力决定' }).expect(200);
    getDb().prepare("UPDATE sessions SET deleted_at=datetime('now') WHERE id=?").run(s.sessionId);
    await post({ sessionId: s.sessionId }).expect(404);
  });

  it('最新回答未提炼时不偷用旧题；源文改变失效；删除源回答级联删除缓存', async () => {
    const s = seed();
    getDb().prepare("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'user','另一个新问题但回答失败')").run('failed-' + n, s.sessionId);
    expect((await post({ sessionId: s.sessionId }).expect(200)).body.available).toBe(false);
    getDb().prepare('DELETE FROM messages WHERE id=?').run('failed-' + n);
    getDb().prepare("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'assistant','好的')").run('newer-' + n, s.sessionId);
    expect((await post({ sessionId: s.sessionId }).expect(200)).body.available).toBe(false);
    getDb().prepare('DELETE FROM messages WHERE id=?').run('newer-' + n);
    getDb().prepare('UPDATE messages SET content=? WHERE id=?').run('changed', s.messageId);
    expect(latestReplyPractice(s.sessionId, alice.id)).toBeNull();
    getDb().prepare('DELETE FROM messages WHERE id=?').run(s.messageId);
    expect(getDb().prepare('SELECT 1 FROM reply_practice WHERE message_id=?').get(s.messageId)).toBeUndefined();
  });

  it('直接“考我”通过同一会话流出卡；不触发新模型或碰 GrillMe/新主题路径', () => {
    const s = seed();
    expect(tryReplyPracticeTurn({ sessionId: s.sessionId, text: '考我', ownerId: bob.id })).toBeNull();
    expect(tryReplyPracticeTurn({ sessionId: s.sessionId, text: '考我', ownerId: alice.id, grillMe: true })).toBeNull();
    expect(tryReplyPracticeTurn({ sessionId: s.sessionId, text: '出3道题', ownerId: alice.id })).toBeNull();
    expect(tryReplyPracticeTurn({ sessionId: s.sessionId, text: '考我', ownerId: alice.id })).toEqual({ ok: true });
    const frames = snapshot(s.sessionId);
    expect(frames.map((e) => e.type)).toEqual(['round-start', 'block', 'done']);
    expect(frames.filter((e) => e.type === 'token')).toHaveLength(0);
  });
});
