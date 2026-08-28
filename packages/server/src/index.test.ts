import { describe, it, expect, beforeEach } from 'vitest';
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

  beforeEach(() => {
    // getProviderKey 环境变量优先于库：不清会让真机上的"未配置"断言变脆
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
