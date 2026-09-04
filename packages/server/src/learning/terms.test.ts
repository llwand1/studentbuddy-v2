import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb } from '../storage/db.js';
import { getDb } from '../storage/db.js';
import { parseTermsBlock, normalizeTerms, saveTerms, saveOneTerm, listTerms, domainStats, removeTerm, updateTerm, getRelevantTerms, countUsage, extractTerms } from './terms.js';

// extractTerms 的 LLM 调用走 mock（捕获出站提示词；本文件其余用例不触 LLM）
let lastPrompt = '';
vi.mock('../llm/router.js', () => ({
  routeRole: () => ({
    adapter: {
      chat: (opts: { messages: Array<{ role: string; content: string }> }) => ({
        async *[Symbol.asyncIterator]() {
          lastPrompt = opts.messages[0]?.content ?? '';
          yield { content: '[TERMS]{"terms":[]}', done: true };
        },
      }),
    },
    model: 'test-model',
    apiKey: 'k',
    baseUrl: 'b',
  }),
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-terms-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('learning/terms — [TERMS] 协议解析（AI 输出容错）', () => {
  it('标准 [TERMS]...[/TERMS] 包裹解析成功', () => {
    const out = parseTermsBlock(`好的：\n[TERMS]{"terms":[{"term":"closure","definition":"闭包","domain":"cs","importance":0.9}]}[/TERMS]`);
    expect(out).toHaveLength(1);
    expect(out[0]?.term).toBe('closure');
    expect(out[0]?.domain).toBe('cs');
    expect(out[0]?.importance).toBe(0.9);
  });

  it('围栏/杂质容错（```json 与前后文本）', () => {
    const out = parseTermsBlock('前置\n```json\n{"terms":[{"term":"二重积分","definition":"对二元函数的积分","domain":"math"}]}\n```\n后置');
    expect(out[0]?.term).toBe('二重积分');
  });

  it('非法 JSON → []（走降级，不崩 ADR-4）', () => {
    expect(parseTermsBlock('[TERMS]not-json[/TERMS]')).toHaveLength(0);
    expect(parseTermsBlock('完全无关文本')).toHaveLength(0);
  });

  it('normalize 丢弃无 term/definition 条目，importance 钳到 0-1', () => {
    const out = normalizeTerms([
      { term: 'ok', definition: '好' },
      { term: '', definition: '无词条' },
      { term: '无释义', definition: '' },
      { term: '大', definition: 'importance 越界', importance: 5 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.importance).toBe(1);
  });
});

describe('learning/terms — 入库与合并', () => {
  it('saveTerms 入库并可 list；重复 term+domain 合并取更高 importance', () => {
    const n1 = saveTerms([{ term: 'closure', definition: '闭包', domain: 'cs', importance: 0.5 }]);
    expect(n1).toBe(1);
    // 同词条同领域：importance 更高 → 更新释义并保留高重要度
    const n2 = saveTerms([{ term: 'closure', definition: '闭包（更完整定义）', domain: 'cs', importance: 0.9 }]);
    expect(n2).toBe(1);
    const rows = listTerms();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toBe('闭包（更完整定义）');
    expect(rows[0]?.importance).toBe(0.9);
  });

  it('同词条不同领域独立成条', () => {
    saveTerms([
      { term: 'matrix', definition: '矩阵', domain: 'math' },
      { term: 'matrix', definition: '母体', domain: 'general' },
    ]);
    expect(listTerms()).toHaveLength(2);
  });

  it('saveOneTerm 手动存 + 重复更新释义', () => {
    const r1 = saveOneTerm('vector', '向量', 'math');
    const r2 = saveOneTerm('vector', '矢量（更新）', 'math');
    expect(r1.id).toBe(r2.id);
    expect(listTerms()).toHaveLength(1);
    expect(listTerms()[0]?.definition).toBe('矢量（更新）');
  });

  it('updateTerm 编辑释义/领域/重要度，removeTerm 删除', () => {
    const r = saveOneTerm('foo', '定义', 'general');
    const u = updateTerm(r.id, { definition: '新定义', domain: 'cs', importance: 0.8 });
    expect(u?.definition).toBe('新定义');
    expect(u?.domain).toBe('cs');
    expect(u?.importance).toBe(0.8);
    removeTerm(r.id);
    expect(listTerms()).toHaveLength(0);
  });

  it('domainStats 统计总数/领域分布/今日新增', () => {
    saveTerms([
      { term: 'a', definition: 'a', domain: 'english', importance: 0.5 },
      { term: 'b', definition: 'b', domain: 'english', importance: 0.5 },
      { term: 'c', definition: 'c', domain: 'math', importance: 0.5 },
    ]);
    const s = domainStats();
    expect(s.total).toBe(3);
    expect(s.domains.find((d) => d.domain === 'english')?.count).toBe(2);
    expect(s.today).toBe(3);
  });
});

describe('learning/terms — 防再分裂（TERM-TIDY-SPEC §7）', () => {
  /** 给指定词条挂别名（模拟整理后的状态） */
  const setAliases = (term: string, aliases: string[]) => {
    getDb().prepare('UPDATE term_library SET aliases = ? WHERE term = ?').run(JSON.stringify(aliases), term);
  };

  it('saveTerms 命中已有词条的别名 → 并入不新建（跨域也并入）', () => {
    saveTerms([{ term: '机器学习', definition: '定义', domain: 'cs', importance: 0.8 }]);
    setAliases('机器学习', ['machine learning', 'ML']);
    // 再抽到 machine learning（哪怕 LLM 给了别的领域）→ 并入已有行
    const n = saveTerms([{ term: 'machine learning', definition: '新释义', domain: 'english', importance: 0.6 }]);
    expect(n).toBe(1);
    expect(listTerms()).toHaveLength(1);
    expect(listTerms()[0]?.term).toBe('机器学习');
    expect(listTerms()[0]?.definition).toBe('定义'); // 0.6 < 0.8，不覆盖释义
    expect(listTerms()[0]?.importance).toBe(0.8);
  });

  it('saveTerms 同词同域大小写不敏感 → 并入（Closure/closure 不再各成一条）', () => {
    saveTerms([{ term: 'closure', definition: '闭包', domain: 'cs', importance: 0.5 }]);
    saveTerms([{ term: 'Closure', definition: '闭包（大写变体）', domain: 'cs', importance: 0.9 }]);
    expect(listTerms()).toHaveLength(1);
    expect(listTerms()[0]?.definition).toBe('闭包（大写变体）');
  });

  it('saveTerms 同词不同域不并入（closure 的 math 与 english 是两个概念）', () => {
    saveTerms([
      { term: 'matrix', definition: '矩阵', domain: 'math', importance: 0.5 },
      { term: 'matrix', definition: '母体', domain: 'general', importance: 0.5 },
    ]);
    expect(listTerms()).toHaveLength(2);
  });

  it('countUsage 命中别名与大小写变体；英文按词边界不误报', () => {
    saveTerms([{ term: '机器学习', definition: 'x', domain: 'cs', importance: 0.5 }]);
    setAliases('机器学习', ['machine learning', 'ML']);
    const n = countUsage('Machine Learning 与 ML 都是机器学习的说法');
    expect(n).toBe(1);
    expect(listTerms()[0]?.usage_count).toBe(1);
    // html 内含 "ml" 子串，但不是独立词 → 不计数
    expect(countUsage('html 是超文本标记语言')).toBe(0);
  });

  it('extractTerms 提示词注入已有领域（防领域碎裂）', async () => {
    saveTerms([
      { term: 'a', definition: 'a', domain: 'english', importance: 0.5 },
      { term: 'b', definition: 'b', domain: 'cs', importance: 0.5 },
    ]);
    await extractTerms('一段学习材料');
    expect(lastPrompt).toContain('已有领域（优先复用');
    expect(lastPrompt).toContain('english');
    expect(lastPrompt).toContain('cs');
  });
});

describe('learning/terms — 检索与使用计数', () => {
  beforeEach(() => {
    saveTerms([
      { term: 'closure', definition: '闭包', domain: 'cs', importance: 0.9 },
      { term: '二重积分', definition: '对二元函数的积分', domain: 'math', importance: 0.8 },
      { term: 'photosynthesis', definition: '光合作用', domain: 'english', importance: 0.7 },
      { term: '无关词', definition: '无关', domain: 'general', importance: 0.3 },
    ]);
  });

  it('getRelevantTerms 命中提问中的词条（子串）', () => {
    const hit = getRelevantTerms('什么是 closure 闭包？', 10);
    expect(hit.map((r) => r.term)).toContain('closure');
  });

  it('getRelevantTerms 中文词条子串命中', () => {
    const hit = getRelevantTerms('帮我讲讲二重积分怎么算', 10);
    expect(hit.map((r) => r.term)).toContain('二重积分');
  });

  it('getRelevantTerms 无关提问返回空', () => {
    expect(getRelevantTerms('今天天气怎么样', 10)).toHaveLength(0);
  });

  it('countUsage 统计回复命中词条并累加 usage_count', () => {
    const n = countUsage('closure 用于保留变量，光合作用 photosynthesis 是……');
    expect(n).toBe(2);
    const rows = listTerms();
    const closure = rows.find((r) => r.term === 'closure');
    const photo = rows.find((r) => r.term === 'photosynthesis');
    expect(closure?.usage_count).toBe(1);
    expect(photo?.usage_count).toBe(1);
    expect(closure?.last_used_at).toBeTruthy();
  });

  it('listTerms 支持 domain 过滤与 keyword 前缀', () => {
    expect(listTerms('english')).toHaveLength(1);
    expect(listTerms(undefined, 'ph')).toHaveLength(1);
  });
});

// 防回归：term_library 表已建（迁移 v5）
describe('learning/terms — 表结构', () => {
  it('term_library 表存在且唯一约束 (term, domain) 生效', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name === 'term_library')).toBe(true);
    saveTerms([{ term: 'dup', definition: '1', domain: 'x' }]);
    // 直接 SQL 插同键应抛错（约束由 upsert 保护，这里验证唯一性存在）
    expect(() =>
      db.prepare(`INSERT INTO term_library (id, term, definition, domain) VALUES ('i2', 'dup', '2', 'x')`).run(),
    ).toThrow();
  });
});
