import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { saveTerms, listTerms, type TermRow } from './terms.js';
import { parseTidyBlock, normalizeTidyPlan, applyTidy, mergeTerms, renameDomain, tidyTerms } from './tidy.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tidy-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 按 term 取行（测试辅助） */
function rowOf(term: string): TermRow {
  const r = getDb().prepare('SELECT * FROM term_library WHERE term = ?').get(term) as TermRow | undefined;
  if (!r) throw new Error(`测试词条不存在：${term}`);
  return r;
}

/** 直接改 usage_count / created_at（构造合并前状态） */
function setRow(term: string, patch: { usage?: number; created?: string; importance?: number }): void {
  const r = rowOf(term);
  getDb()
    .prepare('UPDATE term_library SET usage_count = ?, created_at = ?, importance = ? WHERE id = ?')
    .run(patch.usage ?? r.usage_count, patch.created ?? r.created_at, patch.importance ?? r.importance, r.id);
}

describe('learning/tidy — [TIDY] 协议解析（AI 输出容错）', () => {
  it('标准 [TIDY]...[/TIDY] 包裹解析成功', () => {
    const plan = parseTidyBlock(
      `[TIDY]{"clusters":[{"keep":"id1","term":"机器学习","domain":"cs","merge":["id2","id3"],"reason":"中英互译"}],"domainRenames":{"计算机":"cs"}}[/TIDY]`,
    );
    expect(plan?.clusters).toHaveLength(1);
    expect(plan?.clusters[0]?.term).toBe('机器学习');
    expect(plan?.clusters[0]?.merge).toEqual(['id2', 'id3']);
    expect(plan?.domainRenames['计算机']).toBe('cs');
  });

  it('围栏/杂质容错（```json 与前后文本、无标记但含 clusters）', () => {
    const a = parseTidyBlock('前置\n```json\n{"clusters":[],"domainRenames":{}}\n```\n后置');
    expect(a?.clusters).toHaveLength(0);
    const b = parseTidyBlock('{"clusters":[],"domainRenames":{}}');
    expect(b?.clusters).toHaveLength(0);
  });

  it('畸形输入 → null（走降级，ADR-4）', () => {
    expect(parseTidyBlock('[TIDY]not-json[/TIDY]')).toBeNull();
    expect(parseTidyBlock('完全无关文本')).toBeNull();
  });

  it('字段类型不符的簇被丢弃，不拖垮整包', () => {
    const plan = parseTidyBlock(
      `[TIDY]{"clusters":[{"keep":"id1","merge":["id2"]},{"keep":"id3","term":"x","merge":"not-array"},{"keep":"id4","term":"y","domain":"cs","merge":["id5"],"reason":"ok"}]}[/TIDY]`,
    );
    expect(plan?.clusters).toHaveLength(1);
    expect(plan?.clusters[0]?.term).toBe('y');
  });
});

describe('learning/tidy — normalizeTidyPlan 校验（LLM 输出不可信，落库前防线）', () => {
  const rows = [
    { id: 'a', term: '机器学习', domain: 'cs' },
    { id: 'b', term: 'machine learning', domain: 'english' },
    { id: 'c', term: '指针', domain: '计算机' },
  ] as TermRow[];

  it('丢无效簇：id 不存在 / 簇不足 2 条 / canonical 杜撰', () => {
    const plan = normalizeTidyPlan(
      {
        clusters: [
          { keep: 'ghost', term: 'x', domain: 'cs', merge: ['a'], reason: '' }, // id 不存在
          { keep: 'a', term: '机器学习', domain: 'cs', merge: ['a'], reason: '' }, // 去重后单条
          { keep: 'a', term: '杜撰词', domain: 'cs', merge: ['b'], reason: '' }, // canonical 不在簇内
          { keep: 'a', term: '机器学习', domain: 'cs', merge: ['b'], reason: '' }, // 有效
        ],
        domainRenames: {},
      },
      rows,
    );
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]?.keep).toBe('a');
  });

  it('同一 id 被两簇引用：先到先得，后簇丢弃', () => {
    const plan = normalizeTidyPlan(
      {
        clusters: [
          { keep: 'a', term: '机器学习', domain: 'cs', merge: ['b'], reason: '' },
          { keep: 'b', term: 'machine learning', domain: 'english', merge: ['a'], reason: '' },
        ],
        domainRenames: {},
      },
      rows,
    );
    expect(plan.clusters).toHaveLength(1);
  });

  it('领域改名只保留真实存在的旧领域，且归一（小写/截断/同名丢弃）', () => {
    const plan = normalizeTidyPlan(
      {
        clusters: [],
        domainRenames: { 计算机: 'cs', 幽灵领域: 'x', 计算机2: 'Y'.repeat(50) },
      },
      rows,
    );
    expect(Object.keys(plan.domainRenames)).toEqual(['计算机']);
    expect(plan.domainRenames['计算机']).toBe('cs');
  });
});

describe('learning/tidy — applyTidy 合并语义（契约 §6 逐字段）', () => {
  beforeEach(() => {
    saveTerms([
      { term: '机器学习', definition: '机器学习的定义', domain: 'cs', importance: 0.8 },
      { term: 'machine learning', definition: '更完整的 ML 定义', domain: 'english', importance: 0.95 },
      { term: 'ML', definition: '缩写', domain: 'cs', importance: 0.3 },
      { term: '指针', definition: '内存地址', domain: '计算机', importance: 0.85 },
    ]);
    setRow('机器学习', { usage: 2, created: '2026-01-01 00:00:00' });
    setRow('machine learning', { usage: 1, created: '2026-02-01 00:00:00' });
    setRow('ML', { usage: 0, created: '2026-03-01 00:00:00' });
  });

  it('簇合并：usage 求和 / importance max / 释义取最高 / aliases 并集 / created 最早 / 成员删除', () => {
    const summary = applyTidy({
      clusters: [
        {
          keep: rowOf('机器学习').id,
          term: '机器学习',
          domain: 'cs',
          merge: [rowOf('machine learning').id, rowOf('ML').id],
          reason: '中英互译与缩写',
        },
      ],
      domainRenames: {},
    });
    expect(summary.result).toBe('ok');
    expect(summary.before).toBe(4);
    expect(summary.after).toBe(2); // 3 并 1 + 指针
    const merged = rowOf('机器学习');
    expect(merged.usage_count).toBe(3);
    expect(merged.importance).toBe(0.95);
    expect(merged.definition).toBe('更完整的 ML 定义'); // importance 0.95 者的释义
    expect(merged.domain).toBe('cs');
    expect(merged.created_at).toBe('2026-01-01 00:00:00');
    expect(JSON.parse(merged.aliases)).toEqual(['machine learning', 'ML']);
    expect(summary.mergedClusters?.[0]?.canonical).toBe('机器学习');
  });

  it('领域归一：改名生效 + 新旧两域同词条自动并入（usage 求和，保高者为 keep）', () => {
    // 指针@计算机（usage 0）与 指针@cs（usage 1）撞域 → 自动并入为一条
    saveTerms([{ term: '指针2', definition: '占位', domain: 'cs', importance: 0.1 }]);
    getDb().prepare(`UPDATE term_library SET term = '指针', usage_count = 1 WHERE term = '指针2'`).run();
    const summary = applyTidy({ clusters: [], domainRenames: { 计算机: 'cs' } });
    expect(summary.result).toBe('ok');
    const p = rowOf('指针');
    expect(p.domain).toBe('cs');
    expect(p.usage_count).toBe(1); // 0 + 1
    expect(listTerms()).toHaveLength(4);
  });

  it('簇外 UNIQUE 冲突防御：同词同域行被一并并入，事务不炸', () => {
    // 簇 = {machine learning@english + 机器学习@math}，canonical 取簇内的「机器学习」、
    // 归一到 cs——与簇外的 机器学习@cs 撞 (term, domain)，防御逻辑把簇外行一并并入，
    // 而不是让 UPDATE 撞唯一约束炸掉事务
    saveTerms([{ term: '机器学习', definition: 'math 域的同词条', domain: 'math', importance: 0.2 }]);
    const mathId = getDb().prepare(`SELECT id FROM term_library WHERE term = '机器学习' AND domain = 'math'`).get() as { id: string };
    const summary = applyTidy({
      clusters: [
        {
          keep: rowOf('machine learning').id,
          term: '机器学习',
          domain: 'cs',
          merge: [mathId.id],
          reason: '并入',
        },
      ],
      domainRenames: {},
    });
    expect(summary.result).toBe('ok');
    const merged = rowOf('机器学习');
    expect(merged.domain).toBe('cs');
    expect(merged.usage_count).toBe(3); // machine learning 1 + math 域 0 + 簇外 cs 域 2
    expect(JSON.parse(merged.aliases)).toEqual(['machine learning']);
    expect(listTerms().filter((r) => r.term === '机器学习')).toHaveLength(1);
    expect(listTerms()).toHaveLength(3); // 机器学习@cs + ML@cs + 指针@计算机
  });

  it('空方案 → noop 零变更', () => {
    const summary = applyTidy({ clusters: [], domainRenames: {} });
    expect(summary.result).toBe('noop');
    expect(summary.before).toBe(4);
    expect(summary.after).toBe(4);
  });
});

describe('learning/tidy — mergeTerms / renameDomain（点名确定性操作）', () => {
  beforeEach(() => {
    saveTerms([
      { term: 'closure', definition: '闭包', domain: 'cs', importance: 0.9 },
      { term: 'Closure', definition: '闭包（大小写变体）', domain: 'math', importance: 0.4 },
      { term: '闭包', definition: '函数与其词法环境', domain: 'cs', importance: 0.85 },
    ]);
  });

  it('点名合并：首词为主词条，其余并入并挂别名', () => {
    const summary = mergeTerms(['闭包', 'closure', 'Closure']);
    expect(summary.result).toBe('ok');
    expect(summary.before).toBe(3);
    expect(summary.after).toBe(1);
    const merged = rowOf('闭包');
    expect(merged.domain).toBe('cs');
    expect(merged.definition).toBe('闭包'); // 释义取簇内 importance 最高者（closure 0.9）
    expect(JSON.parse(merged.aliases)).toEqual(['closure']); // Closure 与 closure 小写去重
  });

  it('点名合并：找不到的词条如实报告', () => {
    const summary = mergeTerms(['闭包', '不存在词']);
    expect(summary.result).toBe('error');
    expect(summary.message).toContain('不存在词');
    expect(listTerms()).toHaveLength(3);
  });

  it('点名合并：同名同域重复点名 → noop', () => {
    const summary = mergeTerms(['闭包', '闭包']);
    expect(summary.result).toBe('noop');
  });

  it('renameDomain：改名 + 同名词条撞域自动并入', () => {
    saveTerms([{ term: '积分', definition: 'integral', domain: 'math', importance: 0.5 }]);
    getDb().prepare(`INSERT INTO term_library (id, term, definition, domain, importance, usage_count)
      VALUES ('t1', '积分', '另一条积分', '数学', 0.5, 3)`).run();
    const summary = renameDomain('数学', 'math');
    expect(summary.result).toBe('ok');
    const rows = listTerms().filter((r) => r.term === '积分');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.domain).toBe('math');
    expect(rows[0]?.usage_count).toBe(3); // 保 usage 高者
  });

  it('renameDomain：领域不存在 → error', () => {
    const summary = renameDomain('幽灵领域', 'cs');
    expect(summary.result).toBe('error');
    expect(summary.message).toContain('幽灵领域');
  });
});

describe('learning/tidy — tidyTerms 全量入口（方案失败降级）', () => {
  it('词条不足两条 → 空方案 noop（不打 LLM）', async () => {
    saveTerms([{ term: '唯一词条', definition: 'x', domain: 'general', importance: 0.5 }]);
    const summary = await tidyTerms();
    expect(summary.result).toBe('noop');
  });
});
