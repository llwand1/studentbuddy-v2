/**
 * term_source（v55）回归锁：来源登记、幂等、范围集合。
 * 全程隔离库（`SB_DATA_DIR` 指到临时目录），零网络、零模型。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-termsrc-test-'));

const { getDb } = await import('../storage/db.js');
const { removeTerm, saveOneTerm, saveTerms } = await import('./terms.js');
const {
  MAX_TERM_SOURCE_URLS,
  deleteTermSources,
  recordTermSources,
  termIdsInScope,
  termIdsWithSource,
  termSourceHosts,
} = await import('./term-source.js');

const OWNER = 'u-src';

const idOf = (term: string): string => {
  const row = getDb().prepare('SELECT id FROM term_library WHERE term = ? AND owner_id = ?').get(term, OWNER) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`词条没落库：${term}`);
  return row.id;
};

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM term_source').run();
  db.prepare('DELETE FROM term_library').run();
  db.prepare('DELETE FROM term_domain').run();
});

describe('v55 表结构', () => {
  it('迁移链跑完就有这张表，且列齐（重放链由 db.test.ts 兜）', () => {
    const cols = (getDb().prepare(`SELECT name FROM pragma_table_info('term_source')`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols.sort()).toEqual(
      ['created_at', 'host', 'id', 'origin', 'owner_id', 'term_id', 'url'].sort(),
    );
  });
});

describe('recordTermSources', () => {
  it('host 在写入时就归一化（读侧只做字符串比较）', () => {
    const id = saveOneTerm('熵', '混乱度的度量', '物理', OWNER, {
      urls: ['https://WWW.EOL.CN/shiti/sx/?id=3'],
      origin: 'tool',
    }).id!;
    expect(termSourceHosts(id, OWNER)).toEqual(['eol.cn']);
  });

  it('★ 同一 (词条, 网址) 重复登记不新增行（资料架会反复 settle）', () => {
    const id = saveOneTerm('焓', '恒压下的热含量', '物理', OWNER, { urls: ['https://aipta.com/a/1'], origin: 'tool' }).id!;
    const before = termSourceHosts(id, OWNER).length;
    recordTermSources([id], OWNER, ['https://aipta.com/a/1'], 'tool');
    expect(termSourceHosts(id, OWNER).length).toBe(before);
  });

  it('每词最多记 3 条来源，坏 URL 直接丢', () => {
    const id = saveOneTerm(
      '吉布斯自由能',
      '可做功的能量',
      '化学',
      OWNER,
      {
        urls: ['https://a.com/1', 'https://b.com/2', 'https://c.com/3', 'https://d.com/4', '坏链', ''],
        origin: 'chat',
      },
    ).id!;
    expect(termSourceHosts(id, OWNER)).toHaveLength(MAX_TERM_SOURCE_URLS);
  });

  it('没来源就不写：手动存词（第四参数缺省）零行', () => {
    const row = saveOneTerm('手动词', '用户自己打的', 'general', OWNER);
    expect(termSourceHosts(row.id!, OWNER)).toEqual([]);
    expect(termIdsWithSource(OWNER).size).toBe(0);
  });

  it('saveTerms 批量路径同样记账（对话后抽词走这条）', () => {
    const n = saveTerms(
      [
        { term: '词甲', definition: '释义甲' },
        { term: '词乙', definition: '释义乙' },
      ],
      null,
      OWNER,
      { urls: ['https://jyeoo.com/math/x'], origin: 'chat' },
    );
    expect(n).toBe(2);
    expect(termIdsWithSource(OWNER).size).toBe(2);
  });
});

describe('termIdsInScope：范围内词条集合', () => {
  const seed = () => {
    const a = saveOneTerm('范围内词', '来自题源站', '数学', OWNER, { urls: ['https://www.jyeoo.com/math/1'], origin: 'chat' }).id!;
    const b = saveOneTerm('范围外词', '来自百科', '数学', OWNER, { urls: ['https://baike.baidu.com/x'], origin: 'chat' }).id!;
    const c = saveOneTerm('无来源词', '用户手输', '数学', OWNER).id!;
    return { a, b, c };
  };

  it('★ 只有来源命中的算在内：范围外与无来源都不出现（老板 2026-10-05 拍：范围内有什么就是什么）', () => {
    const { a, b, c } = seed();
    const ids = termIdsInScope(OWNER, ['jyeoo.com']);
    expect([...ids!].sort()).toEqual([a].sort());
    expect(ids!.has(b)).toBe(false);
    expect(ids!.has(c)).toBe(false);
  });

  it('子域来源命中登记域（存的是 `gaokao.eol.cn`，白名单写 `eol.cn`）', () => {
    const id = saveOneTerm('子域词', 'x', '地理', OWNER, { urls: ['https://gaokao.eol.cn/shiti/'], origin: 'chat' }).id!;
    expect(termIdsInScope(OWNER, ['eol.cn'])!.has(id)).toBe(true);
    expect(termIdsInScope(OWNER, ['xeol.cn'])!.has(id)).toBe(false);
  });

  it('多来源取并集：任一命中即在范围内（宁可少滤，不可错杀学过的词）', () => {
    const id = saveOneTerm('两页词', 'x', '政治', OWNER, { urls: ['https://baike.baidu.com/a'], origin: 'chat' }).id!;
    recordTermSources([id], OWNER, ['https://www.aipta.com/article/9.html'], 'tool');
    expect(termIdsInScope(OWNER, ['aipta.com'])!.has(id)).toBe(true);
  });

  it('★ 空 hosts 返回 null（＝不要过滤），而不是返回空集把整库抹掉', () => {
    seed();
    expect(termIdsInScope(OWNER, [])).toBeNull();
  });

  it('归属隔离：A 的来源不给 B 用', () => {
    const id = saveOneTerm('甲的词', 'x', '数学', OWNER, { urls: ['https://jyeoo.com/1'], origin: 'chat' }).id!;
    expect(termIdsInScope('other-user', ['jyeoo.com'])!.size).toBe(0);
    expect(termIdsInScope(OWNER, ['jyeoo.com'])!.has(id)).toBe(true);
  });
});

describe('删除联动', () => {
  it('deleteTermSources 清掉该词来源', () => {
    const id = saveOneTerm('待清词', 'x', '数学', OWNER, { urls: ['https://jyeoo.com/1'], origin: 'chat' }).id!;
    deleteTermSources(id, OWNER);
    expect(termSourceHosts(id, OWNER)).toEqual([]);
  });

  it('删词条本身也不留孤儿来源行（范围判定偏松不算崩，但别留脏数据）', () => {
    const id = saveOneTerm('会删掉的词', 'x', '数学', OWNER, { urls: ['https://jyeoo.com/1'], origin: 'chat' }).id!;
    removeTerm(id, OWNER);
    const left = getDb().prepare('SELECT COUNT(*) c FROM term_source WHERE term_id = ?').get(id) as { c: number };
    expect(left.c).toBe(0);
  });
});
