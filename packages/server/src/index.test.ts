import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试隔离：先指向临时 DATA_DIR 再动态 import（静态 import 会提前建真实库）
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-test-'));
const { app } = await import('./index.js');
const request = (await import('supertest')).default;

describe('server 骨架与安全（v1 回归语义）', () => {
  it('GET /api/status 返回 StatusResponse 契约', async () => {
    const res = await request(app).get('/api/status').expect(200);
    expect(res.body.version).toEqual(expect.any(String));
    expect(typeof res.body.hasProviders).toBe('boolean');
  });

  it('GET /api/health 健康检查', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('写操作无 Origin → 403（防恶意网页跨源调用，v1 SEC-09 回归）', async () => {
    await request(app).post('/api/chat/send').send({ sessionId: 's', text: 'x' }).expect(403);
  });

  it('安全响应头齐备', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('未知路由 → 404 JSON', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('合法 Origin 写操作放行（localhost 白名单）', async () => {
    const res = await request(app)
      .post('/api/chat/send')
      .set('Origin', 'http://localhost:5173')
      .send({ sessionId: 'no-session', text: 'hi' });
    // 会话不存在时 flow 仍会落库（外键由 messages 表触发）——此处只验证不 403
    expect(res.status).not.toBe(403);
  });
});

describe('搜索 key 接口（密钥永不回显，v2 P1）', () => {
  const origin = 'http://localhost:5173';

  /**
   * ★ 密钥加密的**一次性热身**（2026-09-14 实测补）。
   *
   * 本组用例都要落 key，而落 key 走 AES-256-GCM，主密钥由 `storage/crypto.ts` 的
   * `initCrypto()` **冷启一个 powershell.exe 子进程调 DPAPI** 来包（Windows）。
   * 实测拆解（同轮探针）：
   *   ① 开隔离库 + 跑完全部迁移（v1~v15）＝ **16 ms**；
   *   ② **首次** `encryptSecret`（PowerShell 冷启动 + `Add-Type -AssemblyName System.Security`）＝ **5519 ms**；
   *   ③ 第二次 ＝ **1 ms**。
   * 也就是说这 5.5s 与 DB/业务无关，纯是 OS 级一次性成本；不热身的话它会**压在该组第一条真落库的用例上**，
   * 恰好越过 vitest 默认 5000ms 超时（2026-09-14 实际红过：「保存后 GET 只回已配置状态」）。
   * ⇒ 把它显式提到这里，给足预算（30s），用例本身恢复成「只测行为、不测 PowerShell 冷启动」。
   *   这不是放宽断言，是把**归因搞清之后**把成本放到该付它的地方。
   */
  beforeAll(async () => {
    const { encryptSecret } = await import('./storage/crypto.js');
    encryptSecret('warmup-not-a-real-key');
  }, 30_000);

  beforeEach(() => {
    // 库优先于环境变量（B-020 之后）；但这里的清理动机不变——env 是兜底位，
    // 留着真机上那把平台 key，"未配置"断言照样会脆。
    for (const k of ['EXA_API_KEY', 'TAVILY_API_KEY', 'ZHIPU_API_KEY']) delete process.env[k];
  });

  it('写操作无 Origin → 403', async () => {
    await request(app).put('/api/settings/search-keys').send({ exa: 'sk-should-be-blocked' }).expect(403);
  });

  it('保存后 GET 只回已配置状态，明文与密文都不出接口', async () => {
    const saved = await request(app).put('/api/settings/search-keys').set('Origin', origin).send({ exa: 'sk-secret-abcdef' });
    expect(saved.status).toBe(200);
    expect(saved.body.configured).toEqual({ exa: true, tavily: false, zhipu: false });

    const got = await request(app).get('/api/settings/search-keys').expect(200);
    expect(got.body.configured.exa).toBe(true);
    const raw = JSON.stringify(got.body) + JSON.stringify(saved.body);
    expect(raw).not.toContain('sk-secret-abcdef');
    expect(raw).not.toContain('enc:v1:');
  });

  it('空串即删除该 provider 的 key', async () => {
    await request(app).put('/api/settings/search-keys').set('Origin', origin).send({ exa: '' });
    const res = await request(app).get('/api/settings/search-keys');
    expect(res.body.configured.exa).toBe(false);
  });

  it('超长 key → 400 且一字不落（先校验后写，杜绝半写）', async () => {
    const res = await request(app)
      .put('/api/settings/search-keys')
      .set('Origin', origin)
      .send({ exa: 'x'.repeat(301), tavily: 'short-ok' });
    expect(res.status).toBe(400);
    const got = await request(app).get('/api/settings/search-keys');
    expect(got.body.configured).toEqual({ exa: false, tavily: false, zhipu: false });
  });

  it('非 string 字段忽略（不被伪造类型写脏库）', async () => {
    await request(app).put('/api/settings/search-keys').set('Origin', origin).send({ exa: 123, tavily: { a: 1 } });
    const res = await request(app).get('/api/settings/search-keys');
    expect(res.body.configured).toEqual({ exa: false, tavily: false, zhipu: false });
  });
});

describe('html 预览通道（CSP sandbox 隔离）', () => {
  const origin = 'http://localhost:5173';

  it('POST 换 id → GET 出页带 sandbox CSP（不含 allow-same-origin），片段补文档壳', async () => {
    const reg = await request(app).post('/api/preview').set('Origin', origin).send({ html: '<b>hi</b>' });
    expect(reg.status).toBe(200);
    const page = await request(app).get(`/api/preview/${reg.body.id}`).expect(200);
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.text).toContain('<!doctype html>');
    expect(page.text).toContain('<b>hi</b>');
  });

  it('预览页 X-Frame-Options 放宽为 SAMEORIGIN（侧栏 iframe 才嵌得进），其它接口仍 DENY', async () => {
    const reg = await request(app).post('/api/preview').set('Origin', origin).send({ html: '<b>hi</b>' });
    const page = await request(app).get(`/api/preview/${reg.body.id}`).expect(200);
    expect(page.headers['x-frame-options']).toBe('SAMEORIGIN');
    const gone = await request(app).get('/api/preview/gone-id').expect(404);
    expect(gone.headers['x-frame-options']).toBe('SAMEORIGIN'); // 失效提示也要能在面板里显示
    const other = await request(app).get('/api/health').expect(200);
    expect(other.headers['x-frame-options']).toBe('DENY');
  });

  it('未知 id → 404 可读提示；非 string / 超 512KB → 400', async () => {
    const miss = await request(app).get('/api/preview/none-here').expect(404);
    expect(miss.text).toContain('预览已失效');
    const badType = await request(app).post('/api/preview').set('Origin', origin).send({ html: 42 });
    expect(badType.status).toBe(400);
    const tooBig = await request(app).post('/api/preview').set('Origin', origin).send({ html: 'x'.repeat(512 * 1024 + 1) });
    expect(tooBig.status).toBe(400);
  });

  it('sandbox 预览页的 Origin: null → 写接口 403 且拿不到 CORS 头（html 通道的前提）', async () => {
    const res = await request(app).post('/api/preview').set('Origin', 'null').send({ html: '<i>x</i>' });
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('历史消息接口（过程卡片唯一的数据来源）', () => {
  it('GET /api/sessions/:id/messages 必须下发 tool_calls / tool_call_id / reasoning / tasks', async () => {
    const { getDb } = await import('./storage/db.js');
    const db = getDb();
    const sid = 'sess-history-fold';
    db.prepare(`INSERT INTO sessions (id, title) VALUES (?, '过程回放')`).run(sid);
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('h-u1', ?, 'user', '搜一下')`).run(sid);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES ('h-a1', ?, 'assistant', '', ?)`,
    ).run(sid, JSON.stringify([{ id: 'c1', name: 'search_web', arguments: '{"query":"新闻"}' }]));
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_call_id) VALUES ('h-t1', ?, 'tool', '结果摘要', 'c1')`,
    ).run(sid);
    // 过程三件套的另一半（v11）：思考链与任务清单同样必须随历史下发，否则重开会话它们就没了
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, reasoning, tasks) VALUES ('h-a2', ?, 'assistant', '正文', ?, ?)`,
    ).run(sid, '先搜索再作答。', JSON.stringify([{ text: '搜索', status: 'done' }]));

    const res = await request(app).get(`/api/sessions/${sid}/messages`).expect(200);
    const rows = res.body as Array<{
      role: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      reasoning: string | null;
      tasks: string | null;
    }>;
    // 工具轮必须原样透传，前端才能把 step 配对折回那条回答上
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(rows[1]?.tool_calls).toContain('search_web');
    expect(rows[2]?.tool_call_id).toBe('c1');
    expect(rows[3]?.reasoning).toBe('先搜索再作答。');
    expect(rows[3]?.tasks).toContain('搜索');
  });
});
