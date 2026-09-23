// @vitest-environment node
/**
 * routes/growth + 三个 HTTP 采集点 — C4 计数的**端到端**锁（契约 `docs/GROWTH-SPEC.md` §2.1/§3/§5）。
 *
 * ★ 与 `growth/counters.test.ts` 的分工：那边锁单元层（去重键、探针判定、隐私形状），
 *   这边只锁**真的经 HTTP 进来会不会被记上**——包括「记在成功之后」这条最容易写错的位置，
 *   以及读侧的公开形状与限流。判据原文「前端显示数＝后端可查数」在这边以
 *   「端点返回的数 == 直读库 GROUP BY 的数」的形式锁（★ 两边都从同一张表来，才叫可查数）。
 * ⚠️ supertest 的 `req.ip` 恒为 127.0.0.1 ⇒ **同一 IP** 正好是去重判据的现场，
 *   但三个内存桶（growth／demo-login／register）会跨用例串 ⇒ 每例前全清。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEMO_USER_ID } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-growth-routes-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetGrowthRateLimits, GROWTH_MAX_PER_IP_HOUR } = await import('../routes/growth.js');
const { resetDemoLoginLimits } = await import('../auth/demo.js');
const { resetRegisterLimits } = await import('../auth/register-limit.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const get = (url: string) => request(app).get(url).set('Origin', origin);
const post = (url: string) => request(app).post(url).set('Origin', origin);
const PROBE = { 'User-Agent': 'studentbuddy-probe/1.0 (growth-test)', 'X-SB-Probe': 'growth-test' };

/** 端点返回的数（读侧唯一出口）。 */
async function counters(): Promise<{
  counts: Record<'app_open' | 'demo_enter' | 'register_done', number>;
  unit: string;
  unitLabel: string;
  firstDay: string | null;
}> {
  const res = await get('/api/growth/counters');
  expect(res.status).toBe(200);
  return res.body;
}

/** 直读库复算（判据第 5 条：能复算对上的数才敢对外报）。 */
function countsFromDb(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT kind, COUNT(*) AS c FROM growth_action_day GROUP BY kind')
    .all() as Array<{ kind: string; c: number }>;
  const out: Record<string, number> = { app_open: 0, demo_enter: 0, register_done: 0 };
  for (const r of rows) out[r.kind] = r.c;
  return out;
}

beforeEach(() => {
  resetGrowthRateLimits();
  resetDemoLoginLimits();
  resetRegisterLimits();
  resetRateLimits();
  getDb().exec('DELETE FROM growth_action_day');
  process.env.SB_DEMO_LOGIN = '1';
});

afterEach(() => {
  delete process.env.SB_DEMO_LOGIN;
});

afterAll(() => {
  closeDb();
});

describe('读侧公开形状', () => {
  it('★ 无 cookie 也读得到（公开端点＝决策，见 GROWTH-SPEC §3），且三键齐、口径随数出门', async () => {
    const body = await counters();
    expect(Object.keys(body.counts).sort()).toEqual(['app_open', 'demo_enter', 'register_done']);
    expect(body.unit).toBe('ip_day');
    expect(body.unitLabel).toContain('次');
    expect(body.unitLabel).toContain('同一来源 IP');
    expect(body.firstDay).toBeNull();
  });

  it('★ 真实计数为 0 时返回的就是 0——没有任何兜底假数', async () => {
    const body = await counters();
    expect(body.counts).toEqual({ app_open: 0, demo_enter: 0, register_done: 0 });
  });

  it('端点自身不写库（读一百次也不会把自己数进「应用被打开」）', async () => {
    for (let i = 0; i < 3; i += 1) await counters();
    expect(countsFromDb()).toEqual({ app_open: 0, demo_enter: 0, register_done: 0 });
  });

  it('★ 限流：第 21 次 429 ＋ `retryAfterMs`（公开读端点的天花板，同 demo-login 档）', async () => {
    for (let i = 0; i < GROWTH_MAX_PER_IP_HOUR; i += 1) {
      expect((await get('/api/growth/counters')).status).toBe(200);
    }
    const res = await get('/api/growth/counters');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('GROWTH_RATE_LIMITED');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    resetGrowthRateLimits();
  });
});

describe('三个采集点（都必须是 HTTP 层、且成功之后）', () => {
  it('★ `app_open` 由 `GET /api/auth/providers` 采集，且同 IP 连打两次只涨 1', async () => {
    expect((await get('/api/auth/providers')).status).toBe(200);
    expect((await get('/api/auth/providers')).status).toBe(200);
    const body = await counters();
    expect(body.counts.app_open).toBe(1);
    expect(body.counts).toEqual(countsFromDb()); // 判据：端点数 == 复算数
    expect(body.firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('探针打 `/providers` 不涨数（批次 E 的标记在这里兑现成「剔得掉」）', async () => {
    await request(app).get('/api/auth/providers').set(PROBE);
    expect((await counters()).counts.app_open).toBe(0);
  });

  it('★ `demo_enter` 只记成功的体验号登录；带探针头的同一条请求不记', async () => {
    await request(app).post('/api/auth/demo-login').set({ Origin: origin, ...PROBE }).send({});
    expect((await counters()).counts.demo_enter).toBe(0);

    await post('/api/auth/demo-login').send({});
    expect((await counters()).counts.demo_enter).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(DEMO_USER_ID)).toEqual({ c: 1 });
  });

  it('★ `register_done` 记在成功之后：409 撞号与 400 脏输入都不算「有人注册了」', async () => {
    const email = 'growth-count@example.com';
    const bad = await post('/api/auth/register').send({ email, password: 'x' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await counters()).counts.register_done).toBe(0);

    const ok = await post('/api/auth/register').send({ email, password: 'good-password-1' });
    expect(ok.status).toBe(200);
    expect((await counters()).counts.register_done).toBe(1);

    const dup = await post('/api/auth/register').send({ email: 'GROWTH-COUNT@example.com', password: 'good-password-1' });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect((await counters()).counts.register_done).toBe(1); // ★ 仍是 1：去重 ＋ 失败不记，两条叠加
  });
});
