/**
 * exam-scope 回归锁：域名归一化、后缀式命中、过滤切分、范围签名。
 * ★ 这一组是全特性的**安全底线**——「应试模式下只从白名单站取资料」这句话是不是真，
 *   完全取决于这里的判据。假域（`xjyeoo.com`）能匹配上就是漏闸，而它不会报错、只会静默放行。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXAM_MODE,
  MAX_EXAM_CUSTOM_HOSTS,
  emptyExamScopeReport,
  examHostAllowed,
  examUrlAllowed,
  examScopeSignature,
  normalizeExamHost,
  normalizeExamMode,
  scopeHosts,
  splitByExamScope,
} from './exam-scope.js';

describe('域名归一化', () => {
  it('用户粘贴的多种形态归一到同一个裸域', () => {
    for (const input of [
      'jyeoo.com',
      'JYEOO.COM',
      '  www.jyeoo.com  ',
      'https://www.jyeoo.com/math/report/detail?id=1',
      'http://jyeoo.com./',
      'WWW.JYEOO.COM',
    ]) {
      expect(normalizeExamHost(input)).toBe('jyeoo.com');
    }
  });

  it('子域要保留（题源站的检索页常挂在 so./kuaisoo. 子域上）', () => {
    expect(normalizeExamHost('https://so.huatu.com/x?q=1')).toBe('so.huatu.com');
    expect(normalizeExamHost('m.jyeoo.com')).toBe('m.jyeoo.com');
  });

  it('非法输入一律 null：不猜、不抛、不半归一', () => {
    for (const input of [
      '',
      '   ',
      'jyeoo', // 单段名（无尾缀）
      'localhost',
      '127.0.0.1',
      '.jyeoo.com',
      'jyeoo..com',
      'a b.com',
      'javascript:alert(1)',
      `x${'y'.repeat(MAX_EXAM_CUSTOM_HOSTS * 10)}.com`,
      null,
      undefined,
      42,
      { host: 'jyeoo.com' },
    ]) {
      expect(normalizeExamHost(input as unknown)).toBeNull();
    }
  });
});

describe('白名单命中＝后缀式（登记域 itself 或它的子域）', () => {
  const hosts = ['eol.cn', 'jyeoo.com', 'bilibili.com'];

  it('放行本身与任意深度的子域', () => {
    for (const url of [
      'https://eol.cn/',
      'https://www.eol.cn/a',
      'https://gaokao.eol.cn/shiti/sx/',
      'https://www.jyeoo.com/math/ques/search?q=1',
      'https://search.bilibili.com/all?keyword=x',
    ]) {
      expect(examUrlAllowed(url, hosts), url).toBe(true);
    }
  });

  it('★ 假域不许顺带放进来（这条是整个闸门的底线）', () => {
    for (const url of [
      'https://xjyeoo.com/', // 前缀拼接
      'https://jyeoo.com.evil.cn/', // 尾缀拼接
      'https://evil.com/eol.cn', // 路径里带登记域
      'https://notbilibili.com/video',
      'https://eol.cn.evil.cn/',
    ]) {
      expect(examUrlAllowed(url, hosts), url).toBe(false);
    }
  });

  it('坏 URL / 空 url / 非法协议都算不允许（宁漏一条真结果也不放一个坏链）', () => {
    for (const url of ['', 'not a url', 'ftp://eol.cn/x', 'javascript:alert(1)', undefined, 7]) {
      expect(examUrlAllowed(url as unknown, hosts), String(url)).toBe(false);
    }
  });

  it('★ 空白名单＝全拦，不是「不设界」', () => {
    expect(examUrlAllowed('https://eol.cn/', [])).toBe(false);
    expect(splitByExamScope([{ url: 'https://eol.cn/' }], []).kept).toHaveLength(0);
    // 主机名形态（term_source 存的是 host，不是 url）
    expect(examHostAllowed('gaokao.eol.cn', hosts)).toBe(true);
    expect(examHostAllowed('xeol.cn', hosts)).toBe(false);
    expect(examHostAllowed('https://eol.cn/', hosts)).toBe(false); // 塞 URL 进去不算主机名
  });
});

describe('splitByExamScope 切分', () => {
  const items = [
    { url: 'https://www.jyeoo.com/a', title: 'A' },
    { url: 'https://baike.baidu.com/b', title: 'B' },
    { url: 'https://gaokao.eol.cn/c', title: 'C' },
    { url: '', title: 'D' },
  ];
  it('kept 与 dropped 都要有，条数不许凭空消失', () => {
    const { kept, dropped } = splitByExamScope(items, ['jyeoo.com', 'eol.cn']);
    expect(kept.map((k) => k.title)).toEqual(['A', 'C']);
    expect(dropped.map((d) => d.title)).toEqual(['B', 'D']);
    expect(kept.length + dropped.length).toBe(items.length);
  });
});

describe('范围签名（进 search_cache 键，防跨范围串味）', () => {
  it('同一集合换个顺序 ⇒ 同一签名', () => {
    expect(examScopeSignature(['b', 'a'] as unknown as string[])).not.toBe('');
    const x = examScopeSignature(['eol.cn', 'jyeoo.com']);
    const y = examScopeSignature(['www.jyeoo.com', 'eol.cn']); // 归一化后同一集合
    expect(x).toBe(y);
  });

  it('集合多一个域 ⇒ 签名必须变（否则缓存会把窄范围的结果当宽范围的端出来）', () => {
    const narrow = examScopeSignature(['jyeoo.com']);
    const wide = examScopeSignature(['jyeoo.com', 'eol.cn']);
    expect(narrow).not.toBe(wide);
    expect(examScopeSignature([])).toBe('all');
  });

  it('非法域名进不了签名', () => {
    expect(examScopeSignature(['jyeoo.com', '坏 域', ''])).toBe(examScopeSignature(['jyeoo.com']));
    expect(scopeHosts(['WWW.EOL.CN', 'eol.cn', 'x'])).toEqual(['eol.cn']);
  });
});

describe('开关归一化', () => {
  it('只认明确真值，其余回缺省（缺省关 ⇒ 不改变既有行为）', () => {
    expect(normalizeExamMode(true)).toBe(true);
    expect(normalizeExamMode('true')).toBe(true);
    expect(normalizeExamMode(1)).toBe(true);
    expect(normalizeExamMode(false)).toBe(false);
    expect(normalizeExamMode('0')).toBe(false);
    expect(normalizeExamMode(undefined)).toBe(DEFAULT_EXAM_MODE);
    expect(normalizeExamMode('随便')).toBe(DEFAULT_EXAM_MODE);
    expect(DEFAULT_EXAM_MODE).toBe(false);
  });

  it('零值报告：on=false 时各计数为 0、empty=false', () => {
    expect(emptyExamScopeReport()).toEqual({
      on: false,
      summary: '',
      kept: 0,
      dropped: 0,
      directSites: [],
      empty: false,
      hostsEmpty: false,
    });
  });
});
