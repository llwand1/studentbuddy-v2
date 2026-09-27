/**
 * llm/image-quota 单测 —— 生图张数闸的三个纯/半纯件（契约 `docs/IMAGE-GEN-SPEC.md` §5）：
 * env 解析（非法值不许把闸门拆掉）、本地日历日边界（`localDayStartUtc`，跨日是它唯一会错的时刻）、
 * `tool_stats` 计数（只数 `ok=1`、只数本人、只数今天）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { countTodayImages, imageDailyLimit, imageSlotKey, localDayStartUtc, releaseImageSlot, tryAcquireImageSlot } from './image-quota.js';

let dir: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-image-quota-'));
  openIsolated(dir);
  for (const k of ['SB_IMAGE_DAILY_LIMIT']) envBackup[k] = process.env[k];
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/** 直插一行 tool_stats（created_at 显式给，绕开 datetime('now') 的不可控）。 */
function insertStat(ownerId: string, ok: 0 | 1, createdAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO tool_stats (owner_id, session_id, tool, source, ok, affected, ms, result_chars, created_at)
       VALUES (?, 'sess', 'generate_image', 'builtin', ?, NULL, 1, 0, ?)`,
    )
    .run(ownerId, ok, createdAt);
}

describe('imageDailyLimit — env 解析', () => {
  it('未配回落缺省 15', () => {
    delete process.env.SB_IMAGE_DAILY_LIMIT;
    expect(imageDailyLimit()).toBe(15);
  });
  it('合法值生效（含 0 ＝ 关闭平台生图）', () => {
    process.env.SB_IMAGE_DAILY_LIMIT = '3';
    expect(imageDailyLimit()).toBe(3);
    process.env.SB_IMAGE_DAILY_LIMIT = '0';
    expect(imageDailyLimit()).toBe(0);
  });
  it('非法值一律回落缺省——配置错误不许悄悄拆闸', () => {
    for (const bad of ['abc', '-5', '', '1e999']) {
      process.env.SB_IMAGE_DAILY_LIMIT = bad;
      expect(imageDailyLimit()).toBe(15);
    }
    process.env.SB_IMAGE_DAILY_LIMIT = '2.9';
    expect(imageDailyLimit()).toBe(2); // 小数取整，不四舍五入放宽
  });
});

describe('localDayStartUtc — 本地日历日 → UTC 串', () => {
  it('本地零点换算成 UTC 时刻（东八区 00:00 ＝ 前一天 16:00Z）', () => {
    // 固定用一个明确的本地时刻构造：new Date(2026, 8, 27, 10, 30) ＝ 本地 2026-09-27 10:30
    const now = new Date(2026, 8, 27, 10, 30, 0);
    const start = localDayStartUtc(now);
    // 与「本地当天 00:00」的 Date 的 ISO 串逐字一致
    expect(start).toBe(new Date(2026, 8, 27, 0, 0, 0).toISOString().slice(0, 19).replace('T', ' '));
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it('跨日边界：当天 00:00 之前的事件不算今天', () => {
    const now = new Date(2026, 8, 27, 0, 0, 1);
    const boundary = localDayStartUtc(now);
    const before = new Date(2026, 8, 26, 23, 59, 59).toISOString().slice(0, 19).replace('T', ' ');
    expect(before < boundary).toBe(true);
  });
});

describe('countTodayImages — tool_stats 计数', () => {
  it('只数本人、只数 ok=1、只数今天', () => {
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const today = localDayStartUtc(now);
    insertStat('u1', 1, today);
    insertStat('u1', 1, today);
    insertStat('u1', 0, today); // 失败不计——上游 429 不该让用户白付张数
    insertStat('u2', 1, today); // 别人不计
    insertStat('u1', 1, '2020-01-01 00:00:00'); // 昨天以前不计
    expect(countTodayImages('u1', now)).toBe(2);
    expect(countTodayImages('u2', now)).toBe(1);
  });
});

describe('并发坑位 — 同 key 互斥', () => {
  it('占住后第二人进不来，释放后可再占', () => {
    expect(tryAcquireImageSlot('u1')).toBe(true);
    expect(tryAcquireImageSlot('u1')).toBe(false);
    releaseImageSlot('u1');
    expect(tryAcquireImageSlot('u1')).toBe(true);
    releaseImageSlot('u1');
  });
  it('null（本地单人模式）归同一个桶', () => {
    expect(imageSlotKey(null)).toBe('');
    expect(tryAcquireImageSlot('')).toBe(true);
    expect(tryAcquireImageSlot('')).toBe(false);
    releaseImageSlot('');
  });
});
