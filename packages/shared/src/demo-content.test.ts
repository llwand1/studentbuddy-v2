/**
 * shared/demo-content — 体验号种子内容的形状锁（渠道台账 C5）。
 *
 * ★ 这里只管「这份数据自不自洽」：阶段别越界、名字别重、释义别空。
 *   它**在真实读取路径下长成什么样**由 server 侧 `auth/demo-seed.test.ts` 锁；
 *   它与对外讲解页同不同名由 web 侧 `seo/term-corpus.test.ts` 锁。三处各管一段，不重叠。
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_SEED_MAX_STAGE,
  DEMO_SEED_TERMS,
  demoSeedBackdateDays,
  demoSeedDomains,
} from '@sb/shared';
import { MAX_REVIEW_STAGE, REVIEW_INTERVALS_DAYS, reviewIntervalDays } from './ebbinghaus.js';

describe('demo-content · 形状', () => {
  it('八条齐备：词条名唯一、释义与领域非空', () => {
    expect(DEMO_SEED_TERMS).toHaveLength(8);
    const names = DEMO_SEED_TERMS.map((t) => t.term);
    expect(new Set(names).size).toBe(names.length);
    for (const t of DEMO_SEED_TERMS) {
      expect(t.term.trim().length).toBeGreaterThan(1);
      expect(t.definition.trim().length, t.term).toBeGreaterThan(10);
      expect(t.domain.trim().length, t.term).toBeGreaterThan(0);
      expect(t.domain.length, t.term).toBeLessThanOrEqual(30); // 与 saveOneTerm 的截断一致，超了会静默改名
    }
  });

  it('★ 阶段全部落在曲线契约的合法域内（越界会静默失真，不是报错）', () => {
    expect(DEMO_SEED_MAX_STAGE).toBe(MAX_REVIEW_STAGE);
    for (const t of DEMO_SEED_TERMS) {
      expect(Number.isInteger(t.stage), t.term).toBe(true);
      expect(t.stage, t.term).toBeGreaterThanOrEqual(0);
      expect(t.stage, t.term).toBeLessThanOrEqual(MAX_REVIEW_STAGE);
    }
  });

  it('首屏有活干、也不是一眼望到底：到期与未到期都有，且领域至少三个（Tab 不空）', () => {
    const due = DEMO_SEED_TERMS.filter((t) => t.dueToday);
    expect(due.length).toBeGreaterThanOrEqual(3);
    expect(due.length).toBeLessThan(DEMO_SEED_TERMS.length);
    expect(demoSeedDomains().length).toBeGreaterThanOrEqual(3);
    // 从未复习过的也要有一条：它演示的是「刚存进来」那一档
    expect(DEMO_SEED_TERMS.some((t) => t.stage === 0)).toBe(true);
  });

  it('★ 时间偏移全由间隔表算出，本模块零自造天数', () => {
    for (const t of DEMO_SEED_TERMS) {
      const back = demoSeedBackdateDays(t);
      expect(back, t.term).toBe(t.dueToday ? reviewIntervalDays(t.stage) : 0);
      if (t.dueToday && t.stage > 0) {
        expect(REVIEW_INTERVALS_DAYS).toContain(back); // 到期点必然是曲线上的一个节点
      }
    }
  });

  it('领域去重后的集合与条目里出现的领域一致（种子表自己不能自相矛盾）', () => {
    expect([...demoSeedDomains()].sort()).toEqual(
      [...new Set(DEMO_SEED_TERMS.map((t) => t.domain))].sort(),
    );
  });
});
