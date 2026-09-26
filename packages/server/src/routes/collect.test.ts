/**
 * routes/quiz 的 collect 两端点（契约 RESOURCE-SPEC §7 T2）。
 * 钉四件事：preview 永不落库；commit 走服务端复校验后以 source='collect' 入库；
 * no-model 真因走 502 文案通道；写操作照过跨源闸门。
 * 手法同 document.test.ts：临时 SB_DATA_DIR + supertest + 只桩 collectQuiz（normalizeCollectedQuiz 用真实现）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import type { CollectReport } from '@sb/shared';

const { app, request, getDb, closeDb } = await boot('collect-route-test');
const origin = TEST_ORIGIN;

const stub = vi.hoisted(() => ({
  calls: [] as string[],
  mode: 'ok' as 'ok' | 'no-model',
}));

vi.mock('../learning/collect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/collect.js')>()),
  collectQuiz: async (topic: string, report: CollectReport) => {
    stub.calls.push(topic);
    report.queries = [`${topic} 练习题 答案`, `${topic} 题库`];
    if (stub.mode === 'no-model') {
      report.failure = 'no-model';
      return { report, candidates: [] };
    }
    report.pages = [{ url: 'https://q.test/a', title: '题集页', fetched: true }];
    report.total = 2;
    report.accepted = 1;
    report.rejected = 1;
    return {
      report,
      candidates: [
        {
          question: { type: 'single', question: '牛顿第二定律的表达式是？', options: ['F=ma', 'F=mv'], answer: [0], source: { kind: 'collect', title: '题集页', url: 'https://q.test/a' } },
          ok: true,
        },
        {
          question: { type: 'single', question: '疑似编制的题目内容较长' },
          ok: false,
          reason: '题干未在页面原文命中',
        },
      ],
    };
  },
}));

const bankCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM quiz_bank').get() as { n: number }).n;

beforeAll(() => {
  stub.calls.length = 0;
});

afterAll(() => closeDb());

describe('POST /api/quiz/collect/preview', () => {
  it('无 Origin → 403（写操作吃同一套跨源闸门）', async () => {
    await request(app).post('/api/quiz/collect/preview').send({ topic: '二重积分' }).expect(403);
  });

  it('缺 topic → 400，且管道根本没被调用', async () => {
    const before = stub.calls.length;
    await request(app).post('/api/quiz/collect/preview').set('Origin', origin).send({}).expect(400);
    expect(stub.calls.length).toBe(before);
  });

  it('★ 正常路径回 report+candidates，且 quiz_bank 行数分毫不动（preview 永不落库）', async () => {
    const n0 = bankCount();
    const res = await request(app)
      .post('/api/quiz/collect/preview')
      .set('Origin', origin)
      .send({ topic: '牛顿定律' })
      .expect(200);
    expect(res.body.report.accepted).toBe(1);
    expect(res.body.report.queries[0]).toContain('牛顿定律');
    expect(res.body.candidates).toHaveLength(2);
    expect(bankCount()).toBe(n0);
  });

  it('no-model 真因 → 502 且文案指向设置页（不混进「可重试」）', async () => {
    stub.mode = 'no-model';
    const res = await request(app)
      .post('/api/quiz/collect/preview')
      .set('Origin', origin)
      .send({ topic: '虚拟语气' })
      .expect(502);
    expect(res.body.error).toContain('设置');
    stub.mode = 'ok';
  });
});

describe('POST /api/quiz/collect/commit', () => {
  const good = { type: 'single', question: '牛顿第二定律的表达式是？', options: ['F=ma', 'F=mv'], answer: [0], source: { kind: 'collect', title: '题集页', url: 'https://q.test/a' } };

  it('合法题组入库：source=collect 落 quiz_bank，GET /bank 原样透传', async () => {
    const res = await request(app)
      .post('/api/quiz/collect/commit')
      .set('Origin', origin)
      .send({ title: '牛顿定律（搜集）', questions: [good] })
      .expect(200);
    expect(res.body.count).toBe(1);
    const row = getDb().prepare('SELECT source, title FROM quiz_bank WHERE id = ?').get(res.body.quizId) as { source: string; title: string };
    expect(row.source).toBe('collect');
    const list = await request(app).get('/api/quiz/bank').set('Origin', origin).expect(200);
    const item = list.body.find((b: { id: string }) => b.id === res.body.quizId);
    expect(item.source).toBe('collect');
  });

  it('★ 客户端夹带的坏题逐题丢弃、只落复校验通过者（不信 ok 标记）', async () => {
    const res = await request(app)
      .post('/api/quiz/collect/commit')
      .set('Origin', origin)
      .send({ title: '混批', questions: [good, { type: 'single', question: '缺答案的题也够长够长够长', options: ['a', 'b'] }] })
      .expect(200);
    expect(res.body.count).toBe(1);
  });

  it('全部不合格 → 400 且零落库', async () => {
    const n0 = bankCount();
    await request(app)
      .post('/api/quiz/collect/commit')
      .set('Origin', origin)
      .send({ questions: [{ type: 'single', question: 'x'.repeat(30) }] })
      .expect(400);
    expect(bankCount()).toBe(n0);
  });

  it('无 Origin → 403（commit 同样过闸门）', async () => {
    await request(app).post('/api/quiz/collect/commit').send({ questions: [good] }).expect(403);
  });
});
