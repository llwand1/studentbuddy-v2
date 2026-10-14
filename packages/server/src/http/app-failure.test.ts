import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

process.env.SB_DATA_DIR = mkdtempSync(join(tmpdir(), 'sb-http-real-app-'));
vi.mock('../learning/quiz-grade.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/quiz-grade.js')>(),
  gradeAnswer: vi.fn().mockRejectedValue(new Error('secret-model-token /private/file')),
}));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
afterAll(() => closeDb());

it('the production learner route reaches the final error boundary and the application remains healthy', async () => {
  const failure = await request(app).post('/api/learning/grade').set('Origin', 'http://localhost')
    .send({ question: '1 + 1 = ?', reference: '2', answer: '3', qtype: 'fill' }).expect(500);
  expect(failure.body.code).toBe('INTERNAL_ERROR'); expect(failure.text).not.toMatch(/secret-model-token|private\/file/);
  expect(failure.headers['x-request-id']).toBe(failure.body.requestId);
  const health = await request(app).get('/api/health').expect(200); expect(health.body.ok).toBe(true);
});
