import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountStaticWeb } from './web-static.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-static-web-'));
fs.writeFileSync(path.join(root, 'index.html'), '<html>StudentBuddy test shell</html>');
fs.writeFileSync(path.join(root, 'app.js'), 'window.app = true;');
fs.mkdirSync(path.join(root, 'api'));
fs.writeFileSync(path.join(root, 'api', 'secret'), 'must not be served');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function application(directory: string) {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  mountStaticWeb(app, directory);
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

describe('安装包同源静态网页', () => {
  it('不配置目录时保持 API-only', async () => {
    await request(application('')).get('/').expect(404);
    await request(application('')).get('/api/health').expect(200, { ok: true });
  });
  it('提供首页和静态资源', async () => {
    const app = application(root);
    expect((await request(app).get('/').expect(200)).text).toContain('StudentBuddy test shell');
    expect((await request(app).get('/app.js').expect(200)).text).toBe('window.app = true;');
  });
  it('页面 GET 与 HEAD 可回退到应用壳', async () => {
    const app = application(root);
    expect((await request(app).get('/settings').expect(200)).text).toContain('StudentBuddy test shell');
    await request(app).head('/settings').expect(200);
  });
  it('未知 API 不得回应用壳或磁盘文件', async () => {
    const app = application(root);
    await request(app).get('/api/unknown').expect(404, { error: 'not found' });
    await request(app).get('/api/secret').expect(404, { error: 'not found' });
    await request(app).get('/API/unknown').expect(404, { error: 'not found' });
    await request(app).get('/api%2fsecret').expect(404, { error: 'not found' });
  });
  it('丢失的静态资源保持 404', async () => {
    await request(application(root)).get('/missing.js').expect(404);
  });
  it('非读取请求不得回应用壳', async () => {
    await request(application(root)).post('/settings').expect(404);
  });
});
