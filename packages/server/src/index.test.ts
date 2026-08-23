import { describe, it, expect } from 'vitest';
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
