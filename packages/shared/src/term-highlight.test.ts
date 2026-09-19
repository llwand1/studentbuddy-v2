/**
 * shared/term-highlight — 匹配规则回归（纯函数，无 IO）。
 *
 * 锁的是「正文里哪几个词该被标出来」这件事的全部边界。这些规则**同时**决定两件事：
 * 服务端的 `usage_count` 统计（`countUsage` 复用它）与屏幕上标出来的高亮——
 * 一条判错就是「统计说命中 3 个、屏幕只标出 2 个」这种当场露馅的不一致，
 * 故逐条钉死（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §9）。
 */
import { describe, it, expect } from 'vitest';
import {
  findTermHits,
  createTermMatcher,
  textHitsKey,
  termKeyPattern,
  termKeysOf,
  hasLatinKey,
  type TermKey,
} from './term-highlight.js';

const TERMS: TermKey[] = [
  { term: '闭包', aliases: ['closure'] },
  { term: '机器学习', aliases: ['machine learning'] },
  { term: 'let', aliases: [] },
  { term: 'ephemeral', aliases: null },
];

const hitsOf = (text: string, terms: readonly TermKey[] = TERMS) => findTermHits(text, terms);
const termsOf = (text: string, terms: readonly TermKey[] = TERMS) => hitsOf(text, terms).map((h) => h.term);

describe('规则 1：大小写不敏感 + 别名命中回传主词条名', () => {
  it('英文大小写两种形态都命中，且回传的是主词条名而非实际匹配文本', () => {
    const a = hitsOf('Closure 是一种捕获');
    expect(a).toHaveLength(1);
    expect(a[0]?.term).toBe('闭包');
    expect(a[0]?.key).toBe('Closure');

    const b = hitsOf('closure 与闭包是同一件事');
    expect(b.map((h) => h.term)).toEqual(['闭包', '闭包']);
    expect(b.map((h) => h.key)).toEqual(['closure', '闭包']);
  });

  it('多词别名（含空格）照样命中', () => {
    expect(termsOf('machine learning 是子领域')).toEqual(['机器学习']);
    expect(termsOf('Machine Learning 是子领域')).toEqual(['机器学习']);
  });

  it('命中区间正好覆盖匹配文本', () => {
    const text = '前 closure 后';
    const [h] = hitsOf(text);
    expect(h).toBeDefined();
    expect(text.slice(h?.start, h?.end)).toBe('closure');
  });
});

describe('规则 2：含拉丁字母的键按词边界匹配（防子串误报）', () => {
  it('独立成词才命中', () => {
    expect(termsOf('用 let 声明')).toEqual(['let']);
    expect(termsOf('用 LET 声明')).toEqual(['let']);
    expect(termsOf('let')).toEqual(['let']);
  });

  it('被字母包住的子串不命中（outlet / letdown / pallet）', () => {
    expect(termsOf('an outlet and letdown and pallet')).toEqual([]);
  });

  it('被数字贴住的子串不命中（let2 属于标识符，不是词）', () => {
    expect(termsOf('let2 = 1')).toEqual([]);
  });

  it('标点/空格/行首行尾都算边界', () => {
    expect(termsOf('（let）')).toEqual(['let']);
    expect(termsOf('let,')).toEqual(['let']);
    expect(termsOf('a\nlet\nb')).toEqual(['let']);
  });

  it('纯中文键按子串匹配（中文无词边界概念）', () => {
    expect(termsOf('闭包捕获的是引用')).toEqual(['闭包']);
    expect(termsOf('这个词叫闭包')).toEqual(['闭包']);
  });
});

describe('规则 3：同一位置多个键命中时取更长者', () => {
  const PAIR: TermKey[] = [{ term: '机器', aliases: [] }, { term: '机器学习', aliases: [] }];

  it('长键优先，不被短键截断', () => {
    const hits = hitsOf('机器学习入门', PAIR);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.term).toBe('机器学习');
    expect(hits[0]?.end).toBe(4);
  });

  it('短键在前声明也不影响（交替分支按长度降序排列）', () => {
    const reversed: TermKey[] = [{ term: '机器学习', aliases: [] }, { term: '机器', aliases: [] }];
    expect(hitsOf('机器学习入门', reversed)[0]?.term).toBe('机器学习');
  });

  it('不同位置的两条命中互不吞并', () => {
    const hits = hitsOf('机器的机器学习', PAIR);
    expect(hits.map((h) => h.term)).toEqual(['机器', '机器学习']);
    expect(hits.map((h) => h.start)).toEqual([0, 3]);
  });
});

describe('边界与容错（ADR-4：高亮是次级功能，不能抛错）', () => {
  it('空文本 / 空词条表 / 全空键都返回空数组', () => {
    expect(hitsOf('')).toEqual([]);
    expect(findTermHits('闭包', [])).toEqual([]);
    expect(findTermHits('闭包', [{ term: '  ' }, { term: '', aliases: [''] }])).toEqual([]);
  });

  it('aliases 缺失或为 null 不报错', () => {
    expect(findTermHits('ephemeral 是短暂的', [{ term: 'ephemeral' }])).toHaveLength(1);
    expect(findTermHits('ephemeral 是短暂的', [{ term: 'ephemeral', aliases: null }])).toHaveLength(1);
  });

  it('键里的正则元字符被转义（不会当成语法）', () => {
    const hits = findTermHits('时间复杂度 O(n) 很高', [{ term: 'O(n)' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe('O(n)');
    // 未转义的话 `.` 之类会乱匹配
    expect(findTermHits('Oxxn', [{ term: 'O.n' }])).toEqual([]);
  });

  it('重复声明同一个键时不产生重复命中', () => {
    const dup: TermKey[] = [
      { term: '闭包', aliases: ['closure'] },
      { term: '闭包', aliases: ['closure'] },
    ];
    expect(hitsOf('closure 与 closure', dup)).toHaveLength(2);
  });
});

describe('一致性：findTermHits 与 textHitsKey 必须同口径', () => {
  const TEXT = '闭包（closure）捕获变量引用；用 let 而非 var；outlet 不该命中；machine learning 是子领域。';

  it('findTermHits 命中的词条集合 = 所有 textHitsKey 为真的词条', () => {
    const byHits = new Set(hitsOf(TEXT).map((h) => h.term));
    const byBool = new Set(
      TERMS.filter((t) => termKeysOf(t).some((k) => textHitsKey(TEXT, k))).map((t) => t.term),
    );
    expect([...byHits].sort()).toEqual([...byBool].sort());
  });

  it('词边界在两条路径上判定一致（outlet 两侧都不算命中）', () => {
    expect(textHitsKey('an outlet', 'let')).toBe(false);
    expect(termsOf('an outlet')).toEqual([]);
    expect(textHitsKey('use let here', 'let')).toBe(true);
  });
});

describe('createTermMatcher：编译一次、多次扫描（流式性能要点）', () => {
  it('同一个匹配器可反复调用，结果稳定（g 标志不污染 lastIndex）', () => {
    const m = createTermMatcher(TERMS);
    const once = () => m.find('闭包 closure 与 let').map((h) => h.term);
    expect(once()).toEqual(['闭包', '闭包', 'let']);
    expect(once()).toEqual(['闭包', '闭包', 'let']);
    expect(m.find('ephemeral').map((h) => h.term)).toEqual(['ephemeral']);
  });

  it('空词条表：keyCount 为 0，find 恒返回空数组', () => {
    const m = createTermMatcher([]);
    expect(m.keyCount).toBe(0);
    expect(m.find('闭包 closure')).toEqual([]);
  });

  it('keyCount 计入别名并去重', () => {
    expect(createTermMatcher([{ term: '闭包', aliases: ['closure', 'Closure'] }]).keyCount).toBe(2);
  });

  it('与便捷入口 findTermHits 结果一致', () => {
    const text = '闭包 closure；用 let 而非 outlet';
    expect(createTermMatcher(TERMS).find(text)).toEqual(findTermHits(text, TERMS));
  });
});

describe('辅助函数', () => {
  it('hasLatinKey：含拉丁字母即真（中文、纯符号为假）', () => {
    expect(hasLatinKey('let')).toBe(true);
    expect(hasLatinKey('LET')).toBe(true);
    expect(hasLatinKey('B+树')).toBe(true);
    expect(hasLatinKey('闭包')).toBe(false);
    expect(hasLatinKey('（1）')).toBe(false);
  });

  it('termKeysOf：去空白、按小写去重、按长度降序', () => {
    expect(termKeysOf({ term: ' 闭包 ', aliases: ['closure', 'CLOSURE', '', '  '] })).toEqual([
      'closure',
      '闭包',
    ]);
    expect(termKeysOf({ term: 'let' })).toEqual(['let']);
    expect(termKeysOf({ term: '', aliases: ['a'] })).toEqual(['a']);
  });

  it('termKeyPattern：中文原样、英文加边界、元字符转义', () => {
    expect(termKeyPattern('闭包')).toBe('闭包');
    expect(termKeyPattern('let')).toBe('(?<![a-z0-9])let(?![a-z0-9])');
    expect(termKeyPattern('O(n)')).toBe('(?<![a-z0-9])O\\(n\\)(?![a-z0-9])');
  });
});
