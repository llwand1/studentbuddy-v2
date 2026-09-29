/**
 * continent-expand.test — 开拓地块的纯口径（边界格 / 主导领域 / 随机题型）。
 *
 * 锁三件事：
 *  ① **边界格**的定义只有一份：世界内、没铺词条、四邻至少一格词条；`blocked`（荒地领地）排除；输出有序、不重复。
 *     前端画「+」与服务端判"能不能开拓"都读它——两端答案不同就是「图上有 +、点了 409」。
 *  ② **主导领域**：多数决，打平取先出现的（铺格序 = 更早入库者优先）。
 *  ③ **题型由 nonce 定且两道不重复**：同 nonce 恒同（服务端凭它重判），不同 nonce 会变（这就是"随机题型"）。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTINENT_EXPAND_QUESTIONS,
  CONTINENT_PLAYABLE_QTYPES,
  buildExpandQuestions,
  dominantDomain,
  expandQuestionTypes,
  frontierCells,
  isFrontierCell,
  neighborTilesOf,
} from './index.js';

const cell = (row: number, col: number) => ({ row, col });

describe('frontierCells — 边界空格', () => {
  it('① 单格世界中心 ⇒ 四邻四格，按 (row, col) 排序', () => {
    expect(frontierCells([cell(0, 0)], 7)).toEqual([cell(-1, 0), cell(0, -1), cell(0, 1), cell(1, 0)]);
  });

  it('① 已铺词条的格不算；两格相邻时共享的邻居只出现一次', () => {
    const out = frontierCells([cell(0, 0), cell(0, 1)], 7);
    expect(out).not.toContainEqual(cell(0, 0));
    expect(out).not.toContainEqual(cell(0, 1));
    expect(out.filter((c) => c.row === -1 && c.col === 0)).toHaveLength(1);
    expect(out).toHaveLength(6); // 2×2 上下 + 左右各 1
  });

  it('① 世界半径之外的格不算（半径 1 的世界里，(1,0) 的下方 (2,0) 不是边界）', () => {
    const out = frontierCells([cell(1, 0)], 1);
    expect(out).toContainEqual(cell(0, 0));
    expect(out).not.toContainEqual(cell(2, 0));
  });

  it('① blocked（荒地领地）排除在外，但服务端不传 blocked 时仍算边界（那只是前端不画 +）', () => {
    const blocked = new Set(['0,1']);
    expect(frontierCells([cell(0, 0)], 7, blocked)).not.toContainEqual(cell(0, 1));
    expect(isFrontierCell([cell(0, 0)], 7, cell(0, 1))).toBe(true);
    expect(isFrontierCell([cell(0, 0)], 7, cell(2, 2))).toBe(false);
    expect(isFrontierCell([], 7, cell(0, 0))).toBe(false); // 空大陆没有边界
  });

  it('neighborTilesOf 只取正四邻（斜对角不算）', () => {
    const tiles = [cell(0, 0), cell(1, 1), cell(0, 1)];
    expect(neighborTilesOf(tiles, cell(1, 0))).toEqual([cell(0, 0), cell(1, 1)]);
  });
});

describe('dominantDomain — 邻格主导领域', () => {
  it('② 多数决；打平取先出现的；空白领域不算；没邻居 ⇒ null', () => {
    expect(dominantDomain([{ domain: 'js' }, { domain: '数学' }, { domain: 'js' }])).toBe('js');
    expect(dominantDomain([{ domain: '数学' }, { domain: 'js' }])).toBe('数学');
    expect(dominantDomain([{ domain: '  ' }, { domain: 'js' }])).toBe('js');
    expect(dominantDomain([])).toBeNull();
  });
});

describe('expandQuestionTypes / buildExpandQuestions — 随机题型', () => {
  it('③ 两道题型不重复、同 nonce 恒同、不同 nonce 会变', () => {
    const a = expandQuestionTypes('nonce-a');
    expect(a).toHaveLength(CONTINENT_EXPAND_QUESTIONS);
    expect(new Set(a).size).toBe(a.length);
    expect(a.every((t) => CONTINENT_PLAYABLE_QTYPES.includes(t))).toBe(true);
    expect(expandQuestionTypes('nonce-a')).toEqual(a);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) seen.add(expandQuestionTypes(`n${i}`).join('+'));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('③ 题组长度恒为 2；池子只有自己时连线/选择退成建得出的题（永远有题可答）', () => {
    const term = { id: 'expand:n', term: '闭包', definition: '函数与它引用的词法环境的组合' };
    for (let i = 0; i < 20; i += 1) {
      const qs = buildExpandQuestions(term, [], `seed${i}`);
      expect(qs).toHaveLength(CONTINENT_EXPAND_QUESTIONS);
      expect(qs.every((q) => q.type !== 'match')).toBe(true); // 单词条池连不起来 ⇒ 退 fill
    }
    const pool = [
      { id: 'p1', term: '柯里化', definition: '把多参函数拆成单参函数链' },
      { id: 'p2', term: '记忆化', definition: '缓存函数结果避免重算' },
      { id: 'p3', term: '纯函数', definition: '同输入恒同输出且无副作用' },
    ];
    expect(buildExpandQuestions(term, pool, 'same')).toEqual(buildExpandQuestions(term, pool, 'same'));
  });
});
