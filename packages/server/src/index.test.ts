import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './index.js';

describe('M0 地基：server 骨架', () => {
  it('GET /api/status 返回 StatusResponse 契约', async () => {
    const res = await request(app).get('/api/status').expect(200);
    expect(res.body).toEqual({ hasProviders: false, version: expect.any(String) });
  });

  it('GET /api/health 健康检查', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('写操作无 Origin → 403（防恶意网页跨源调用，v1 修复回归）', async () => {
    // supertest 不带 Origin 头模拟跨源写请求
    await request(app).post('/api/whatever').send({}).expect(403);
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
});
