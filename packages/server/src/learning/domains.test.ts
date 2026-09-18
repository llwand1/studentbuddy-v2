import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { createDomain, updateDomain, renameDomainEntry, removeDomain, domainStats, DomainError } from './domains.js';
import { saveOneTerm, saveTerms, listTerms, countUsage } from './terms.js';

/**
 * learning/domains — 领域 CRUD（v19：领域升为一等实体）。
 *
 * 本文件锁的是**领域与词条对等的那些能力**，尤其是 v19 之前结构上做不到的三件事：
 * 建空领域 / 空领域改名 / 删领域。以及两条不变式的守卫：
 *  · `term_library.domain ⊆ term_domain.name`（写入侧自动登记）
 *  · 改名撞 UNIQUE(term, domain) 时必须并入而不是抛错
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-domains-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 抓同步抛出的 DomainError（仓库禁 `!` 非空断言，故显式判空后返回）。 */
function catchDomainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('预期抛 DomainError，但没有抛');
}

const domainNames = () =>
  (getDb().prepare('SELECT name FROM term_domain ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);

describe('learning/domains — 登记册（新建 / 改说明 / 统计）', () => {
  it('v19 迁移预置 general：新库即有默认领域，且零词条（count=0）', () => {
    expect(domainNames()).toContain('general');
    const stat = domainStats().domains.find((d) => d.domain === 'general');
    expect(stat?.count).toBe(0);
  });

  it('新建领域**允许零词条**，并立刻出现在统计里（v19 前做不到：没词条就不存在领域）', () => {
    const { row, created } = createDomain('Math', '高数与线代');
    expect(created).toBe(true);
    expect(row.name).toBe('math'); // 名称规范化：小写
    expect(row.note).toBe('高数与线代');
    expect(row.count).toBe(0);

    const stat = domainStats().domains.find((d) => d.domain === 'math');
    expect(stat?.count).toBe(0);
    expect(stat?.note).toBe('高数与线代');
  });

  it('新建已存在的领域：created=false，且**不覆盖**既有说明（幂等，点两次不报错）', () => {
    createDomain('cs', '原说明');
    const again = createDomain('CS', '新说明');
    expect(again.created).toBe(false);
    expect(again.row.note).toBe('原说明');
  });

  it('空领域名 → 400', () => {
    expect(catchDomainError(() => createDomain('   ')).status).toBe(400);
  });

  it('改说明只动 note（领域名不变）；领域不存在 → null', () => {
    createDomain('bio', '旧');
    const row = updateDomain('bio', '新');
    expect(row?.note).toBe('新');
    expect(row?.name).toBe('bio');
    expect(updateDomain('nope', 'x')).toBeNull();
  });

  it('domainStats 的 total/today 仍是**词条**口径，domains 里是各自的词条数', () => {
    saveTerms([
      { term: 'a', definition: 'a', domain: 'english', importance: 0.5 },
      { term: 'b', definition: 'b', domain: 'english', importance: 0.5 },
      { term: 'c', definition: 'c', domain: 'math', importance: 0.5 },
    ]);
    const s = domainStats();
    expect(s.total).toBe(3);
    expect(s.today).toBe(3);
    expect(s.domains.find((d) => d.domain === 'english')?.count).toBe(2);
    expect(s.domains.find((d) => d.domain === 'math')?.count).toBe(1);
  });
});

describe('learning/domains — 改名（词条随迁 + 撞域并入）', () => {
  it('**空领域改名**：只动登记册，moved=0（v19 前这条路径根本走不通）', () => {
    createDomain('mathx');
    const r = renameDomainEntry('mathx', 'math');
    expect(r.moved).toBe(0);
    expect(r.merged).toBe(false);
    expect(domainNames()).toContain('math');
    expect(domainNames()).not.toContain('mathx');
  });

  it('有词条的领域改名：词条随迁，count 跟着走', () => {
    saveTerms([{ term: 'closure', definition: '闭包', domain: 'cs', importance: 0.8 }]);
    const r = renameDomainEntry('cs', '计算机');
    expect(r.moved).toBe(1);
    expect(listTerms('计算机')).toHaveLength(1);
    expect(listTerms('cs')).toHaveLength(0);
    expect(domainStats().domains.find((d) => d.domain === '计算机')?.count).toBe(1);
  });

  it('目标领域**已存在** ⇒ 两域合一（merged=true，旧名从登记册移除，词条汇入）', () => {
    saveTerms([
      { term: 'a', definition: 'a', domain: 'math', importance: 0.5 },
      { term: 'b', definition: 'b', domain: '数学', importance: 0.5 },
    ]);
    const r = renameDomainEntry('数学', 'math');
    expect(r.merged).toBe(true);
    expect(r.moved).toBe(1);
    expect(domainNames()).not.toContain('数学');
    expect(domainStats().domains.find((d) => d.domain === 'math')?.count).toBe(2);
  });

  it('目标领域已有**同名词条**：并入而不是撞 UNIQUE(term, domain) 抛错', () => {
    saveTerms([
      { term: 'closure', definition: '数学的闭包', domain: 'math', importance: 0.9 },
      { term: 'closure', definition: '英文单词闭包', domain: 'english', importance: 0.4 },
    ]);
    // 两域合并时两条 closure 会撞 (term, domain) 唯一键——由 tidy 的并入逻辑兜住
    expect(() => renameDomainEntry('english', 'math')).not.toThrow();
    const merged = listTerms('math');
    expect(merged).toHaveLength(1);
    // ⚠️ 两条**同名**词条合并时 aliases 必然为空：`mergeRows` 明确「主词条名不进别名」
    // （能进别名的只有被并行的**旧名**，这里新旧名相同故无处可挂）。所以这里不锁别名，
    // 改锁「概念不丢」的另一面——释义与重要度取高者（math 侧 importance 0.9）。
    expect(merged[0]?.definition).toBe('数学的闭包');
    expect(merged[0]?.importance).toBe(0.9);
  });

  it('领域不存在 → 404；新旧同名 → 400', () => {
    expect(catchDomainError(() => renameDomainEntry('ghost', 'cs')).status).toBe(404);
    createDomain('cs');
    expect(catchDomainError(() => renameDomainEntry('cs', 'cs')).status).toBe(400);
  });
});

describe('learning/domains — 删除（词条迁 general，一条不删）', () => {
  it('删除领域：词条**迁入 general 而非删除**，登记册移除旧名', () => {
    saveTerms([
      { term: 'x', definition: 'x', domain: 'temp', importance: 0.5 },
      { term: 'y', definition: 'y', domain: 'temp', importance: 0.5 },
    ]);
    const r = removeDomain('temp');
    expect(r.moved).toBe(2);
    expect(r.target).toBe('general');
    expect(listTerms()).toHaveLength(2); // 词条一条未丢
    expect(listTerms('general')).toHaveLength(2);
    expect(domainNames()).not.toContain('temp');
  });

  it('general 是默认领域，拒绝删除（409）——它是迁词条的终点', () => {
    expect(catchDomainError(() => removeDomain('general')).status).toBe(409);
    expect(domainNames()).toContain('general');
  });

  it('领域不存在 → 404', () => {
    expect(catchDomainError(() => removeDomain('ghost')).status).toBe(404);
  });

  it('general 里已有同名词条时删域：并入不炸约束', () => {
    saveTerms([
      { term: 'p', definition: 'general 里的 p', domain: 'general', importance: 0.5 },
      { term: 'p', definition: 'other 里的 p', domain: 'other', importance: 0.7 },
    ]);
    expect(() => removeDomain('other')).not.toThrow();
    expect(listTerms('general')).toHaveLength(1);
  });
});

describe('learning/domains — 写入侧登记 + 孤儿兜底（v19 不变式）', () => {
  it('saveOneTerm 落新领域 → 登记册自动出现（无需人工同步）', () => {
    saveOneTerm('牛顿', '力学家', 'physics');
    expect(domainNames()).toContain('physics');
  });

  it('saveTerms 落新领域 → 同样自动登记（AI 抽取吐新领域名的路径）', () => {
    saveTerms([{ term: '熵', definition: '混乱度', domain: 'thermo', importance: 0.6 }]);
    expect(domainNames()).toContain('thermo');
    expect(domainStats().domains.find((d) => d.domain === 'thermo')?.count).toBe(1);
  });

  it('孤儿域兜底：绕过写入侧直插词条（登记册缺失）时，统计仍能列出该域，不让词条"隐身"', () => {
    getDb()
      .prepare(`INSERT INTO term_library (id, term, definition, domain) VALUES ('ghost-row', 't', 'd', 'orphan')`)
      .run();
    expect(domainNames()).not.toContain('orphan'); // 确实没登记
    const stat = domainStats().domains.find((d) => d.domain === 'orphan');
    expect(stat?.count).toBe(1); // 但统计兜底列出了它
    expect(stat?.note).toBe(''); // 孤儿域没有说明
  });
});

/**
 * 领域总提及数 + 偏好领域（契约 `docs/MEMORY-TREND-SPEC.md` §2）。
 *
 * ★ 本组刻意**走真实 `countUsage`** 而不是直接 `UPDATE usage_count`：契约 §1.5 说得很清楚，
 *   「总提及数」的口径是 `usage_count` 聚合（含流水建表前的历史），它必须由**写入侧**长出来。
 *   直接改列会把「命中逻辑」与「计数口径」一起绕过，测出来的就只是我用 SQL 写进去的数。
 */
describe('learning/domains — 领域总提及数 + 偏好领域（契约 §2）', () => {
  /** 让 `term` 被提及 `times` 次（每次命中 +1；`countUsage` 按调用次数计，不按出现次数）。 */
  function mention(term: string, times: number) {
    for (let i = 0; i < times; i++) countUsage(term, null, new Date(2026, 8, 18, 10, i));
  }

  it('mentionCount = 该领域内所有词条 usage_count 之和，preferred 与 domains 两处**同源**', () => {
    saveTerms([
      { term: 'alpha', definition: 'a', domain: 'math', importance: 0.5 },
      { term: 'beta', definition: 'b', domain: 'math', importance: 0.5 },
      { term: 'gamma', definition: 'g', domain: 'english', importance: 0.5 },
    ]);
    mention('alpha', 3);
    mention('beta', 1);
    mention('gamma', 4);

    const s = domainStats();
    expect(s.domains.find((d) => d.domain === 'math')?.mentionCount).toBe(4); // 3 + 1
    expect(s.domains.find((d) => d.domain === 'english')?.mentionCount).toBe(4);
    // 同一个数必须只有一个出处（`mention.ts#domainMentionTotals`）：domains 与 preferred 不许各算各的
    expect(s.preferred.find((p) => p.domain === 'math')?.mentionCount).toBe(4);
    expect(s.preferred.find((p) => p.domain === 'english')?.mentionCount).toBe(4);
  });

  it('preferred 按提及数降序；**同提及数时按词条数降序**（4=4 时 math 的 2 条压过 english 的 1 条）', () => {
    saveTerms([
      { term: 'alpha', definition: 'a', domain: 'math', importance: 0.5 },
      { term: 'beta', definition: 'b', domain: 'math', importance: 0.5 },
      { term: 'gamma', definition: 'g', domain: 'english', importance: 0.5 },
    ]);
    mention('alpha', 3);
    mention('beta', 1);
    mention('gamma', 4);

    expect(domainStats().preferred.map((p) => p.domain)).toEqual(['math', 'english']);
  });

  it('preferred 是**全序**：提及数与词条数都相同时按领域名升序（同一份数据每次顺序逐字相同）', () => {
    saveTerms([
      { term: 't-z', definition: 'z', domain: 'zeta', importance: 0.5 },
      { term: 't-a', definition: 'a', domain: 'alpha2', importance: 0.5 },
    ]);
    mention('t-z', 1);
    mention('t-a', 1);

    // 1=1、count 1=1 ⇒ 只剩名字这一级，'alpha2' < 'zeta'
    expect(domainStats().preferred.map((p) => p.domain)).toEqual(['alpha2', 'zeta']);
  });

  it('零提及领域**不进** preferred，但仍照旧出现在 domains（mentionCount=0，不隐藏）', () => {
    saveTerms([
      { term: 'alpha', definition: 'a', domain: 'math', importance: 0.5 },
      { term: 'delta', definition: 'd', domain: 'physics', importance: 0.5 },
    ]);
    createDomain('empty'); // 连词条都没有的空领域
    mention('alpha', 2);

    const s = domainStats();
    expect(s.preferred.map((p) => p.domain)).toEqual(['math']); // physics（词条 1 条但零提及）与 empty 都不算偏好
    expect(s.domains.find((d) => d.domain === 'physics')?.mentionCount).toBe(0);
    expect(s.domains.find((d) => d.domain === 'empty')?.mentionCount).toBe(0);
    expect(s.domains.find((d) => d.domain === 'empty')?.count).toBe(0); // v19 语义不受影响：空领域仍在册
  });

  it('**提及数与词条数无关**：一条高频词条可以压过多条零提及词条', () => {
    saveTerms([
      { term: 'hot', definition: 'h', domain: 'solo', importance: 0.5 },
      { term: 'c1', definition: '1', domain: 'crowd', importance: 0.5 },
      { term: 'c2', definition: '2', domain: 'crowd', importance: 0.5 },
      { term: 'c3', definition: '3', domain: 'crowd', importance: 0.5 },
    ]);
    mention('hot', 5);

    const s = domainStats();
    expect(s.domains.find((d) => d.domain === 'crowd')?.count).toBe(3); // 词条数 crowd 赢
    expect(s.preferred.map((p) => p.domain)).toEqual(['solo']); // 但偏好榜 solo 赢（它才有提及）
  });
});

/**
 * ★ v28 复习范围（契约 EBBINGHAUS-SPEC §9）：`domainStats` 多给两个字段，
 *   它们是**前端领域三态勾选框（全选 / 部分 / 未选）的唯一数据源**。
 * 两者不可换算——`reviewEnabled` 是"用户点出来的开关"，`reviewCount` 是"现算的有效条数"。
 * 若这里算错，UI 上就会出现"明明全选了却显示部分"或反过来的假象，而数据本身是对的。
 */
describe('learning/domains — 复习范围计数（v28）', () => {
  const find = (name: string) => domainStats().domains.find((d) => d.domain === name);
  const scopeTerm = (term: string, enabled: boolean) =>
    getDb()
      .prepare('UPDATE term_library SET review_enabled = ? WHERE term = ?')
      .run(enabled ? 1 : 0, term);

  it('默认全不选：reviewEnabled=false 且 reviewCount=0（空领域也是 0）', () => {
    createDomain('empty-one');
    saveTerms([{ term: 'a', definition: 'A', domain: 'rv-default', importance: 0.5 }]);
    const d = find('rv-default');
    expect(d?.count).toBe(1);
    expect(d?.reviewEnabled).toBe(false);
    expect(d?.reviewCount).toBe(0);
    expect(find('empty-one')).toMatchObject({ count: 0, reviewEnabled: false, reviewCount: 0 });
  });

  it('领域开关打开 ⇒ reviewCount 等于 count（该域全部跟随）', () => {
    saveTerms([
      { term: 'b1', definition: '1', domain: 'rv-on', importance: 0.5 },
      { term: 'b2', definition: '2', domain: 'rv-on', importance: 0.5 },
    ]);
    getDb().prepare(`UPDATE term_domain SET review_enabled = 1 WHERE name = 'rv-on'`).run();
    expect(find('rv-on')).toMatchObject({ count: 2, reviewEnabled: true, reviewCount: 2 });
  });

  it('★ 部分纳入：开关开着但词条被逐条反选 ⇒ reviewEnabled=true 而 reviewCount < count', () => {
    saveTerms([
      { term: 'c1', definition: '1', domain: 'rv-part', importance: 0.5 },
      { term: 'c2', definition: '2', domain: 'rv-part', importance: 0.5 },
      { term: 'c3', definition: '3', domain: 'rv-part', importance: 0.5 },
    ]);
    getDb().prepare(`UPDATE term_domain SET review_enabled = 1 WHERE name = 'rv-part'`).run();
    scopeTerm('c2', false); // 单独反选一条
    // ★ 这一对差（true 但 2/3）就是 UI「部分选中」的判据；少了它，三态会退化成两态。
    expect(find('rv-part')).toMatchObject({ count: 3, reviewEnabled: true, reviewCount: 2 });
  });

  it('★ 反向部分：领域关着，但词条被单独勾进来 ⇒ reviewCount > 0 而 reviewEnabled=false', () => {
    saveTerms([
      { term: 'd1', definition: '1', domain: 'rv-off', importance: 0.5 },
      { term: 'd2', definition: '2', domain: 'rv-off', importance: 0.5 },
    ]);
    scopeTerm('d1', true);
    expect(find('rv-off')).toMatchObject({ count: 2, reviewEnabled: false, reviewCount: 1 });
  });

  it('★ 孤儿域（登记册里没有的域）恒 reviewEnabled=false，但 reviewCount 仍如实算', () => {
    saveTerms([{ term: 'e1', definition: '1', domain: 'rv-orphan', importance: 0.5 }]);
    getDb().prepare(`DELETE FROM term_domain WHERE name = 'rv-orphan'`).run(); // 造孤儿态
    scopeTerm('e1', true);
    // 孤儿域没有开关可谈（登记册里没这一行）⇒ 恒 false；但词条自己的覆盖位仍算数，
    // 否则它的词条会在 Tab 上"隐身"（与 v19 那条兜底的取向一致：宁可多一格也不丢数据）。
    expect(find('rv-orphan')).toMatchObject({ count: 1, reviewEnabled: false, reviewCount: 1 });
  });
});
