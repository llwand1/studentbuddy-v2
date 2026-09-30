/**
 * routes/sources 的三个新端点（supertest；契约 docs/SOURCE-TRACE-SPEC.md §12–§13）。
 * 浏览器与视频取数都桩掉（`sources/shot.js` / `sources/video-route.js`），这里只锁**路由层**的许可、参数与形态：
 * ① `/probe`：许可同 `/view`（不在架 403）；阅读页 ok 带 `thin`；取页失败 ⇒ `ok:false` + 原因 + `shot` 能力位；图片类恒 ok 不取页；
 *    与 `/view` **同一次取页**（inflight 合流：两请求并发只拉一次上游）；
 * ② `/shot`：不在架 403；没浏览器 404 JSON；有 ⇒ `image/png` + nosniff + 私有缓存；`ShotError` 按种类给状态码（timeout 504 / busy 503）；
 * ③ `/videos`：坏线路 / 空词 400；正常透传线路结果（`ownerId` 交给取数层）；`/view` 失败页在没浏览器时如实写「截不了图」。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sources-fb-test-'));

const fetchSafe = vi.fn();
vi.mock('../search/ssrf-guard.js', () => ({
  fetchSafe: (...a: unknown[]) => fetchSafe(...a),
  assertSafeUrl: async (u: string) => new URL(u),
  resolveSafeAddress: async () => '203.0.113.9',
}));
const shot = vi.hoisted(() => ({ available: false, take: vi.fn() }));
vi.mock('../sources/shot.js', async (orig) => {
  const real = (await orig()) as typeof import('../sources/shot.js');
  return { ...real, shotAvailable: () => shot.available, takeScreenshot: (...a: unknown[]) => shot.take(...a) };
});
const videos = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../sources/video-route.js', () => ({ searchVideoRoute: (...a: unknown[]) => videos.search(...a) }));

const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { createSourceShelf } = await import('../sources/shelf.js');
const { resetReaderCache } = await import('../sources/reader.js');
const { ShotError } = await import('../sources/shot.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const createSession = async (): Promise<string> => (await request(app).post('/api/sessions').set('Origin', origin).send({})).body.id as string;
const result = (i: number, url = `https://s.example.com/${i}`) => ({ title: `T${i}`, url, snippet: `S${i}`, source: 'bing' });
const html = (body: string) => new Response(`<html><head><title>P</title></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html' } });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(() => {
  getDb().prepare('DELETE FROM messages').run();
  getDb().prepare('DELETE FROM sessions').run();
  resetReaderCache();
  fetchSafe.mockReset();
  shot.take.mockReset();
  shot.available = false;
  videos.search.mockReset();
});
afterAll(() => closeDb());

describe('① GET /api/sources/probe', () => {
  it('不在架 403；正文够 ⇒ ok/thin:false；太薄 ⇒ thin:true；取页失败 ⇒ ok:false + 原因；都带 shot 能力位', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(1), result(2), result(3)]);
    await request(app).get('/api/sources/probe').query({ session: sid, url: 'https://nope.example.com/' }).expect(403);
    fetchSafe.mockResolvedValueOnce(html(`<p>${'正文'.repeat(200)}</p>`));
    expect((await request(app).get('/api/sources/probe').query({ session: sid, url: 'https://s.example.com/1' }).expect(200)).body).toEqual({ ok: true, thin: false, shot: false });
    shot.available = true;
    fetchSafe.mockResolvedValueOnce(html('<p>薄</p>'));
    expect((await request(app).get('/api/sources/probe').query({ session: sid, url: 'https://s.example.com/2' }).expect(200)).body).toEqual({ ok: true, thin: true, shot: true });
    fetchSafe.mockResolvedValueOnce(new Response('bin', { headers: { 'content-type': 'image/png' } }));
    expect((await request(app).get('/api/sources/probe').query({ session: sid, url: 'https://s.example.com/3' }).expect(200)).body).toMatchObject({ ok: false, status: 415, shot: true });
    shelf.dispose();
  });

  it('图片类恒 ok 不取页；/probe 与 /view 并发只拉一次上游（合流）', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(4, 'https://s.example.com/cell.png'), result(5)]);
    expect((await request(app).get('/api/sources/probe').query({ session: sid, url: 'https://s.example.com/cell.png' }).expect(200)).body).toEqual({ ok: true, thin: false, shot: false });
    expect(fetchSafe).not.toHaveBeenCalled();
    fetchSafe.mockImplementation(() => new Promise((ok) => setTimeout(() => ok(html(`<p>${'字'.repeat(300)}</p>`)), 30)));
    const [probe, view] = await Promise.all([
      request(app).get('/api/sources/probe').query({ session: sid, url: 'https://s.example.com/5' }),
      request(app).get('/api/sources/view').query({ session: sid, url: 'https://s.example.com/5' }),
    ]);
    expect(probe.status).toBe(200);
    expect(view.status).toBe(200);
    expect(fetchSafe).toHaveBeenCalledTimes(1);
    shelf.dispose();
  });
});

describe('② GET /api/sources/shot', () => {
  it('不在架 403；没浏览器 404 JSON；有 ⇒ image/png + nosniff；ShotError 按种类给状态码', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(6)]);
    await request(app).get('/api/sources/shot').query({ session: sid, url: 'https://nope.example.com/' }).expect(403);
    shot.take.mockRejectedValueOnce(new ShotError('no_browser', '服务器没装浏览器，截不了图'));
    const none = await request(app).get('/api/sources/shot').query({ session: sid, url: 'https://s.example.com/6' }).expect(404);
    expect(none.body).toEqual({ error: '服务器没装浏览器，截不了图', kind: 'no_browser' });
    shot.take.mockResolvedValueOnce(PNG);
    const ok = await request(app)
      .get('/api/sources/shot')
      .query({ session: sid, url: 'https://s.example.com/6' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['cache-control']).toBe('private, max-age=600');
    expect(Buffer.from(ok.body as Buffer).readUInt32BE(0)).toBe(0x89504e47);
    expect(shot.take).toHaveBeenLastCalledWith('https://s.example.com/6');
    shot.take.mockRejectedValueOnce(new ShotError('timeout', '截图超时'));
    await request(app).get('/api/sources/shot').query({ session: sid, url: 'https://s.example.com/6' }).expect(504);
    shot.take.mockRejectedValueOnce(new ShotError('busy', '排队'));
    await request(app).get('/api/sources/shot').query({ session: sid, url: 'https://s.example.com/6' }).expect(503);
    shot.take.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app).get('/api/sources/shot').query({ session: sid, url: 'https://s.example.com/6' }).expect(502)).body.kind).toBe('failed');
    shelf.dispose();
  });
});

describe('③ GET /api/sources/videos + 失败页口径', () => {
  it('坏线路 / 空词 400；正常透传（词已清洗）；/view 失败页没浏览器时写「截不了图」', async () => {
    await request(app).get('/api/sources/videos').query({ route: 'youtube', q: 'x' }).expect(400);
    await request(app).get('/api/sources/videos').query({ route: 'bilibili', q: '   ' }).expect(400);
    const fake = { route: 'bilibili', query: '牛顿第二定律', hits: [], siteSearchUrl: 'https://search.bilibili.com/all?keyword=x', via: 'none', note: 'n' };
    videos.search.mockResolvedValueOnce(fake);
    const res = await request(app).get('/api/sources/videos').query({ route: 'bilibili', q: ' 牛顿第二定律 ' }).expect(200);
    expect(res.body).toEqual(fake);
    expect(videos.search.mock.calls[0]?.slice(0, 3)).toEqual(['bilibili', '牛顿第二定律', null]);

    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(7)]);
    fetchSafe.mockResolvedValueOnce(new Response('x', { status: 500 }));
    const fail = await request(app).get('/api/sources/view').query({ session: sid, url: 'https://s.example.com/7' }).expect(502);
    expect(fail.text).toContain('服务器没装浏览器，截不了图');
    shelf.dispose();
  });
});
