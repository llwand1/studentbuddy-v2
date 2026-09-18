/**
 * learning/mention — 提及流水与窗口聚合（契约 docs/MEMORY-TREND-SPEC.md §1）。
 *
 * 本文件的断言分五类，每类钉住一个**容易静默错**的点：
 *  ① 写入：字段齐全 + `domain` 是**快照**（词条改领域不改写历史）；
 *  ② 补零：`labels` 与 `values` 等长且含今天——缺一格折线会整体左移一天；
 *  ③ 口径：窗口外不计入；已删词条仍进 total 但不进 topTerms；owner 过滤；
 *  ④ 钳制：`days` 越界不放大查询；
 *  ⑤ 高频榜（`topMentionedTerms`，**总**口径）：只含 `usage_count > 0`，且并列按名升序
 *     ——不是全序的话 `LIMIT` 在并列处取谁不确定，长期记忆的偏好画像会变成随机内容。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { recordMentions, mentionTrend, shortDayLabel, topMentionedTerms } from './mention.js';
import { countUsage } from './terms.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mention-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 固定「现在」，让跨天 / 跨窗口的边界可测（默认参数等于"不可测"） */
const NOW = new Date(2026, 8, 18, 10, 0, 0); // 2026-09-18 10:00 本地时间
/** 相对 NOW 偏移若干天的同一时刻 */
function at(dayOffset: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, 10, 0, 0);
}

/** 造一个词条（本模块只关心 id / domain，不关心释义内容） */
function seedTerm(id: string, term: string, domain: string): string {
  getDb()
    .prepare('INSERT INTO term_library (id, term, definition, domain) VALUES (?, ?, ?, ?)')
    .run(id, term, `${term} 的释义`, domain);
  return id;
}

interface MentionRow {
  term_id: string;
  domain: string;
  owner_id: string;
  mentioned_day: string;
}

function rows(): MentionRow[] {
  return getDb()
    .prepare('SELECT term_id, domain, owner_id, mentioned_day FROM term_mention_log ORDER BY rowid')
    .all() as MentionRow[];
}

function count(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM term_mention_log').get() as { c: number }).c;
}

describe('learning/mention — 写入', () => {
  it('落一行流水：term_id / domain / owner_id / mentioned_day（本地日历日）齐全', () => {
    const id = seedTerm('t1', '闭包', 'js');
    expect(recordMentions([{ termId: id, domain: 'js' }], null, NOW)).toBe(1);
    const [row] = rows();
    expect(row?.term_id).toBe('t1');
    expect(row?.domain).toBe('js');
    // ★ v31 起口径改为 `''`（无主行）：改前是 SQL `NULL`，与 `terms`/v30 那套"无主 = 谁都看不见"
    //   不同源 ⇒ 每个读点都要先问"这张表是哪一套"。对齐后全族共用同一个判据。
    expect(row?.owner_id).toBe('');
    expect(row?.mentioned_day).toBe('2026-09-18');
  });

  it('空数组：返回 0 且一行不落', () => {
    expect(recordMentions([], null, NOW)).toBe(0);
    expect(count()).toBe(0);
  });

  it('批量落多行时 each 一行（不是折叠成一行）', () => {
    const a = seedTerm('t1', '闭包', 'js');
    const b = seedTerm('t2', '逆元', 'math');
    expect(
      recordMentions(
        [
          { termId: a, domain: 'js' },
          { termId: b, domain: 'math' },
        ],
        null,
        NOW,
      ),
    ).toBe(2);
    expect(count()).toBe(2);
  });

  it('domain 是**快照**：词条随后改领域，已落的历史流水不被改写', () => {
    const id = seedTerm('t1', '梯度下降', '算法');
    recordMentions([{ termId: id, domain: '算法' }], null, at(-2));
    // 词条被人挪到别的领域（tidy.renameDomain / 手动编辑都走这条 UPDATE）
    getDb().prepare('UPDATE term_library SET domain = ? WHERE id = ?').run('机器学习', id);

    // 历史那行仍是「算法」——否则趋势图会整体漂移（用户什么都没做，图却变了）
    expect(rows()[0]?.domain).toBe('算法');

    // 而"下一次提及"记的是当下的新领域
    recordMentions([{ termId: id, domain: '机器学习' }], null, NOW);
    expect(rows()[1]?.domain).toBe('机器学习');
  });
});

describe('learning/mention — 窗口聚合', () => {
  it('labels 与 values 等长、含今天、无提及的日子补 0（缺格会让折线错位）', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], null, at(0));

    const t = mentionTrend(7, null, NOW);
    expect(t.days).toBe(7);
    expect(t.labels).toHaveLength(7);
    expect(t.values).toHaveLength(7);
    expect(t.labels[0]).toBe('2026-09-12'); // 7 天窗口的**首日**（含今天往回数 6 天）
    expect(t.labels[6]).toBe('2026-09-18'); // 末位 = 今天
    expect(t.values).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(t.total).toBe(1);
  });

  it('窗口外的提及不计入（7 天窗口看不到 8 天前那次）', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], null, at(-7)); // 2026-09-11
    const t = mentionTrend(7, null, NOW);
    expect(t.total).toBe(0);
    expect(t.values.every((v) => v === 0)).toBe(true);
  });

  it('同一天多次提及累加到同一格；跨天分格', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], null, at(-1));
    recordMentions([{ termId: id, domain: 'js' }], null, at(0));
    recordMentions([{ termId: id, domain: 'js' }], null, at(0));
    const t = mentionTrend(7, null, NOW);
    expect(t.values[5]).toBe(1); // 昨天
    expect(t.values[6]).toBe(2); // 今天两次
    expect(t.total).toBe(3);
  });

  it('topDomains / topTerms 按次数降序，同数按名字升序（全序，结果稳定）', () => {
    // ★ 名字刻意用 ASCII：SQLite 的 ORDER BY 走 UTF-8 **字节序**，而 JS 的 localeCompare
    //   走**拼音**——用中文名会让这条断言变成在测 collation 差异，而不是在测产品行为。
    const a = seedTerm('t1', 'aaa', 'js');
    const b = seedTerm('t2', 'bbb', 'math');
    const c = seedTerm('t3', 'ccc', 'math');
    // 插入序刻意与名字序相反（bbb 先于 ccc）：排序没生效就会露馅
    recordMentions([{ termId: b, domain: 'math' }], null, NOW);
    recordMentions([{ termId: c, domain: 'math' }], null, NOW);
    recordMentions([{ termId: a, domain: 'js' }], null, NOW);

    const t = mentionTrend(7, null, NOW);
    expect(t.topDomains).toEqual([
      { domain: 'math', count: 2 },
      { domain: 'js', count: 1 },
    ]);
    expect(t.topTerms).toEqual([
      { term: 'aaa', count: 1 },
      { term: 'bbb', count: 1 },
      { term: 'ccc', count: 1 },
    ]);
    expect(t.total).toBe(3);
  });

  it('已删除的词条：仍计入 total，但不进 topTerms（JOIN 拿不到名字）', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], null, NOW);
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run(id);

    const t = mentionTrend(7, null, NOW);
    expect(t.total).toBe(1); // 流水是历史事实，不随词条存亡消失
    expect(t.topTerms).toHaveLength(0);
    expect(t.topDomains.map((d) => d.domain)).toEqual(['js']); // 领域的快照仍在
  });

  it('ownerId 给定时只统计该 owner 的提及', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], 'u1', NOW);
    recordMentions([{ termId: id, domain: 'js' }], 'u2', NOW);
    recordMentions([{ termId: id, domain: 'js' }], 'u2', NOW);

    expect(mentionTrend(7, 'u1', NOW).total).toBe(1);
    expect(mentionTrend(7, 'u2', NOW).total).toBe(2);
  });

  it("★ v31：null（无主）与真实 owner **互不可见**——改前 null 是「不过滤」⇒ 跨用户求和", () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], null, NOW); // 无主行
    recordMentions([{ termId: id, domain: 'js' }], 'u1', NOW);
    recordMentions([{ termId: id, domain: 'js' }], 'u1', NOW);

    expect(mentionTrend(7, null, NOW).total).toBe(1); // 未登录只看自己的无主行
    expect(mentionTrend(7, 'u1', NOW).total).toBe(2); // 登录用户只看自己的
    expect(mentionTrend(7, 'u2', NOW).total).toBe(0); // 别人的一条都不沾
    // ★ 这条断言是「跨用户泄露」的直接锁：改回 ownerFilter 的"null 就不加条件"，
    //   上面第一行会变成 3（把 u1 的两笔一起算进来）——那正是改前的行为。
  });

  it('days 归一：0 回落默认、负数钳到 1、过大钳到 90（防一次查询拉整张表）', () => {
    expect(mentionTrend(0, null, NOW).days).toBe(7);
    expect(mentionTrend(-5, null, NOW).days).toBe(1);
    expect(mentionTrend(1000, null, NOW).days).toBe(90);
    // 钳制后 labels 与 values 仍然等长（钳的是天数，不是数组）
    const big = mentionTrend(1000, null, NOW);
    expect(big.labels).toHaveLength(90);
    expect(big.values).toHaveLength(90);
  });

  it('空库：全 0 但结构完整（不返回 null / 不抛）', () => {
    const t = mentionTrend(7, null, NOW);
    expect(t.total).toBe(0);
    expect(t.topDomains).toEqual([]);
    expect(t.topTerms).toEqual([]);
    expect(t.values).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('learning/mention — 横轴标签', () => {
  it('shortDayLabel 去掉年份；非标准键原样返回（不抛）', () => {
    expect(shortDayLabel('2026-09-18')).toBe('09-18');
    expect(shortDayLabel('09-18')).toBe('09-18');
    expect(shortDayLabel('')).toBe('');
  });
});

/**
 * 高频词条榜（**总**口径：走 `usage_count`，与 `domainMentionTotals` 同源、**含流水建表前的历史**）。
 * 它是长期记忆偏好画像的上游（`chat/memory-digest.ts`），故两件事必须锁死：
 * 「一次没提过的进不来」与「并列处是全序」——后者不做，`LIMIT` 取谁就不确定，
 * 画像内容会随查询计划变（同一份数据两次跑出两份画像，是最难查的那种不定）。
 * ★ 造数走**真实 `countUsage`**（命中即 +1）：直改 `usage_count` 会把「命中逻辑」
 *   与「计数口径」一起绕过，测出来只是我用 SQL 写进去的数。
 */
describe('learning/mention — 高频词条榜（总口径）', () => {
  it('按 usage_count 降序；**一次没提过的词条进不来**（不构成偏好）', () => {
    seedTerm('t-a', 'alpha', 'math');
    seedTerm('t-b', 'beta', 'math');
    seedTerm('t-c', 'gamma', 'english'); // 一次不提
    for (let i = 0; i < 3; i++) countUsage('alpha', null);
    countUsage('beta', null);

    expect(topMentionedTerms(null)).toEqual([
      { term: 'alpha', count: 3 },
      { term: 'beta', count: 1 },
    ]);
  });

  it('并列时按词条名升序 ⇒ **全序**（不稳定排序会让「取 top N」变成「取随机 N 个」）', () => {
    seedTerm('t-z', 'zeta', 'math');
    seedTerm('t-a', 'alpha', 'math');
    countUsage('zeta', null);
    countUsage('alpha', null);

    expect(topMentionedTerms(null).map((r) => r.term)).toEqual(['alpha', 'zeta']);
  });

  it('limit 正常生效；传 0 视作「没传」回落默认；超大值钳到 50（不放大查询）', () => {
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      seedTerm(`t-x${t}`, `term-${t}`, 'math');
      countUsage(`term-${t}`, null);
    }
    expect(topMentionedTerms(null, 2)).toHaveLength(2);
    expect(topMentionedTerms(null, 0)).toHaveLength(5); // 0 ⇒ 回落默认（不是「取 0 条」）
    expect(topMentionedTerms(null, 999)).toHaveLength(5); // 钳到 50，而库里只有 5 条
  });

  it('空库返回空数组（不抛、不返回 undefined）', () => {
    expect(topMentionedTerms(null)).toEqual([]);
  });
});
