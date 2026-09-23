// @vitest-environment node
/**
 * growth/counters — 诚实计数写侧的锁（渠道台账 C4，契约 `docs/GROWTH-SPEC.md` §2）。
 *
 * ★ 本文件的重心不是「写没写进去」，而是**这个数将来敢不敢对外报**：
 *   去重键（判据原文「同一 IP 刷新不重复计」）、探针不进门（我们自己是最大流量源）、
 *   库里不留裸 IP（隐私形状是契约的一部分）、以及**记账永不抛**（它挂在登录路径上）。
 * 三条端到端（走真实 HTTP）的锁在 `routes/growth.test.ts`，这里只做单元层，两侧不重叠。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localDayKey } from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import {
  GROWTH_ACTIONS,
  GROWTH_UNIT,
  GROWTH_UNIT_LABEL,
  growthBucket,
  isProbeRequest,
  readGrowthSnapshot,
  recordGrowthAction,
  type GrowthRequestLike,
} from './counters.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-growth-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 构造一个「访客」：只带本模块真会读的两样，且每次换 IP 都能看出来。 */
function req(ip: string, extra: Record<string, string> = {}): GrowthRequestLike {
  return { ip, headers: { ...extra } };
}

const IP_A = '203.0.113.11';
const IP_B = '203.0.113.12';

function rows(): Array<{ kind: string; bucket: string; day: string }> {
  return getDb()
    .prepare('SELECT kind, bucket, day FROM growth_action_day ORDER BY kind, bucket, day')
    .all() as Array<{ kind: string; bucket: string; day: string }>;
}

describe('去重键（判据原文：同一 IP 刷新不重复计）', () => {
  it('★ 同 IP 同天连记三次 ⇒ 表里只有一行、数只加一', () => {
    expect(recordGrowthAction('app_open', req(IP_A))).toBe(true);
    expect(recordGrowthAction('app_open', req(IP_A))).toBe(false);
    expect(recordGrowthAction('app_open', req(IP_A))).toBe(false);
    expect(readGrowthSnapshot().counts.app_open).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('★ 换一天就算两次（自然日是去重键的一部分，不是永久每人一次）', () => {
    recordGrowthAction('app_open', req(IP_A));
    const yesterday = localDayKey(new Date(Date.now() - 86_400_000));
    getDb()
      .prepare(`UPDATE growth_action_day SET day = ? WHERE kind = 'app_open'`)
      .run(yesterday);
    recordGrowthAction('app_open', req(IP_A));
    expect(readGrowthSnapshot().counts.app_open).toBe(2);
  });

  it('三种动作各自独立计数，互不吞并', () => {
    recordGrowthAction('app_open', req(IP_A));
    recordGrowthAction('demo_enter', req(IP_A));
    recordGrowthAction('demo_enter', req(IP_A));
    const { counts } = readGrowthSnapshot();
    expect(counts.app_open).toBe(1);
    expect(counts.demo_enter).toBe(1);
    expect(counts.register_done).toBe(0);
  });

  it('★ 不同 IP 各算一次（桶不是常量，去重不是「全局一天一次」）', () => {
    recordGrowthAction('app_open', req(IP_A));
    recordGrowthAction('app_open', req(IP_B));
    expect(readGrowthSnapshot().counts.app_open).toBe(2);
  });
});

describe('探针剔除（C10：我们自己就是最大流量源）', () => {
  it('★ 带 X-SB-Probe 的请求一条都不写', () => {
    expect(isProbeRequest(req(IP_A, { 'x-sb-probe': 'prod-pulse' }))).toBe(true);
    expect(recordGrowthAction('demo_enter', req(IP_A, { 'x-sb-probe': 'prod-pulse' }))).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('★ 只带探针 UA 也剔（两个通道各自成立，将来新增脚本可能只带一个）', () => {
    const r = req(IP_A, { 'user-agent': 'studentbuddy-probe/1.0 (remote-signup)' });
    expect(isProbeRequest(r)).toBe(true);
    expect(recordGrowthAction('demo_enter', r)).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('`X-SB-Probe:` 空值不算探针（空标头＝没打标，不是打了空标）', () => {
    expect(isProbeRequest(req(IP_A, { 'x-sb-probe': '   ' }))).toBe(false);
    expect(recordGrowthAction('app_open', req(IP_A, { 'x-sb-probe': '' }))).toBe(true);
  });

  it('★ 反向：真实浏览器／curl／node 的 UA 一律照记（剔的是「认得出自己」，不是白名单外的人）', () => {
    for (const ua of ['curl/8.18.0', 'node', 'Go-http-client/2.0', '', 'UptimeRobot/2.0; https://uptimerobot.com']) {
      expect(isProbeRequest(req(`198.51.100.${ua.length}`, { 'user-agent': ua }))).toBe(false);
    }
  });
});

describe('隐私形状（不落裸 IP）', () => {
  it('★ 表里查不到任何一处 IP 明文，桶是 16 位十六进制', () => {
    recordGrowthAction('app_open', req(IP_A));
    const [row] = rows();
    expect(row).toBeDefined();
    expect(row?.bucket).toMatch(/^[0-9a-f]{16}$/); // ★ 有这一条，上一条的 `?.` 才不会把「一行都没有」测成通过
    expect(JSON.stringify(row)).not.toContain(IP_A);
  });

  it('同一 IP 在同库内恒定落同一桶（盐稳定），不同 IP 落不同桶', () => {
    const salt = (getDb().prepare('SELECT salt FROM growth_secret LIMIT 1').get() as { salt: string }).salt;
    expect(growthBucket(IP_A, salt)).toBe(growthBucket(IP_A, salt));
    expect(growthBucket(IP_A, salt)).not.toBe(growthBucket(IP_B, salt));
  });

  it('★ 盐由迁移生成且全库唯一一行（换成常量盐＝可被枚举，所以它必须是随机存的）', () => {
    const salts = getDb().prepare('SELECT salt FROM growth_secret').all() as Array<{ salt: string }>;
    expect(salts).toHaveLength(1);
    expect(salts[0]?.salt).toMatch(/^[0-9a-f]{32}$/); // `undefined` 走 `toMatch` 必红，不会假过
  });
});

describe('读侧形状与失败面', () => {
  it('★ 空库读出三个 0（不是缺键、也不是兜底假数）', () => {
    const { counts, firstDay } = readGrowthSnapshot();
    expect(Object.keys(counts).sort()).toEqual([...GROWTH_ACTIONS].sort());
    for (const a of GROWTH_ACTIONS) expect(counts[a]).toBe(0);
    expect(firstDay).toBeNull();
  });

  it('口径与数字一起出门（显示批不许自己编单位）', () => {
    const snap = readGrowthSnapshot();
    expect(snap.unit).toBe(GROWTH_UNIT);
    expect(snap.unitLabel).toBe(GROWTH_UNIT_LABEL); // ★ 口径由常量派生，不是响应体里另写一句
    expect(snap.unitLabel).toContain('次');
    expect(snap.unitLabel).toContain('同一来源 IP');
    expect(snap.unitLabel).not.toContain('人'); // ★ §1 总口径：现有设施算不出人
  });

  it('★ 记账失败只降级为「少个数」：表被拿走也不抛（它挂在登录路径上）', () => {
    getDb().exec('DROP TABLE growth_secret');
    expect(() => recordGrowthAction('app_open', req(IP_A))).not.toThrow();
    expect(recordGrowthAction('app_open', req(IP_A))).toBe(false);
  });

  it('`first_seen_at` 由库自己盖时间戳，本模块不伪造', () => {
    recordGrowthAction('app_open', req(IP_A));
    const { first_seen_at: seen } = getDb()
      .prepare('SELECT first_seen_at FROM growth_action_day')
      .get() as { first_seen_at: string };
    expect(seen).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
