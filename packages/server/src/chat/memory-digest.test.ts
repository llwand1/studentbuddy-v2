/**
 * chat/memory-digest 单测（`openIsolated` 隔离库，同 `memory.test.ts` 手法）。
 * 钉契约 `docs/MEMORY-TREND-SPEC.md` §3 的两层：
 *  · **纯函数层** `buildPreferenceDrafts`——谁算偏好、`importance` 怎么算、各取几个；
 *  · **IO 层** `refreshTermDigest`——从**真词条库**取数、幂等入库、归属隔离。
 *
 * ★ 本文件最要紧的一条回归锁是「**content 里不许出现次数**」：次数一旦进了 content，
 *   唯一键 `(user_id, kind, content)` 就会让次数每变一次就新增一行，而旧行**再也无法被更新**
 *   ⇒ 注入段里同时出现「累计提及 3 次」和「累计提及 42 次」两条互相打脸的记录。
 * ★ 造数一律走**真实 `countUsage`**（命中即 `usage_count + 1`），不直接 `UPDATE` 那一列：
 *   直改列会把「命中逻辑」与「计数口径」一起绕过，测出来只是我用 SQL 写进去的数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_DIGEST_FULL_MENTIONS, MEMORY_MIN_IMPORTANCE } from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { countUsage, saveTerms } from '../learning/terms.js';
import { loadMemoryItems, upsertMemoryItems } from './memory.js';
import { buildPreferenceDrafts, refreshTermDigest } from './memory-digest.js';

beforeEach(() => openIsolated(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-digest-'))));
afterEach(() => closeDb());

/**
 * 造一个有「学了什么」的库：4 个词条分布在 3 个领域，`delta` 刻意一次不提。
 * 造完的既成事实：math 提及 4（alpha 3 + beta 1）、english 提及 4（gamma 4）、physics 提及 0。
 */
function seedLibrary() {
  saveTerms([
    { term: 'alpha', definition: 'a', domain: 'math', importance: 0.5 },
    { term: 'beta', definition: 'b', domain: 'math', importance: 0.5 },
    { term: 'gamma', definition: 'g', domain: 'english', importance: 0.5 },
    { term: 'delta', definition: 'd', domain: 'physics', importance: 0.5 },
  ]);
  for (let i = 0; i < 3; i++) countUsage('alpha');
  countUsage('beta');
  for (let i = 0; i < 4; i++) countUsage('gamma');
}

const contents = () => loadMemoryItems().map((m) => m.content);
const importanceOf = (content: string) =>
  loadMemoryItems().find((m) => m.content === content)?.importance ?? -1;

describe('buildPreferenceDrafts（纯函数：榜单 → 草稿）', () => {
  it('领域与词条**各**取 top N（3/3），按提及数降序——输入没排序也能取对', () => {
    const drafts = buildPreferenceDrafts({
      // 刻意乱序：纯函数要对自己的输出负责，不能指望调用方先排好
      domains: [
        { domain: 'zzz', mentionCount: 2 },
        { domain: 'aaa', mentionCount: 9 },
        { domain: 'mmm', mentionCount: 5 },
        { domain: 'ddd', mentionCount: 1 }, // 第 4 名，超名额
      ],
      terms: [
        { term: 't2', count: 7 },
        { term: 't1', count: 3 },
        { term: 't4', count: 1 },
        { term: 't3', count: 20 },
      ],
    });
    expect(drafts.map((d) => d.content)).toEqual([
      '常学领域：aaa',
      '常学领域：mmm',
      '常学领域：zzz',
      '高频术语：t3',
      '高频术语：t2',
      '高频术语：t1',
    ]);
  });

  it('importance 随提及数**单调递增并饱和于 1**（无界线性会把整张画像的尺度拉爆）', () => {
    const imp = (n: number) =>
      buildPreferenceDrafts({ domains: [{ domain: 'd', mentionCount: n }], terms: [] })[0]?.importance ?? -1;
    expect(imp(1)).toBeGreaterThan(0);
    expect(imp(3)).toBeGreaterThan(imp(1));
    expect(imp(10)).toBeGreaterThan(imp(3));
    expect(imp(MEMORY_DIGEST_FULL_MENTIONS)).toBe(1);
    expect(imp(MEMORY_DIGEST_FULL_MENTIONS * 100)).toBe(1); // 饱和：再多也不涨
  });

  it('提及数为 0 的领域/词条**一律丢弃**（一次没提过，不构成偏好）', () => {
    expect(
      buildPreferenceDrafts({
        domains: [{ domain: 'ghost', mentionCount: 0 }],
        terms: [{ term: 'ghost-term', count: 0 }],
      }),
    ).toEqual([]);
  });

  it('★ content 里**不许出现次数**：唯一键含 content，写进去会让每次次数变化都新增一行', () => {
    const before = buildPreferenceDrafts({ domains: [{ domain: 'math', mentionCount: 3 }], terms: [] })[0];
    const after = buildPreferenceDrafts({ domains: [{ domain: 'math', mentionCount: 42 }], terms: [] })[0];
    expect(after?.content).toBe(before?.content); // 身份（学的是谁）必须稳定
    expect(after?.importance ?? 0).toBeGreaterThan(before?.importance ?? 1); // 强度（多频）由 importance 表达
    expect(before?.content ?? '').not.toMatch(/累计提及|\d+\s*次/);
  });

  it('全部写成 preference；领域与词条前缀不同（「在学哪个方向」≠「在抠哪个概念」）', () => {
    const drafts = buildPreferenceDrafts({
      domains: [{ domain: 'math', mentionCount: 2 }],
      terms: [{ term: 'x', count: 2 }],
    });
    expect(drafts.every((d) => d.kind === 'preference')).toBe(true);
    expect(drafts.map((d) => d.content)).toEqual(['常学领域：math', '高频术语：x']);
  });
});

describe('refreshTermDigest（IO：真词条库 → 画像）', () => {
  it('从真词条库取数：有提及的领域/词条进画像，**零提及的进不来**', () => {
    seedLibrary();
    expect(refreshTermDigest()).toBe(5); // 2 个有提及的领域 + 3 个有提及的词条
    const c = contents();
    expect(c).toContain('常学领域：math');
    expect(c).toContain('常学领域：english');
    expect(c).not.toContain('常学领域：physics'); // delta 一次没提过
    expect(c).toContain('高频术语：gamma');
    expect(c).not.toContain('高频术语：delta');
  });

  it('importance 跟着**真实 usage_count** 走：gamma(4) > alpha(3) > beta(1)', () => {
    seedLibrary();
    refreshTermDigest();
    expect(importanceOf('高频术语：gamma')).toBeGreaterThan(importanceOf('高频术语：alpha'));
    expect(importanceOf('高频术语：alpha')).toBeGreaterThan(importanceOf('高频术语：beta'));
    expect(importanceOf('高频术语：beta')).toBeGreaterThanOrEqual(MEMORY_MIN_IMPORTANCE);
  });

  it('**幂等**：连跑三次不堆行、content 一个字都不变', () => {
    seedLibrary();
    refreshTermDigest();
    const first = contents().sort();
    refreshTermDigest();
    refreshTermDigest();
    expect(contents().sort()).toEqual(first);
    expect(loadMemoryItems()).toHaveLength(first.length);
  });

  it('次数增长后重跑：**分数只升不降**（`ON CONFLICT` 取 MAX），且仍是一行', () => {
    seedLibrary();
    refreshTermDigest();
    const low = importanceOf('高频术语：beta');
    for (let i = 0; i < 20; i++) countUsage('beta'); // beta 1 → 21 次，跃升为最高频
    refreshTermDigest();
    expect(importanceOf('高频术语：beta')).toBeGreaterThan(low);
    expect(loadMemoryItems().filter((m) => m.content === '高频术语：beta')).toHaveLength(1);
  });

  it('只写 preference：不新增也不改写 profile / goal / weakness', () => {
    seedLibrary();
    upsertMemoryItems([{ kind: 'profile', content: '喜欢先看例子再看定义', importance: 0.6 }]);
    refreshTermDigest();
    expect(new Set(loadMemoryItems().map((m) => m.kind))).toEqual(new Set(['preference', 'profile']));
    expect(loadMemoryItems().find((m) => m.kind === 'profile')?.content).toBe('喜欢先看例子再看定义');
  });

  it('归属隔离：同一份榜单按 owner 各写一份，**同 content 不同人 = 两行互不覆盖**', () => {
    seedLibrary();
    refreshTermDigest('u1');
    refreshTermDigest('u2');
    const rows = getDb()
      .prepare('SELECT user_id AS uid, COUNT(*) AS c FROM user_memory GROUP BY user_id ORDER BY user_id')
      .all() as Array<{ uid: string; c: number }>;
    expect(rows).toEqual([
      { uid: 'u1', c: 5 },
      { uid: 'u2', c: 5 },
    ]);
  });

  it('空词条库 → 返回 0 且**一行不写**（没有偏好就是没有，不写占位记忆）', () => {
    expect(refreshTermDigest()).toBe(0);
    expect(loadMemoryItems()).toEqual([]);
  });

  it('写进去的**每一条都过得了注入门槛**（低于门槛的只是占名额的垃圾行）', () => {
    seedLibrary();
    refreshTermDigest();
    const items = loadMemoryItems();
    expect(items.length).toBeGreaterThan(0);
    for (const m of items) expect(m.importance).toBeGreaterThanOrEqual(MEMORY_MIN_IMPORTANCE);
  });
});
