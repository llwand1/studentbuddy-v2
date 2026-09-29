/**
 * routes/sources 端到端（supertest；契约 docs/SOURCE-TRACE-SPEC.md §6–§7）。
 *
 * 钉：① 缺参 400 / 会话不归属 404 / 网址不在架上 403——**不是任意网址代理**；
 * ② 在线架上的网址能出阅读页，且带 CSP `sandbox`（无 allow-scripts）+ nosniff；
 * ③ 落库后（persistRounds）在线架没了也能凭 `message_source` 放行；`/messages` 行带 `sources`；
 *    `/session/:id` 按 message_id 分组；④ PDF 转发只放行魔数 `%PDF-`；⑤ 重新生成删消息时资料行级联消失。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sources-test-'));

const fetchSafe = vi.fn();
vi.mock('../search/ssrf-guard.js', () => ({
  fetchSafe: (...a: unknown[]) => fetchSafe(...a),
  assertSafeUrl: async (u: string) => new URL(u),
}));

const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { createSourceShelf } = await import('../sources/shelf.js');
const { primeReaderHtml, resetReaderCache } = await import('../sources/reader.js');
const { persistRounds, dropMessagesAfter } = await import('../chat/persist.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const createSession = async (): Promise<string> => {
  const res = await request(app).post('/api/sessions').set('Origin', origin).send({});
  return res.body.id as string;
};
const view = (session: string, url: string) => request(app).get('/api/sources/view').query({ session, url });
const pdf = (session: string, url: string) => request(app).get('/api/sources/pdf').query({ session, url });
const result = (i: number) => ({ title: `T${i}`, url: `https://s.example.com/${i}`, snippet: `S${i}`, source: 'bing' });

beforeEach(() => {
  getDb().prepare('DELETE FROM messages').run();
  getDb().prepare('DELETE FROM sessions').run();
  resetReaderCache();
  fetchSafe.mockReset();
});
afterAll(() => closeDb());

describe('GET /api/sources/view', () => {
  it('① 缺参 400；网址不在架上 403（单人模式归属断言放行，不存在的会话同样没有架子）；非 http 400', async () => {
    const sid = await createSession();
    await view('', 'https://x.example.com').expect(400);
    await view('s-nope', 'https://x.example.com').expect(403);
    await view(sid, 'javascript:alert(1)').expect(400);
    const res = await view(sid, 'https://x.example.com').expect(403);
    expect(res.body.error).toContain('不在本会话的资料架上');
  });

  it('② 在线架上的网址出阅读页：零脚本沙箱 CSP + nosniff；primed HTML 不再取页；hash 不同也算同一网址', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(1)]);
    primeReaderHtml('https://s.example.com/1', '<html><head><title>已读</title></head><body><p>正文</p><script>x()</script></body></html>');
    const res = await view(sid, 'https://s.example.com/1#h2').expect(200);
    expect(res.headers['content-security-policy']).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'/);
    expect(res.headers['content-security-policy']).not.toContain('allow-scripts');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN'); // 全局 DENY 会把宿主资料架一起挡掉
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('已读');
    expect(res.text).not.toContain('<script');
    expect(fetchSafe).not.toHaveBeenCalled();
    shelf.dispose();
  });

  it('取页失败也回沙箱失败页（带原网页链接），不是 JSON', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(2)]);
    fetchSafe.mockResolvedValueOnce(new Response('x', { status: 500 }));
    const res = await view(sid, 'https://s.example.com/2').expect(502);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('在新标签页打开原网页');
    shelf.dispose();
  });
});

describe('落库 / 历史 / 级联', () => {
  it('③ persistRounds 后在线架没了仍放行；/messages 行带 sources；/session/:id 按消息分组', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(1), result(2)]);
    shelf.pick([{ url: 'https://s.example.com/2', why: '官方' }]);
    const mid = persistRounds(sid, [], '回答 [2]', 3, { reasoning: '', tasks: [], sources: shelf.items() });
    shelf.dispose();
    fetchSafe.mockResolvedValueOnce(new Response('<html><title>P</title><body><p>hi</p></body></html>', { headers: { 'content-type': 'text/html' } }));
    await view(sid, 'https://s.example.com/2').expect(200);

    const rows = (await request(app).get(`/api/sessions/${sid}/messages`).expect(200)).body as Array<{ id: string; sources?: unknown[] }>;
    const mine = rows.find((r) => r.id === mid);
    expect(mine?.sources).toHaveLength(2);
    expect(mine?.sources?.[1]).toMatchObject({ n: 2, origin: 'pick', why: '官方' });
    expect(rows.filter((r) => r.id !== mid).every((r) => r.sources === undefined)).toBe(true);

    const grouped = (await request(app).get(`/api/sources/session/${sid}`).expect(200)).body as { byMessage: Record<string, unknown[]> };
    expect(Object.keys(grouped.byMessage)).toEqual([mid]);
    expect((await request(app).get('/api/sources/session/s-nope').expect(200)).body).toEqual({ byMessage: {} });
  });

  it('⑤ 删消息（重新生成路径）资料行级联消失', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [result(1)]);
    persistRounds(sid, [], '答', 1, { reasoning: '', tasks: [], sources: shelf.items() });
    shelf.dispose();
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM message_source WHERE session_id = ?').get(sid)).toEqual({ c: 1 });
    dropMessagesAfter(sid, 0);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM message_source WHERE session_id = ?').get(sid)).toEqual({ c: 0 });
    await view(sid, 'https://s.example.com/1').expect(403);
  });
});

describe('GET /api/sources/pdf', () => {
  it('④ 只放行魔数 %PDF-：假 PDF 415、真 PDF 原样转发 + inline + nosniff；不在架上 403', async () => {
    const sid = await createSession();
    const shelf = createSourceShelf(sid);
    shelf.found('q', [{ ...result(9), url: 'https://s.example.com/paper.pdf' }]);
    fetchSafe.mockResolvedValueOnce(new Response('<html>not pdf</html>', { headers: { 'content-type': 'application/pdf' } }));
    await pdf(sid, 'https://s.example.com/paper.pdf').expect(415);
    const bytes = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj');
    fetchSafe.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    const res = await pdf(sid, 'https://s.example.com/paper.pdf').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await pdf(sid, 'https://s.example.com/other.pdf').expect(403);
    shelf.dispose();
  });
});
