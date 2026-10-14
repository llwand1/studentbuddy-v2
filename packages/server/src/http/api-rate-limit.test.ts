import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApiLimiter, costlyRequest, requestBudgetIdentity } from './api-rate-limit.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { RateWindow } from './rate-window.js';

describe('bounded API budgets', () => {
  it('expires windows, isolates keys, never evicts active budgets under capacity pressure', () => {
    const budget = new RateWindow(2, 1000, 2);
    expect(budget.consume('a', 0).allowed).toBe(true); expect(budget.consume('a', 1).allowed).toBe(true);
    expect(budget.consume('a', 2).allowed).toBe(false); expect(budget.consume('b', 2).allowed).toBe(true);
    expect(budget.consume('c', 2).allowed).toBe(false); expect(budget.size).toBe(2);
    expect(budget.consume('a', 3).allowed).toBe(false); expect(budget.consume('c', 1002).allowed).toBe(true);
    expect(budget.consume('a', 1003).allowed).toBe(true);
    expect(budget.consume('d', 3000).allowed).toBe(true);
    expect(() => new RateWindow(0)).toThrow();
  });
  it('responds with usable retry headers and recovers without affecting health, status, OPTIONS or local use', async () => {
    let now = 0, enabled = true; const app = express();
    app.use('/api', createApiLimiter({ limit: 2, windowMs: 1000, enabled: () => enabled, now: () => now }));
    app.use('/api', (_req, res) => { res.json({ ok: true }); });
    await request(app).get('/api/data').expect(200); await request(app).get('/api/data').expect(200);
    const blocked = await request(app).get('/api/data').expect(429);
    expect(blocked.headers['retry-after']).toBe('1'); expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body.code).toBe('RATE_LIMITED'); expect(blocked.headers['cache-control']).toBe('no-store');
    for (const route of ['/api/health', '/api/status/']) await request(app).get(route).expect(200);
    await request(app).options('/api/data').expect(200);
    now = 1000; await request(app).get('/api/data').expect(200);
    enabled = false; for (let i = 0; i < 4; i++) await request(app).get('/api/data').expect(200);
  });
  it('uses real proxy configuration, not attacker-controlled forwarding headers', async () => {
    const app = express(); app.use(createApiLimiter({ limit: 1, enabled: () => true })); app.get('/', (_req, res) => { res.end(); });
    await request(app).get('/').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '192.0.2.2').expect(429);
    const proxy = express(); proxy.set('trust proxy', 'loopback'); proxy.use(createApiLimiter({ limit: 1, enabled: () => true })); proxy.get('/', (_req, res) => { res.end(); });
    await request(proxy).get('/').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(proxy).get('/').set('X-Forwarded-For', '192.0.2.2').expect(200);
  });
  it('shares one authenticated account budget across costly routes without charging ordinary reads', async () => {
    const app = express();
    app.use((req, _res, next) => {
      const id = req.get('x-test-user') ?? 'anonymous';
      (req as AuthedRequest).authUser = { id, email: 'fixture@example.invalid', nickname: 'fixture', createdAt: '2026-01-01' }; next();
    });
    app.use(createApiLimiter({ limit: 1, enabled: () => true, applies: costlyRequest, key: requestBudgetIdentity }));
    app.use((_req, res) => { res.end(); });
    await request(app).post('/api/quiz/generate').set('x-test-user', 'a').expect(200);
    await request(app).post('/API/LEARNING/GRADE/').set('x-test-user', 'a').expect(429);
    await request(app).post('/api/chat/send').set('x-test-user', 'b').expect(200);
    await request(app).get('/api/sessions').set('x-test-user', 'a').expect(200);
    await request(app).get('/api/images/local.png').set('x-test-user', 'a').expect(200);
    await request(app).get('/api/sources/pdf').set('x-test-user', 'a').expect(200);
    await request(app).post('/api/continent/expand/offer').set('x-test-user', 'b').expect(429);
    await request(app).post('/api/chat/opener').set('x-test-user', 'c').expect(200);
    await request(app).post('/api/chat/resend').set('x-test-user', 'c').expect(429);
    await request(app).post('/api/terms/extract').set('x-test-user', 'c').expect(429);
  });
  it('rejects excess requests before body parsing instead of spending resources on rejected payloads', async () => {
    const app = express(); app.use(createApiLimiter({ limit: 1, enabled: () => true })); app.use(express.json({ limit: 16 }));
    app.post('/', (_req, res) => { res.end(); });
    await request(app).post('/').send({ x: 1 }).expect(200);
    await request(app).post('/').send({ x: 'x'.repeat(64) }).expect(429);
  });
});
