/**
 * routes/study-flow 端到端（supertest，同 notes.test.ts 手法）。
 * 钉四件事：定义 CRUD 的状态码口径；未接执行器时推进**如实 409 而非静默**；
 * 注入 fake 执行器后能整条走通；知识图接口——尤其**路由强制 origin='user'**
 * （不让客户端把 AI 抽取的边伪装成用户确认的，否则 origin 的可信分层就废了）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-studyflow-route-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { registerExecutor, clearExecutorsForTest } = await import('../learning/flow-registry.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const post = (url: string, body?: Record<string, unknown>) =>
  request(app).post(url).set('Origin', origin).send(body ?? {});
const put = (url: string, body: Record<string, unknown>) =>
  request(app).put(url).set('Origin', origin).send(body);

afterAll(() => closeDb());

const defBody = {
  name: '精读一条词条',
  steps: [
    { id: 's1', kind: 'explain', params: { topic: '虚拟语气' } },
    { id: 's2', kind: 'quiz', params: { topic: '虚拟语气' } },
  ],
  edges: [{ fromStepId: 's1', toStepId: 's2' }],
};

async function makeDef(): Promise<string> {
  const res = await post('/api/study-flow/defs', defBody).expect(201);
  return res.body.id as string;
}

describe('学习流 — 步骤注册表端点', () => {
  it('GET /steps 返回七种步骤类型，并标出哪些还没接执行器', async () => {
    const res = await request(app).get('/api/study-flow/steps').expect(200);
    expect(res.body.maxSteps).toBeGreaterThan(0);
    expect(res.body.steps).toHaveLength(7);
    const kinds = res.body.steps.map((s: { kind: string }) => s.kind);
    // scenario 是 M4 新增（SCENARIO-SPEC §8）：专用执行器，不走脚本化提问
    expect(kinds).toEqual(['explain', 'quiz', 'scenario', 'grade', 'review', 'digest', 'summary']);
    // 本测试进程未跑启动块 ⇒ 执行器未注册 ⇒ 全部 wired:false（正是前端要禁用它们的情形）
    expect(res.body.steps.every((s: { wired: boolean }) => s.wired === false)).toBe(true);
  });
});

describe('学习流 — 定义 CRUD 的状态码口径', () => {
  it('创建 201 → 详情 200 → 更新 200（版本递增）', async () => {
    const id = await makeDef();
    const got = await request(app).get(`/api/study-flow/defs/${id}`).expect(200);
    expect(got.body.steps).toHaveLength(2);
    expect(got.body.version).toBe(1);

    const upd = await put(`/api/study-flow/defs/${id}`, { ...defBody, name: '改过的' }).expect(200);
    expect(upd.body.version).toBe(2);
    expect(upd.body.name).toBe('改过的');
  });

  it('悬空边 ⇒ 400（不留一条跑到一半才炸的流）', async () => {
    const res = await post('/api/study-flow/defs', {
      name: '坏的',
      steps: [{ id: 'a', kind: 'explain', params: { topic: 't' } }],
      edges: [{ fromStepId: 'a', toStepId: 'ghost' }],
    }).expect(400);
    expect(res.body.error).toContain('ghost');
  });

  it('不存在的 id：GET 404 / PUT 404 / DELETE 404（与校验失败 400 分得开）', async () => {
    await request(app).get('/api/study-flow/defs/nope').expect(404);
    await put('/api/study-flow/defs/nope', defBody).expect(404);
    await request(app).delete('/api/study-flow/defs/nope').set('Origin', origin).expect(404);
  });

  it('更新校验不过 ⇒ 400（不是 404）', async () => {
    const id = await makeDef();
    await put(`/api/study-flow/defs/${id}`, { name: 'x', steps: [], edges: [] }).expect(400);
  });

  it('克隆 201 且是新 id', async () => {
    const id = await makeDef();
    const res = await post(`/api/study-flow/defs/${id}/clone`, { name: '我的第二版' }).expect(201);
    expect(res.body.id).not.toBe(id);
    expect(res.body.name).toBe('我的第二版');
  });

  it('删除 200 → 再删 404（幂等语义如实反映）', async () => {
    const id = await makeDef();
    await request(app).delete(`/api/study-flow/defs/${id}`).set('Origin', origin).expect(200);
    await request(app).delete(`/api/study-flow/defs/${id}`).set('Origin', origin).expect(404);
  });
});

describe('学习流 — 运行与推进', () => {
  it('未接执行器时推进 ⇒ 409，错误点名类型（不静默、不假装成功）', async () => {
    clearExecutorsForTest();
    const id = await makeDef();
    const run = await post('/api/study-flow/runs', { defId: id }).expect(201);
    expect(run.body.sessionId).toBeTruthy(); // 未绑定会话时自动建一个

    const adv = await post(`/api/study-flow/runs/${run.body.id}/advance`).expect(409);
    expect(adv.body.error).toContain('explain');
    expect(adv.body.error).toContain('尚未接入执行器');
  });

  it('注入 fake 执行器后能逐步走通，并在 quiz 步停下等用户', async () => {
    clearExecutorsForTest();
    registerExecutor('explain', async () => ({ output: { fake: true } }));
    registerExecutor('quiz', async () => ({ output: { fake: true }, awaitUser: true, pauseReason: '请先作答' }));

    const id = await makeDef();
    const run = await post('/api/study-flow/runs', { defId: id }).expect(201);
    const runId = run.body.id as string;

    const a1 = await post(`/api/study-flow/runs/${runId}/advance`).expect(200);
    expect(a1.body.executed.kind).toBe('explain');
    expect(a1.body.run.status).toBe('running');

    const a2 = await post(`/api/study-flow/runs/${runId}/advance`).expect(200);
    expect(a2.body.executed.kind).toBe('quiz');
    expect(a2.body.run.status).toBe('paused');
    expect(a2.body.run.pauseReason).toBe('请先作答');

    // 暂停态继续推进 ⇒ 没有下一步 ⇒ 收尾 done
    const a3 = await post(`/api/study-flow/runs/${runId}/advance`).expect(200);
    expect(a3.body.run.status).toBe('done');
    expect(a3.body.note).toBeTruthy();

    // 详情带逐步轨迹与本次产出
    const detail = await request(app).get(`/api/study-flow/runs/${runId}`).expect(200);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.producedNodes).toEqual([]);
  });

  it('不存在的 defId ⇒ 404；不存在的 runId ⇒ 404', async () => {
    await post('/api/study-flow/runs', { defId: 'no-such-def' }).expect(404);
    await post('/api/study-flow/runs/no-such-run/advance').expect(404);
  });
});

describe('学习流 — 知识图接口', () => {
  it('手工加边的 origin 被**路由强制为 user**（客户端自称 ai 也无效）', async () => {
    const a = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: '前置概念' }).expect(201);
    const b = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: '后续概念' }).expect(201);

    const edge = await post('/api/study-flow/graph/edges', {
      fromNodeId: a.body.id,
      toNodeId: b.body.id,
      kind: 'prereq',
      origin: 'ai', // 冒充 AI 抽取 ⇒ 应被忽略
    }).expect(201);
    expect(edge.body.origin).toBe('user');
    expect(edge.body.evidence).toContain('用户手动建立');
  });

  it('边两端必须都已存在 ⇒ 否则 404', async () => {
    const a = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: 'x' }).expect(201);
    await post('/api/study-flow/graph/edges', {
      fromNodeId: a.body.id,
      toNodeId: 'ghost-node',
      kind: 'relates',
    }).expect(404);
  });

  it('邻域查询返回局部子图；节点不存在 ⇒ 404', async () => {
    const a = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: '中心' }).expect(201);
    const b = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: '邻居' }).expect(201);
    await post('/api/study-flow/graph/edges', {
      fromNodeId: a.body.id,
      toNodeId: b.body.id,
      kind: 'relates',
    }).expect(201);

    const nb = await request(app).get(`/api/study-flow/graph/neighborhood/${a.body.id}`).expect(200);
    expect(nb.body.center.id).toBe(a.body.id);
    expect(nb.body.nodes).toHaveLength(2);
    expect(nb.body.edges).toHaveLength(1);
    expect(nb.body.truncated).toBe(false);

    await request(app).get('/api/study-flow/graph/neighborhood/ghost').expect(404);
  });

  it('purge-derived 只删结构推导边，用户手工边留着', async () => {
    const a = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: 'p1' }).expect(201);
    const b = await post('/api/study-flow/graph/nodes', { kind: 'concept', refText: 'p2' }).expect(201);
    const edge = await post('/api/study-flow/graph/edges', {
      fromNodeId: a.body.id,
      toNodeId: b.body.id,
      kind: 'relates',
    }).expect(201);

    const purged = await post('/api/study-flow/graph/purge-derived').expect(200);
    expect(purged.body.removed).toBe(0);

    await request(app).delete(`/api/study-flow/graph/edges/${edge.body.id}`).set('Origin', origin).expect(200);
    await request(app).delete(`/api/study-flow/graph/edges/${edge.body.id}`).set('Origin', origin).expect(404);
  });

  it('写接口吃跨源闸门（无合法 Origin 的 POST 被拒）', async () => {
    await request(app).post('/api/study-flow/graph/nodes').send({ kind: 'concept', refText: 'x' }).expect(403);
  });
});
