/**
 * growth/activity —— 按日活跃心跳（契约 docs/RETENTION-SPEC.md §2）。
 * 锁的是三条边界：只记登录用户 / 探针不记 / 每用户每天一行且幂等；外加「心跳失败不影响请求」。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, localDayKey } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-activity-'));

const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { touchActivity, resetActivityCache } = await import('./activity.js');
const request = (await import('supertest')).default;

const rows = (): Array<{ user_id: string; day: string }> =>
  getDb().prepare('SELECT user_id, day FROM user_activity_day ORDER BY user_id, day').all() as Array<{ user_id: string; day: string }>;

let userId = '';
let cookie = '';

beforeAll(async () => {
  const user = await createUser('active@example.com', 'good-password-1', undefined);
  userId = user.id;
  cookie = `${AUTH_COOKIE_NAME}=${createSession(user.id).token}`;
});

afterAll(() => {
  closeDb();
  fs.rmSync(process.env.SB_DATA_DIR ?? '', { recursive: true, force: true });
});

beforeEach(() => {
  getDb().prepare('DELETE FROM user_activity_day').run();
  resetActivityCache();
});

describe('活跃心跳：user_activity_day', () => {
  it('v52 建表存在：(user_id, day) 主键', () => {
    const cols = getDb().prepare('PRAGMA table_info(user_activity_day)').all() as Array<{ name: string; pk: number }>;
    expect(cols.map((c) => c.name)).toEqual(['user_id', 'day', 'first_seen_at']);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['user_id', 'day']);
  });

  it('未登录请求不记（本地单机形态没有账号也不需要留存）', async () => {
    await request(app).get('/api/status').expect(200);
    await request(app).get('/api/health').expect(200);
    expect(rows()).toEqual([]);
  });

  it('登录用户当天第一次打到 /api/* 记一行；同一天再打多少次仍只有一行', async () => {
    await request(app).get('/api/status').set('Cookie', cookie).expect(200);
    await request(app).get('/api/sessions').set('Cookie', cookie);
    await request(app).get('/api/status').set('Cookie', cookie).expect(200);
    expect(rows()).toEqual([{ user_id: userId, day: localDayKey(new Date()) }]);
  });

  it('探针流量不记：X-SB-Probe 头 / studentbuddy-probe UA 任一命中即跳过（否则巡检把体验号刷成日日活跃）', async () => {
    await request(app).get('/api/status').set('Cookie', cookie).set('X-SB-Probe', 'prod-pulse').expect(200);
    await request(app).get('/api/status').set('Cookie', cookie).set('User-Agent', 'studentbuddy-probe/1.0').expect(200);
    expect(rows()).toEqual([]);
  });

  it('touchActivity 幂等：进程内去重 + INSERT OR IGNORE，跨天才产生新行', () => {
    const d1 = new Date('2026-09-30T10:00:00');
    const d2 = new Date('2026-10-01T10:00:00');
    expect(touchActivity('u-x', d1)).toBe(true);
    expect(touchActivity('u-x', d1)).toBe(false);
    resetActivityCache();
    expect(touchActivity('u-x', d1)).toBe(true); // 换了进程（或另一实例）再写：库里仍只一行
    expect(touchActivity('u-x', d2)).toBe(true);
    expect(rows()).toEqual([
      { user_id: 'u-x', day: localDayKey(d1) },
      { user_id: 'u-x', day: localDayKey(d2) },
    ]);
  });

  it('表不在（旧库未迁移）也不让请求失败：吞异常', () => {
    getDb().exec('DROP TABLE user_activity_day');
    expect(() => touchActivity('u-y')).not.toThrow();
    getDb().exec(`CREATE TABLE user_activity_day (user_id TEXT NOT NULL, day TEXT NOT NULL, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, day))`);
  });
});
