/**
 * learning/mention — 提及流水与窗口聚合（契约 docs/MEMORY-TREND-SPEC.md §1）。
 *
 * 本文件的断言分四类，每类钉住一个**容易静默错**的点：
 *  ① 写入：字段齐全 + `domain` 是**快照**（词条改领域不改写历史）；
 *  ② 补零：`labels` 与 `values` 等长且含今天——缺一格折线会整体左移一天；
 *  ③ 口径：窗口外不计入；已删词条仍进 total 但不进 topTerms；owner 过滤；
 *  ④ 钳制：`days` 越界不放大查询。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { recordMentions, mentionTrend, shortDayLabel } from './mention.js';

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
  owner_id: string | null;
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
    expect(row?.owner_id).toBeNull(); // null = 未登录单人本地模式，不是 ''
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

  it('ownerId 给定时只统计该 owner 的提及；null 不过滤', () => {
    const id = seedTerm('t1', '闭包', 'js');
    recordMentions([{ termId: id, domain: 'js' }], 'u1', NOW);
    recordMentions([{ termId: id, domain: 'js' }], 'u2', NOW);
    recordMentions([{ termId: id, domain: 'js' }], 'u2', NOW);

    expect(mentionTrend(7, 'u1', NOW).total).toBe(1);
    expect(mentionTrend(7, 'u2', NOW).total).toBe(2);
    expect(mentionTrend(7, null, NOW).total).toBe(3); // 本地单人模式：不过滤
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
