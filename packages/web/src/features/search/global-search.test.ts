/**
 * features/search/global-search — 全站搜索前端逻辑的门禁（契约 `docs/FTS-SPEC.md` §3.4）。
 *
 * 只测**纯函数**（分区口径 + 高亮切分）：这两件事是"写错不报错"的典型——
 * 分区写错会让整类结果消失（用户以为没搜到），切分写错会让高亮落在错的字上
 * （用户以为搜错了词）。渲染层只是把它们的输出摆出来，`GlobalSearch.tsx` 的
 * 交互锁由后续 jsdom 批补（与本仓 `.tsx` 测试的推进节奏一致）。
 */
import { describe, it, expect } from 'vitest';
import type { FtsHit } from '@sb/shared';
import { groupHits, splitByQuery } from './use-global-search';

function hit(kind: FtsHit['kind'], refId: string): FtsHit {
  return { kind, refId, title: `${kind}-${refId}`, snippet: '', updatedAt: '', score: 0 };
}

describe('groupHits — 按 kind 分区', () => {
  it('两类各归各位', () => {
    const g = groupHits([hit('term', 't1'), hit('message', 'm1'), hit('term', 't2')]);
    expect(g.term.map((h) => h.refId)).toEqual(['t1', 't2']);
    expect(g.message.map((h) => h.refId)).toEqual(['m1']);
  });

  it('★ 空输入也返回**固定两键**（不是 {}）——渲染层少判一次 undefined 的代价是整块不渲染', () => {
    const g = groupHits([]);
    expect(g).toEqual({ message: [], term: [] });
    expect(Object.keys(g).sort()).toEqual(['message', 'term']);
  });

  it('保持服务端给的顺序（bm25 升序 = 越相关越前），前端不重排', () => {
    const g = groupHits([hit('term', 'a'), hit('term', 'b'), hit('term', 'c')]);
    expect(g.term.map((h) => h.refId)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitByQuery — 命中切分（高亮的唯一依据）', () => {
  it('把命中处单独切出来，两侧原文一字不差', () => {
    expect(splitByQuery('牛顿第二定律', '第二')).toEqual([
      { text: '牛顿', hit: false },
      { text: '第二', hit: true },
      { text: '定律', hit: false },
    ]);
  });

  it('★ 大小写不敏感匹配，但**保留原文大小写**显示（不把 Closure 显示成 closure）', () => {
    expect(splitByQuery('Closure 与闭包', 'closure')).toEqual([
      { text: 'Closure', hit: true },
      { text: ' 与闭包', hit: false },
    ]);
  });

  it('同一段里的多次命中都要标出来', () => {
    expect(splitByQuery('ab-cd-ab', 'ab')).toEqual([
      { text: 'ab', hit: true },
      { text: '-cd-', hit: false },
      { text: 'ab', hit: true },
    ]);
  });

  it('命中在结尾时不产生空尾巴片段', () => {
    expect(splitByQuery('前面是 ab', 'ab')).toEqual([
      { text: '前面是 ', hit: false },
      { text: 'ab', hit: true },
    ]);
  });

  it('没有命中 ⇒ 原样一段（不切、不报错）', () => {
    expect(splitByQuery('完全无关的文本', '牛顿')).toEqual([{ text: '完全无关的文本', hit: false }]);
  });

  it('空查询 ⇒ 原样一段（搜索框刚清空时不该把整条染成高亮）', () => {
    expect(splitByQuery('任意文本', '')).toEqual([{ text: '任意文本', hit: false }]);
    expect(splitByQuery('任意文本', '   ')).toEqual([{ text: '任意文本', hit: false }]);
  });

  it('查询两侧空白被 trim 掉再匹配（用户手滑多打空格不该搜不到）', () => {
    expect(splitByQuery('牛顿第二定律', ' 第二 ')).toEqual([
      { text: '牛顿', hit: false },
      { text: '第二', hit: true },
      { text: '定律', hit: false },
    ]);
  });
});
