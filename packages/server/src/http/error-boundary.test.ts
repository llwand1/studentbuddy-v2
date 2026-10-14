import { describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { asyncHandler } from './async-handler.js';
import { createErrorBoundary } from './error-boundary.js';

describe('HTTP error boundary', () => {
  it('handles sync throws and async non-Error rejections without leaking content or trusting request IDs', async () => {
    const app = express(), report = vi.fn();
    app.get('/sync', asyncHandler(() => { throw new Error('secret-key=/private/student.db'); }));
    app.get('/async', asyncHandler(() => Promise.reject('route')));
    app.get('/null', asyncHandler(() => Promise.reject(null)));
    app.get('/ok', (_req, res) => { res.json({ ok: true }); });
    app.use(createErrorBoundary(report));
    const ids = new Set<string>();
    for (const url of ['/sync', '/async', '/null']) {
      const response = await request(app).get(url).set('X-Request-Id', 'attacker-id').expect(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(response.text).not.toMatch(/secret-key|private|route|stack|attacker-id/);
      expect(response.body.requestId).toMatch(/^[a-f0-9-]{36}$/); ids.add(response.body.requestId as string);
      expect(response.headers['x-request-id']).toBe(response.body.requestId);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(ids.size).toBe(3); expect(JSON.stringify(report.mock.calls)).not.toContain('secret-key');
    await request(app).get('/ok').expect(200);
  });
  it('maps malformed and oversized JSON into stable 400 and 413 responses', async () => {
    const app = express(); app.use(express.json({ limit: 32 }));
    app.post('/', (_req, res) => { res.json({ ok: true }); }); app.use(createErrorBoundary(() => {}));
    const invalid = await request(app).post('/').set('Content-Type', 'application/json').send('{private-secret').expect(400);
    expect(invalid.body.code).toBe('INVALID_JSON'); expect(invalid.text).not.toContain('private-secret');
    const large = await request(app).post('/').send({ value: 'x'.repeat(64) }).expect(413);
    expect(large.body.code).toBe('BODY_TOO_LARGE');
    await request(app).post('/').send({ value: 1 }).expect(200);
  });
  it('does not write closed responses and delegates started streams with a sanitized failure', () => {
    const boundary = createErrorBoundary(() => {}), next = vi.fn();
    const req = { method: 'GET', aborted: false } as Request;
    boundary(new Error('private-token'), req, { destroyed: true } as Response, next); expect(next).not.toHaveBeenCalled();
    boundary(new Error('private-token'), req, { destroyed: false, headersSent: true } as Response, next);
    expect(next).toHaveBeenCalledWith('HTTP_STREAM_FAILURE');
  });
  it('handles hostile rejection objects and logging failures without falling back to unsafe responses', async () => {
    const app = express(), proxy = Proxy.revocable({}, {}); proxy.revoke();
    app.get('/proxy', asyncHandler(() => Promise.reject(proxy.proxy)));
    app.get('/getter', (_req, _res, next) => next({ get type(): string { throw new Error('private-secret'); } }));
    app.use(createErrorBoundary(() => { throw new Error('private-logging-failure'); }));
    for (const route of ['/proxy', '/getter']) {
      const response = await request(app).get(route).expect(500);
      expect(response.body.code).toBe('INTERNAL_ERROR'); expect(response.text).not.toMatch(/private-|stack/);
    }
  });
});
