/**
 * routes/fork 端到端（supertest，同 `speech.test.ts` 手法）。
 *
 * 钉五件事：① 未归一的 body 只该变 **400** 不该变 500；② 不存在的会话 **404**（且不泄露 id 存在性）；
 * ③ 成功的响应形状（`FollowUpResult`）与**真落库**（`forked_from_id` + `forked_term` + 标题）；
 * ④ 首问**真的成为该会话的第一条 user 消息**（不是服务端影子状态）；
 * ⑤ ★ 标题**不会被 flow 的「首句当标题」逻辑冲掉**——这是最容易在日后回归里被踩掉的一条。
 *
 * ★ ⑤ 为什么必须单独钉：`chat/flow.ts` 里有一条「title 还是默认值就用首句覆盖」的逻辑，
 *   而首问正文是一整段带摘要的 prompt。`createFollowUpSession` 若不显式给标题、
 *   或日后有人把它改成默认值，会话标题就会变成半截 prompt —— 而那**不会报任何错**。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fork-test-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

const createSession = async (): Promise<string> => {
  const res = await request(app).post('/api/sessions').set('Origin', origin).send({});
  return res.body.id as string;
};
const fork = (id: string, body: unknown) =>
  request(app).post(`/api/sessions/${id}/fork`).set('Origin', origin).send(body as object);

interface SessionRow {
  title: string;
  forked_from_id: string | null;
  forked_term: string | null;
}
const sessionRow = (id: string): SessionRow | undefined =>
  getDb().prepare('SELECT title, forked_from_id, forked_term FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined;

/** 取会话里 role='user' 的消息正文（首问应当就在其中） */
const userMessages = (id: string): string[] =>
  (
    getDb().prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid`).all(id) as Array<{
      content: string;
    }>
  ).map((r) => r.content);

/** 轮询等待（生成是 fire-and-forget 的，落库发生在响应之后） */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待条件超时');
}

beforeEach(() => {
  // 每个用例自带一条干净会话，避免标题/消息互相污染
  getDb().prepare('DELETE FROM messages').run();
  getDb().prepare('DELETE FROM sessions').run();
});

afterAll(() => closeDb());

describe('POST /api/sessions/:id/fork（向 AI 追问）', () => {
  it('会话不存在 → 404', async () => {
    const res = await fork('s-nope', { term: '闭包' }).expect(404);
    expect(res.body.error).toBeTruthy();
  });

  it('★ 归属断言在归一之前：不存在的会话 + 超长 term ⇒ 404 而非 400（不泄露 id 存在性）', async () => {
    await fork('s-nope', { term: 'x'.repeat(999) }).expect(404);
  });

  it('body 不是对象（数组）→ 400', async () => {
    const id = await createSession();
    const res = await fork(id, []).expect(400);
    expect(res.body.error).toContain('对象');
  });

  it('缺 term → 400；term 超长 → 400（拒绝而不截断）', async () => {
    const id = await createSession();
    await fork(id, {}).expect(400);
    await fork(id, { term: '   ' }).expect(400);
    const res = await fork(id, { term: 'x'.repeat(121) }).expect(400);
    expect(res.body.error).toContain('过长');
  });

  it('★ 成功：201 + 形状正确 + 真落库（forked_from_id / forked_term / 追问标题）', async () => {
    const parent = await createSession();
    const res = await fork(parent, { term: '闭包' }).expect(201);
    expect(res.body).toMatchObject({
      forkedFromId: parent,
      term: '闭包',
      title: '追问：闭包',
      summarySource: 'none', // 父会话一条消息都没有 ⇒ 如实留空
    });
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).not.toBe(parent);

    const row = sessionRow(res.body.sessionId);
    expect(row?.forked_from_id).toBe(parent);
    expect(row?.forked_term).toBe('闭包');
    expect(row?.title).toBe('追问：闭包');
  });

  it('★ 响应不带 prompt（首问正文走消息表，不造第二个真相源）', async () => {
    const parent = await createSession();
    const res = await fork(parent, { term: '闭包' }).expect(201);
    expect(res.body).not.toHaveProperty('prompt');
  });

  it('★ 首问真的落库成第一条 user 消息，且标题不被「首句当标题」逻辑冲掉', async () => {
    const parent = await createSession();
    const child = (await fork(parent, { term: '闭包', question: '它和柯里化什么关系？' }).expect(201)).body
      .sessionId as string;

    await until(() => userMessages(child).length > 0);
    const first = userMessages(child)[0] ?? '';
    expect(first).toContain('闭包');
    expect(first).toContain('它和柯里化什么关系？');

    // 生成过程会跑一段（本测试环境没有配 provider，会以「没有可用服务商」收口），
    // 但无论怎么收口，标题都该保持 createFollowUpSession 给的那个
    await until(() => sessionRow(child)?.title !== '新对话');
    expect(sessionRow(child)?.title).toBe('追问：闭包');
  });

  it('★ 新会话立刻出现在会话列表里（前端切过去后侧栏要能看到它）', async () => {
    const parent = await createSession();
    const child = (await fork(parent, { term: '闭包' }).expect(201)).body.sessionId as string;
    const list = await request(app).get('/api/sessions').set('Origin', origin).expect(200);
    expect((list.body as Array<{ id: string }>).map((s) => s.id)).toContain(child);
  });

  it('写操作无 Origin → 403（与其余写接口同一道闸门）', async () => {
    const parent = await createSession();
    await request(app).post(`/api/sessions/${parent}/fork`).send({ term: '闭包' }).expect(403);
  });
});
