/**
 * routes/tools.test — `/api/tools` 三端口的仪器（supertest，手法同 chat-send.test.ts）。
 *
 * 锁的是**接线层**而非聚合层：阈值归一化与 p95 口径已分别钉在
 * `storage/tool-stats.test.ts` 与 shared 的 normalize 用例里，这里只锁四件事——
 * ① 未配过读回默认 5（设置页首开不能显示空档）；② PUT 坏值不 400、回读即落库值；
 * ③ stats 响应形状（前端 ToolsCard 按 `{stats, deleteLogTotal, sessionAffected}` 消费）；
 * ④ 越权 sessionId → 404 同形（TENANCY-SPEC §5：不存在的与不可达的一律一个样子）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tools-route-test-'));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { publishEvent } = await import('../events/bus.js');
const { wireToolStats } = await import('../storage/tool-stats.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

// 订阅器只在服务启动流程 `start()` 里接线，测试导入 app 不触发——这里补接一次，
// 本文件恰好也就锁住了「事件 → tool_stats → 路由」这条真链路（聚合口径在 storage 测）。
wireToolStats();

const origin = 'http://localhost:5173';

async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}

const getJson = (url: string) => request(app).get(url).set('Origin', origin);
const putJson = (url: string, body: Record<string, unknown>) =>
  request(app).put(url).set('Origin', origin).send(body);

afterAll(() => closeDb());

describe('GET/PUT /api/tools/confirm-threshold', () => {
  it('未配过 → 默认 5（拍板⑮）', async () => {
    const r = await getJson('/api/tools/confirm-threshold');
    expect(r.status).toBe(200);
    expect(r.body.threshold).toBe(5);
  });

  it('合法档位往返：1 → 0 各自存进什么读出什么', async () => {
    expect((await putJson('/api/tools/confirm-threshold', { threshold: 1 })).body).toEqual({ ok: true, threshold: 1 });
    expect((await getJson('/api/tools/confirm-threshold')).body.threshold).toBe(1);
    expect((await putJson('/api/tools/confirm-threshold', { threshold: 0 })).body.threshold).toBe(0);
    expect((await getJson('/api/tools/confirm-threshold')).body.threshold).toBe(0);
  });

  it('坏值不 400：超上限/负数/非数一律回退默认，小数向下取整', async () => {
    expect((await putJson('/api/tools/confirm-threshold', { threshold: 99 })).body.threshold).toBe(5);
    expect((await putJson('/api/tools/confirm-threshold', { threshold: -1 })).body.threshold).toBe(5);
    expect((await putJson('/api/tools/confirm-threshold', { threshold: 'abc' })).body.threshold).toBe(5);
    expect((await putJson('/api/tools/confirm-threshold', { threshold: 2.7 })).body.threshold).toBe(2);
  });
});

describe('GET /api/tools/stats', () => {
  it('零调用零行：形状恒在，sessionAffected 不带参时为 null', async () => {
    const r = await getJson('/api/tools/stats');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stats: [], deleteLogTotal: 0, sessionAffected: null });
  });

  it('tool_called 事件经订阅落库后按工具聚合可见（发布点唯一，接线通）', async () => {
    publishEvent({
      type: 'tool_called',
      sessionId: null,
      ownerId: null,
      tool: 'delete_terms',
      source: 'builtin',
      ok: true,
      ms: 40,
      affected: 3,
      resultChars: 12,
      err: null,
      confirm: 'allow_once',
    });
    const r = await getJson('/api/tools/stats');
    const row = (r.body.stats as Array<Record<string, number | string>>).find(
      (s) => s.tool === 'delete_terms',
    );
    expect(row).toMatchObject({ calls: 1, failures: 0, affectedTotal: 3, confirmAllowed: 1, confirmDenied: 0 });
  });

  it('带归属通过的 sessionId → sessionAffected 给本会话累计改动条数', async () => {
    const sid = (await request(app).post('/api/sessions').set('Origin', origin).send({})).body.id as string;
    publishEvent({
      type: 'tool_called',
      sessionId: sid,
      ownerId: null,
      tool: 'upsert_term',
      source: 'builtin',
      ok: true,
      ms: 5,
      affected: 7,
      resultChars: 3,
      err: null,
      confirm: null,
    });
    const r = await getJson(`/api/tools/stats?sessionId=${sid}`);
    expect(r.status).toBe(200);
    expect(r.body.sessionAffected).toBe(7);
  });

  it('登录后拿别人的/不存在的 sessionId → 404 同形；自己的 → 200 且看不到无主行数据', async () => {
    // 未登录（ownerId null）下 canAccessSession 按 TENANCY-SPEC 放行一切，404 只能从登录态测
    const cookie = await signUp('tools-route@example.com');
    const ghost = request(app)
      .get('/api/tools/stats?sessionId=00000000-0000-4000-8000-000000000000')
      .set('Origin', origin)
      .set('Cookie', cookie);
    expect((await ghost).status).toBe(404);
    const sid = (await request(app).post('/api/sessions').set('Origin', origin).set('Cookie', cookie).send({})).body
      .id as string;
    const r = await request(app).get(`/api/tools/stats?sessionId=${sid}`).set('Origin', origin).set('Cookie', cookie);
    expect(r.status).toBe(200);
    // 前面几条用例的事件都是无主行（owner ''）：登录用户既看不到聚合行，也数不到别人的 affected
    expect(r.body.stats).toEqual([]);
    expect(r.body.sessionAffected).toBe(0);
  });

  it('days 传垃圾值不崩，按默认窗口聚合', async () => {
    const r = await getJson('/api/tools/stats?days=abc');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.stats)).toBe(true);
  });
});
