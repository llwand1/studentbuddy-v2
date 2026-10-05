/**
 * 白名单第一版的**数据锁**（不是算法锁）。
 *
 * 为什么值得为一张表写测试：这张表是外部依赖——站点改版、加反爬、换检索端点都会让它悄悄失效，
 * 而失效的形态是「范围内没结果」，用户看到的是「功能坏了」，不是「表过期了」。
 * 这些用例保证：**结构上不可能出现**跑不通的行（假域、坏模板、孤儿包、带 www 的登记域）。
 * 内容是否还活着（HTTP 200）不在这里判——那是 `docs/EXAM-MODE-SPEC.md` §6 的探针活。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXAM_PACK_IDS,
  EXAM_PACKS,
  EXAM_SOURCES,
  examPackGroup,
  examScopeSummary,
  normalizeExamScope,
  packHosts,
  packsByGroup,
  resolveExamHosts,
  resolveExamSources,
} from './exam-sources.js';
import { MAX_EXAM_CUSTOM_HOSTS, examUrlAllowed, normalizeExamHost } from './exam-scope.js';

describe('预置包与登记表的结构完整性', () => {
  it('包 id 唯一，且有题源可选（空包在设置页上就是死勾选项）', () => {
    const ids = EXAM_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of EXAM_PACKS) {
      expect(EXAM_SOURCES.some((s) => s.packs.includes(p.id)), `包「${p.id}」没有任何题源`).toBe(true);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('每行的 host 已是归一化形态（不许带 www / 协议 / 大小写）', () => {
    for (const s of EXAM_SOURCES) {
      expect(normalizeExamHost(s.host), `${s.host} 需要重新归一化`).toBe(s.host);
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(['question', 'reference']).toContain(s.tier);
      expect(s.packs.length).toBeGreaterThan(0);
    }
    const hosts = EXAM_SOURCES.map((s) => s.host);
    expect(new Set(hosts).size).toBe(hosts.length); // 同域重复登记会造成「两条 note 打架」
  });

  it('每行都带实测读数（凭印象写的站不许进表）', () => {
    for (const s of EXAM_SOURCES) {
      expect((s.note ?? '').length, `${s.host} 缺实测读数`).toBeGreaterThan(10);
    }
  });

  it('引用的包 id 必须存在（写错一个字母就是静默不入任何范围）', () => {
    const ids = new Set(EXAM_PACKS.map((p) => p.id));
    for (const s of EXAM_SOURCES) {
      for (const p of s.packs) expect(ids.has(p), `${s.host} 引用了不存在的包 ${p}`).toBe(true);
    }
  });
});

describe('站内直达端点', () => {
  it('模板必须是合法 http(s) URL 且 {q} 恰好出现一次', () => {
    const withDirect = EXAM_SOURCES.filter((s) => s.direct);
    expect(withDirect.length).toBeGreaterThan(0);
    for (const s of withDirect) {
      const tpl = s.direct!.search;
      expect(tpl.match(/\{q\}/g)?.length, `${s.host} 的 {q} 数量不对`).toBe(1);
      expect(tpl.startsWith('https://'), `${s.host} 必须走 https`).toBe(true);
      const probe = new URL(tpl.replace('{q}', encodeURIComponent('高考数学')));
      expect(['http:', 'https:']).toContain(probe.protocol);
      expect(probe.search.length, `${s.host} 替换查询词后没有 query`).toBeGreaterThan(0);
      expect(s.direct!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('★ 端点落点必须仍在自己登记的域内（否则一次直达就跑出范围了）', () => {
    for (const s of EXAM_SOURCES) {
      if (!s.direct) continue;
      const url = s.direct.search.replace('{q}', 'x');
      expect(examUrlAllowed(url, [s.host]), `${s.direct.search} 落在 ${s.host} 之外`).toBe(true);
    }
  });

  it('question 档至少要有几站能直达（否则「题源站内直达」这层是空的）', () => {
    const directQuestion = EXAM_SOURCES.filter((s) => s.tier === 'question' && s.direct);
    expect(directQuestion.length).toBeGreaterThanOrEqual(5);
  });
});

describe('两大类分组（求职面试 / 传统考试）', () => {
  it('每个包都属于一个合法大类，且**两类各自成规模**（只有一类就是没做另一半）', () => {
    for (const p of EXAM_PACKS) expect(['exam', 'job']).toContain(p.group);
    const groups = packsByGroup();
    expect(groups.map((g) => g.group)).toEqual(['exam', 'job']);
    for (const g of groups) {
      expect(g.packs.length, `${g.label} 一组只有 ${g.packs.length} 个包`).toBeGreaterThanOrEqual(5);
      expect(g.label.length).toBeGreaterThan(0);
    }
    // 分区不许漏包：两组加起来必须等于全表
    expect(groups.reduce((n, g) => n + g.packs.length, 0)).toBe(EXAM_PACKS.length);
  });

  it('★ 求职面试组要有**真能抽题**的站（只收资讯站等于没做这一类）', () => {
    const jobPackIds = new Set(EXAM_PACKS.filter((p) => p.group === 'job').flatMap((p) => [p.id]));
    const jobSources = EXAM_SOURCES.filter((s) => s.packs.some((p) => jobPackIds.has(p)));
    expect(jobSources.length).toBeGreaterThanOrEqual(8);
    const question = jobSources.filter((s) => s.tier === 'question');
    expect(question.length).toBeGreaterThanOrEqual(5);
    for (const s of question) expect((s.note ?? '').length).toBeGreaterThan(10);
  });

  it('examPackGroup：认得的包回大类，认不回的回 null（不猜）', () => {
    expect(examPackGroup('gaokao')).toBe('exam');
    expect(examPackGroup('tech-interview')).toBe('job');
    expect(examPackGroup('不存在的包')).toBeNull();
  });

  it('旧 `it` 包已被两组取代（留着会让老设置勾到一个不存在的包上静默失效）', () => {
    expect(EXAM_PACKS.some((p) => p.id === 'it')).toBe(false);
    for (const s of EXAM_SOURCES) expect(s.packs).not.toContain('it');
  });
});

describe('固定入口页（求职面试组的取题方式）', () => {
  const withEntries = EXAM_SOURCES.filter((s) => (s.entries?.length ?? 0) > 0);

  it('★ 入口页总量要够：求职面试组在通用搜索上几乎不产出（实测 80 条命中里 4 条在范围内），全靠这一层', () => {
    expect(withEntries.length).toBeGreaterThanOrEqual(5);
    const total = withEntries.reduce((n, s) => n + (s.entries?.length ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(10);
    const jobEntries = withEntries
      .filter((s) => s.packs.some((p) => examPackGroup(p) === 'job'))
      .reduce((n, s) => n + (s.entries?.length ?? 0), 0);
    expect(jobEntries).toBeGreaterThanOrEqual(8);
  });

  it('每条入口页：https、带 label、带实测日期，且**落在自己登记的域内**', () => {
    for (const s of withEntries) {
      for (const e of s.entries ?? []) {
        expect(e.url.startsWith('https://'), `${s.host} 的入口页必须 https：${e.url}`).toBe(true);
        expect(e.label.trim().length).toBeGreaterThan(0);
        expect(e.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(examUrlAllowed(e.url, [s.host]), `${e.url} 落在 ${s.host} 之外`).toBe(true);
      }
    }
  });

  it('同一 URL 不在两个站之间重复登记（重复会让候选去重结果依赖表序）', () => {
    const urls = withEntries.flatMap((s) => (s.entries ?? []).map((e) => e.url));
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('范围解析', () => {
  it('缺省＝全部预置包（开着模式却一个范围都没选会直接没资料，那不是用户要的）', () => {
    const scope = normalizeExamScope(undefined);
    expect(scope.packs).toEqual([...DEFAULT_EXAM_PACK_IDS]);
    expect(scope.custom).toEqual([]);
    expect(resolveExamHosts(scope).length).toBe(EXAM_SOURCES.length);
  });

  it('未知包 id 丢掉、坏域名丢掉、自填封顶', () => {
    const scope = normalizeExamScope({
      packs: ['gaokao', '不存在的包', 'gaokao', 42],
      custom: ['https://WWW.JYEOO.com/x', 'jyeoo.com', '坏 域', '', ...Array.from({ length: 40 }, (_, i) => `s${i}.example.com`)],
    });
    expect(scope.packs).toEqual(['gaokao']);
    expect(scope.custom[0]).toBe('jyeoo.com');
    expect(new Set(scope.custom).size).toBe(scope.custom.length);
    expect(scope.custom.length).toBeLessThanOrEqual(MAX_EXAM_CUSTOM_HOSTS);
  });

  it('坏 JSON 回默认，不回「空范围」（空范围＝外部检索整条关掉）', () => {
    expect(normalizeExamScope('不是对象').packs.length).toBeGreaterThan(0);
    expect(normalizeExamScope(null).packs.length).toBeGreaterThan(0);
  });

  it('单勾一个包 ⇒ 只剩那个包里的站', () => {
    const hosts = packHosts(['video']);
    expect(hosts).toEqual(['bilibili.com']);
    expect(resolveExamHosts({ packs: ['video'], custom: [] })).toEqual(['bilibili.com']);
  });

  it('自填域与会进来的域合并去重、排序稳定', () => {
    const hosts = resolveExamHosts({ packs: ['gaokao'], custom: ['jyeoo.com', 'WWW.XKW.COM'] });
    expect(hosts).toContain('jyeoo.com');
    expect(hosts).toContain('xkw.com');
    expect(hosts).toEqual([...hosts].sort());
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('resolveExamSources 只回范围内的登记表条目（自填域不在表上）', () => {
    const picked = resolveExamSources({ packs: ['video'], custom: ['my-school.example'] });
    expect(picked.map((s) => s.host)).toEqual(['bilibili.com']);
  });

  it('范围话术：包数、超四个收成「等 N 类」、自填另计', () => {
    expect(examScopeSummary({ packs: ['gaokao', 'zhongkao'], custom: [] })).toBe('高考、中考');
    expect(examScopeSummary({ packs: [...DEFAULT_EXAM_PACK_IDS], custom: [] })).toContain('等');
    expect(examScopeSummary({ packs: ['gaokao'], custom: ['a.com', 'b.com'] })).toBe('高考＋2 个自填站');
    expect(examScopeSummary({ packs: [], custom: [] })).toBe('未选类目');
  });
});
