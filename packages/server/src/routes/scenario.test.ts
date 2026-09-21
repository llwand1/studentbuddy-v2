/**
 * routes/scenario 端到端（supertest，同 notes.test.ts 手法）。
 * M1 验收链（契约 docs/SCENARIO-SPEC.md §8）：seed → demo 页（含桥接）→ report 判对/判错 →
 * quiz_stats 出数 → 题库列表按任务数计 → 删套题连带删 demo。另钉白名单 404 与 400 闸门。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scenario-route-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const seed = (body: Record<string, unknown>) =>
  request(app).post('/api/scenario/seed').set('Origin', origin).send(body);

/** 一套最小可玩情景题：两个评分点（choice + state），demo 里调用 SBScenario 上报 */
const demoHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="go">提交</button>
<script>
document.getElementById('go').onclick = function () { SBScenario.report('t-choice', [0, 2]); };
</script></body></html>`;
const tasks = [
  { id: 't-choice', prompt: '选出所有偶数', criteria: { kind: 'choice', answer: [0, 2] } },
  { id: 't-state', prompt: '把开关拨到 on', criteria: { kind: 'state', value: 'on' } },
];

afterAll(() => closeDb());

describe('POST /api/scenario/seed（登记闸门）', () => {
  it('合法输入登记成功，回 quizId + demoId', async () => {
    const res = await seed({ title: '排序情景', html: demoHtml, tasks }).expect(200);
    expect(typeof res.body.quizId).toBe('string');
    expect(typeof res.body.demoId).toBe('string');
  });

  it('评分点无 criteria / tasks 全被丢弃 → 400，且 quiz_bank 零部分落库', async () => {
    await seed({ title: 'x', html: demoHtml, tasks: [{ id: 'a', prompt: '没有标准' }] }).expect(400);
    await seed({ title: 'x', html: demoHtml, tasks: 'nope' }).expect(400);
    const bank = await request(app).get('/api/quiz/bank').set('Origin', origin).expect(200);
    expect(bank.body.filter((b: { title: string }) => b.title === 'x')).toHaveLength(0);
  });

  it('html 缺失 / 超限 → 400', async () => {
    await seed({ title: 'x', tasks }).expect(400);
    await seed({ title: 'x', html: 'a'.repeat(512 * 1024 + 1), tasks }).expect(400);
  });
});

describe('GET /api/scenario/demo/:id（出页 + 桥接注入）', () => {
  it('页面含注入的桥接脚本且 demoId 占位符已被替换', async () => {
    const seeded = await seed({ title: '排序情景2', html: demoHtml, tasks }).expect(200);
    const res = await request(app).get(`/api/scenario/demo/${seeded.body.demoId}`).expect(200);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.text).toContain('window.SBScenario');
    expect(res.text).toContain(`'${seeded.body.demoId}'`);
    expect(res.text).not.toContain('__SB_DEMO_ID__');
    expect(res.text).toContain(demoHtml);
  });

  it('不存在的 demo → 404', async () => {
    await request(app).get('/api/scenario/demo/gone-id').expect(404);
  });
});

describe('GET /api/scenario/by-quiz/:quizId（套题反查 demoId）', () => {
  it('情景题回 demoId；不存在的套题 → 404', async () => {
    const seeded = await seed({ title: '反查', html: demoHtml, tasks }).expect(200);
    const res = await request(app).get(`/api/scenario/by-quiz/${seeded.body.quizId}`).expect(200);
    expect(res.body.demoId).toBe(seeded.body.demoId);
    await request(app).get('/api/scenario/by-quiz/no-such-id').expect(404);
  });
});

describe('POST /api/scenario/report（回传 + 服务端判分）', () => {
  it('判对 → correct:true，quiz_stats 出数；题库列表按任务数计', async () => {
    const seeded = await seed({ title: '判分链', html: demoHtml, tasks }).expect(200);
    const { quizId, demoId } = seeded.body;
    await request(app)
      .post('/api/scenario/report')
      .set('Origin', origin)
      .send({ demoId, taskId: 't-choice', observed: [2, 0] })
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({ ok: true, correct: true, taskIndex: 0 });
      });
    // 集合相等与顺序无关；判错同样落账（attempts 累计、correct 不加）
    await request(app)
      .post('/api/scenario/report')
      .set('Origin', origin)
      .send({ demoId, taskId: 't-state', observed: 'off' })
      .expect(200)
      .expect((res) => expect(res.body.correct).toBe(false));
    const detail = await request(app).get(`/api/quiz/bank/${quizId}`).set('Origin', origin).expect(200);
    expect(detail.body.stats).toEqual([
      expect.objectContaining({ question_index: 0, attempts: 1, correct: 1 }),
      expect.objectContaining({ question_index: 1, attempts: 1, correct: 0 }),
    ]);
    const bank = await request(app).get('/api/quiz/bank').set('Origin', origin).expect(200);
    expect(bank.body.find((b: { id: string }) => b.id === quizId)).toMatchObject({ count: 2, source: 'scenario' });
  });

  it('taskId 不在该套题白名单 → 404；demo 不存在 → 404；缺参 → 400', async () => {
    const seeded = await seed({ title: '白名单', html: demoHtml, tasks }).expect(200);
    const { quizId, demoId } = seeded.body;
    await request(app)
      .post('/api/scenario/report')
      .set('Origin', origin)
      .send({ demoId, taskId: 'evil', observed: [0] })
      .expect(404);
    await request(app)
      .post('/api/scenario/report')
      .set('Origin', origin)
      .send({ demoId: 'no-such-demo', taskId: 't-choice', observed: [0] })
      .expect(404);
    await request(app).post('/api/scenario/report').set('Origin', origin).send({ taskId: 't-choice' }).expect(400);
    // 白名单外的上报不产生任何统计行
    const detail = await request(app).get(`/api/quiz/bank/${quizId}`).set('Origin', origin).expect(200);
    expect(detail.body.stats).toHaveLength(0);
  });

  it('删套题连带删 demo：bank DELETE 后 report → 404、demo 页 → 404、库里的 demo 行真的没了', async () => {
    const seeded = await seed({ title: '级联删', html: demoHtml, tasks }).expect(200);
    const { quizId, demoId } = seeded.body;
    await request(app).delete(`/api/quiz/bank/${quizId}`).set('Origin', origin).expect(200);
    await request(app)
      .post('/api/scenario/report')
      .set('Origin', origin)
      .send({ demoId, taskId: 't-choice', observed: [0] })
      .expect(404);
    await request(app).get(`/api/scenario/demo/${demoId}`).expect(404);
    // ★ 上面两条 404 证不了级联——bank 行一删，归属 JOIN 就让 demo 页与 report 都 404（哪怕 demo 行还在）。
    //   级联真删只能看库：不然「删套题留下死 demo 行」会一路静默，孤儿行只增不减。
    const { getDb } = await import('../storage/db.js');
    const left = getDb().prepare('SELECT COUNT(*) AS n FROM scenario_demo WHERE id = ?').get(demoId) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('POST /api/scenario/generate（M2 出题引擎入口）', () => {
  it('topic / material 全缺 → 400', async () => {
    await request(app).post('/api/scenario/generate').set('Origin', origin).send({}).expect(400);
  });

  it('测试环境没配出题模型 → 502 且错误指名「角色模型绑定」（真因 no-model，不假装可解析重试）', async () => {
    const res = await request(app)
      .post('/api/scenario/generate')
      .set('Origin', origin)
      .send({ topic: '电工安全' })
      .expect(502);
    expect(res.body.error).toContain('角色模型绑定');
    expect(res.body.report.failure).toBe('no-model');
  });
});

describe('POST /api/scenario/generate — 聊天流接线（M3）', () => {
  it('带 sessionId 且没配模型：502 且**零聊天消息落库**（不发空块、不写历史）', async () => {
    const sid = 'sess-sgen-' + String(Date.now());
    await request(app)
      .post('/api/scenario/generate')
      .set('Origin', origin)
      .send({ topic: '电工安全', sessionId: sid })
      .expect(502);
    const { getDb } = await import('../storage/db.js');
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sid) as { n: number }).n;
    expect(n).toBe(0);
  });
});
