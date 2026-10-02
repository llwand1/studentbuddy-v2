/**
 * routes/document 端到端（supertest，同 index.test.ts 手法）。
 * 钉三件事：写操作照样过跨源闸门；接口永不回显正文；会话绑定语义（不存在即 404）。
 * ★ 2026-10-02 增 `POST /api/doc/url`（网页资料，DOC-RAG-SPEC §10）：域层逻辑的锁在
 *   `learning/doc-url.test.ts`，本文件只钉**路由层**那几件——闸门顺序、状态码透传、
 *   正文不回显，以及它落库之后两条回退链（出题 / 抽词条）确实吃到了网页正文。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-doc-route-test-'));

// 网页资料要出网：DNS 固定解析到公网地址，fetch 逐例打桩（不碰真实网络）
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
let sid = '';

// 出题/抽词的回退路径只关心「什么文本送到了域函数手里」，故桩掉两个学习域
const learnStub = vi.hoisted(() => ({
  quiz: [] as Array<{ topic: string; material?: string }>,
  extract: [] as string[],
}));

// 只桩 generateQuiz，其余（含题型配比读写）用真实现——否则新增导出会静默让路由 500
vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/quiz.js')>()),
  generateQuiz: async (topic: string, material?: string) => {
    learnStub.quiz.push({ topic, material });
    return null; // 返回 null 让路由走 502，本文件不断言出题结果
  },
}));

// 真题优先缺省开（QUIZ-TIER-SPEC §4）会并行发起搜集；本文件只断言材料回退，搜集侧打桩免得碰网
vi.mock('../learning/collect.js', () => ({
  collectQuiz: async (_topic: string, report: unknown) => ({ report, candidates: [] }),
}));

vi.mock('../learning/terms.js', () => ({
  listTerms: () => [],
  saveOneTerm: () => ({}),
  saveTerms: () => 0,
  extractTerms: async (text: string) => {
    learnStub.extract.push(text);
    return [];
  },
  removeTerm: () => true,
  updateTerm: () => null,
  getRelevantTerms: () => [],
  countUsage: () => 0,
}));

beforeAll(() => {
  sid = `s-${Math.random().toString(36).slice(2)}`;
  getDb().prepare(`INSERT INTO sessions (id) VALUES (?)`).run(sid);
});

afterAll(() => closeDb());

describe('/api/doc', () => {
  it('POST 无 Origin → 403（文档接口吃同一套跨源闸门）', async () => {
    await request(app).post('/api/doc').send({ sessionId: sid, name: 'a.txt', text: 'x' }).expect(403);
  });

  it('未载入时 GET 回 { doc: null }', async () => {
    const res = await request(app).get(`/api/doc?sessionId=${sid}`).expect(200);
    expect(res.body).toEqual({ doc: null });
  });

  it('缺 sessionId → 400（GET/POST/DELETE 三处都校验）', async () => {
    await request(app).get('/api/doc').expect(400);
    await request(app).post('/api/doc').set('Origin', origin).send({ text: '有正文' }).expect(400);
    await request(app).delete('/api/doc').set('Origin', origin).expect(400);
  });

  it('POST 载入后 GET 只回 meta，正文一次都不回显', async () => {
    const posted = await request(app)
      .post('/api/doc')
      .set('Origin', origin)
      .send({ sessionId: sid, name: '牛顿定律.txt', text: '第三定律：作用力与反作用力' })
      .expect(200);
    expect(posted.body.doc).toEqual({ name: '牛顿定律.txt', chars: '第三定律：作用力与反作用力'.length, truncated: false });

    const got = await request(app).get(`/api/doc?sessionId=${sid}`).expect(200);
    expect(got.body.doc.name).toBe('牛顿定律.txt');
    const raw = JSON.stringify(got.body) + JSON.stringify(posted.body);
    expect(raw).not.toContain('作用力与反作用力');
  });

  it('同会话换资料是整篇替换，pill 跟着换名', async () => {
    const res = await request(app)
      .post('/api/doc')
      .set('Origin', origin)
      .send({ sessionId: sid, name: '惯性.md', text: '一切物体总保持匀速直线运动' });
    expect(res.body.doc.name).toBe('惯性.md');
    const got = await request(app).get(`/api/doc?sessionId=${sid}`);
    expect(got.body.doc.chars).toBe('一切物体总保持匀速直线运动'.length);
  });

  it('超 60k 字符 → truncated true（前端据此明示截断）', async () => {
    const text = '惯'.repeat(60_001);
    const res = await request(app).post('/api/doc').set('Origin', origin).send({ sessionId: sid, name: 'big.md', text });
    expect(res.body.doc).toEqual({ name: 'big.md', chars: 60_001, truncated: true });
  });

  it('空正文 → 400；会话不存在 → 404', async () => {
    await request(app).post('/api/doc').set('Origin', origin).send({ sessionId: sid, name: 'a.txt', text: '  \n ' }).expect(400);
    const res = await request(app).post('/api/doc').set('Origin', origin).send({ sessionId: 'no-such', name: 'a.txt', text: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('会话不存在');
  });

  it('DELETE 后 GET 回到未载入；清不存在的会话 → 404', async () => {
    await request(app).delete(`/api/doc?sessionId=${sid}`).set('Origin', origin).expect(200);
    const got = await request(app).get(`/api/doc?sessionId=${sid}`);
    expect(got.body).toEqual({ doc: null });
    await request(app).delete('/api/doc?sessionId=no-such').set('Origin', origin).expect(404);
  });
});

describe('出题/抽词回退用本会话资料（契约 5.0 §5.1-5）', () => {
  const docText = '自由落体加速度取 10 每二次方秒';

  beforeEach(async () => {
    learnStub.quiz = [];
    learnStub.extract = [];
    await request(app)
      .post('/api/doc')
      .set('Origin', origin)
      .send({ sessionId: sid, name: '重力.md', text: docText })
      .expect(200);
  });

  it('未传 material 时，资料全文作为出题材料送到 generateQuiz', async () => {
    await request(app).post('/api/quiz/generate').set('Origin', origin).send({ sessionId: sid }).expect(502);
    expect(learnStub.quiz).toHaveLength(1);
    expect(learnStub.quiz[0]?.material).toBe(docText);
  });

  it('显式给了 material 则不抢戏，资料不覆盖用户材料', async () => {
    await request(app)
      .post('/api/quiz/generate')
      .set('Origin', origin)
      .send({ sessionId: sid, material: '用户自己的材料' })
      .expect(502);
    expect(learnStub.quiz[0]?.material).toBe('用户自己的材料');
  });

  it('无材料且无会话 → 仍 400（回退不走通时保持原报错）', async () => {
    await request(app).post('/api/quiz/generate').set('Origin', origin).send({}).expect(400);
    expect(learnStub.quiz).toHaveLength(0);
  });

  it('extract 未给 text 时用本会话资料抽词条；给了 text 则用给的', async () => {
    await request(app).post('/api/terms/extract').set('Origin', origin).send({ sourceSessionId: sid }).expect(200);
    expect(learnStub.extract).toEqual([docText]);

    await request(app).post('/api/terms/extract').set('Origin', origin).send({ text: '手动材料', sourceSessionId: sid });
    expect(learnStub.extract[1]).toBe('手动材料');

    const bad = await request(app).post('/api/terms/extract').set('Origin', origin).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('或先为本会话载入资料');
  });

  it('清除资料后回退链断开：extract 无文本又回到 400', async () => {
    await request(app).delete(`/api/doc?sessionId=${sid}`).set('Origin', origin).expect(200);
    await request(app).post('/api/terms/extract').set('Origin', origin).send({ sourceSessionId: sid }).expect(400);
    expect(learnStub.extract).toHaveLength(0);
  });
});

describe('/api/doc/url —— 网页资料（契约 DOC-RAG-SPEC §10）', () => {
  const fetched: string[] = [];

  function mockPage(handler: (url: string) => { text?: string; status?: number; contentType?: string }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        fetched.push(u);
        const r = handler(u);
        const status = r.status ?? 200;
        return {
          ok: status < 400,
          status,
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (r.contentType ?? null) : null) },
          text: async () => r.text ?? '',
          arrayBuffer: async () => {
            const b = new TextEncoder().encode(r.text ?? '');
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          },
        } as unknown as Response;
      }),
    );
  }

  beforeEach(() => {
    fetched.length = 0;
    mockPage(() => ({
      text: '<html><head><title>电化学基础</title></head><body><p>原电池的负极发生氧化反应。</p></body></html>',
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('无 Origin → 403（网页资料吃同一套跨源闸门，不因为是新端点就漏掉）', async () => {
    await request(app).post('/api/doc/url').send({ sessionId: sid, url: 'https://ex.example/a' }).expect(403);
    expect(fetched).toHaveLength(0);
  });

  it('缺 sessionId → 400；缺 url → 400', async () => {
    await request(app).post('/api/doc/url').set('Origin', origin).send({ url: 'https://ex.example/a' }).expect(400);
    await request(app).post('/api/doc/url').set('Origin', origin).send({ sessionId: sid }).expect(400);
  });

  it('★ 会话不是你的 / 不存在 → 404，且**一次网络请求都不发**（不许当抓取跳板）', async () => {
    const res = await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: 'no-such', url: 'https://ex.example/a' });
    expect(res.status).toBe(404);
    // 核心锁：归属闸必须排在出网之前，否则拿个假 sessionId 就能驱动本服务器抓任意网址
    expect(fetched).toHaveLength(0);
  });

  it('载入成功 → 资料名取网页标题，回执带 source，且正文一个字都不回显', async () => {
    const res = await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://chem.example.org/dianhuaxue' })
      .expect(200);

    expect(res.body.doc.name).toBe('电化学基础');
    expect(res.body.doc.chars).toBeGreaterThan(0);
    expect(res.body.doc.truncated).toBe(false);
    expect(res.body.source).toMatchObject({
      url: 'https://chem.example.org/dianhuaxue',
      title: '电化学基础',
      site: 'chem.example.org',
      clipped: false,
    });
    // 与 POST /api/doc 同一条规矩：接口永不回显正文
    expect(JSON.stringify(res.body)).not.toContain('负极发生氧化反应');

    const got = await request(app).get(`/api/doc?sessionId=${sid}`).expect(200);
    expect(got.body.doc.name).toBe('电化学基础');
    expect(JSON.stringify(got.body)).not.toContain('负极发生氧化反应');
  });

  it('状态码按失败种类透传：不是网页 → 415（不是笼统 500）', async () => {
    mockPage(() => ({ contentType: 'application/pdf', text: '%PDF-1.4' }));
    const res = await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://ex.example/a.pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error).toContain('不是网页');
  });

  it('抓取失败不动已载入的资料（载入新的失败了，旧的还在）', async () => {
    await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://chem.example.org/keep' })
      .expect(200);

    mockPage(() => ({ status: 404 }));
    await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://ex.example/gone' })
      .expect(502);

    const got = await request(app).get(`/api/doc?sessionId=${sid}`);
    expect(got.body.doc.name).toBe('电化学基础'); // 没被清掉、也没被换成空的
  });

  it('★ 网页资料落库后，出题回退链吃到的就是这份网页正文（含溯源抬头）', async () => {
    learnStub.quiz = [];
    await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://chem.example.org/dianhuaxue' })
      .expect(200);

    await request(app).post('/api/quiz/generate').set('Origin', origin).send({ sessionId: sid }).expect(502);
    expect(learnStub.quiz).toHaveLength(1);
    const material = learnStub.quiz[0]?.material ?? '';
    expect(material).toContain('原电池的负极发生氧化反应');
    expect(material).toContain('【资料来源：网页快照】'); // 出题也该知道材料是一张快照
  });

  it('DELETE 对网页资料一视同仁（清除后回到未载入）', async () => {
    await request(app)
      .post('/api/doc/url')
      .set('Origin', origin)
      .send({ sessionId: sid, url: 'https://chem.example.org/x' })
      .expect(200);
    await request(app).delete(`/api/doc?sessionId=${sid}`).set('Origin', origin).expect(200);
    const got = await request(app).get(`/api/doc?sessionId=${sid}`);
    expect(got.body).toEqual({ doc: null });
  });
});
