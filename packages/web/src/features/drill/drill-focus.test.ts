/**
 * drill-focus：番茄钟工作段的刷词取词口径（契约 `docs/POMODORO-SPEC.md` §5.3）。
 *
 * 钉死三件事，每一件都是用户能直接看见的行为：
 *   ① **硬过滤**：工作段里方向外的词条一条都不出——哪怕它到期了（这是本次改动的全部意义：
 *      旧 soft 口径下到期词条恒压最上面，于是「数学 30 分钟」照样刷英语）；
 *   ② **三级兜底**：方向内刷完 ⇒ 重复巩固；库里这个方向压根没有 ⇒ 给空队列 + 要求现场出题；
 *   ③ **没方向不受影响**：没开钟 / 休息段逐字走原路（回归锁：别把没开钟的人也锁进过滤器）。
 */
import { describe, expect, it } from 'vitest';
import type { DrillQueueTerm } from '@sb/shared';
import { buildDrillQueue, drillFocusNotice, needsFocusRefill, type DrillFocusQueue } from './drill-focus';

const t = (id: string, domain: string, status: DrillQueueTerm['status'], inScope = true): DrillQueueTerm => ({
  id,
  term: `词${id}`,
  definition: `释义${id}`,
  domain,
  status,
  inScope,
});

/** 英语的两条都「到期」，数学的两条都没到期——soft 口径下英语必然排在前面 */
const lib: DrillQueueTerm[] = [
  t('e1', '英语', 'overdue'),
  t('e2', '英语', 'due'),
  t('m1', '数学', 'upcoming'),
  t('m2', '高等数学', 'mastered'),
];

const ids = (x: DrillFocusQueue): string[] => x.items.map((i) => i.term.id);

describe('buildDrillQueue：工作段硬过滤', () => {
  it('① 只出方向内的词条——到期的英语也不出（这正是 soft 口径修不好的那一条）', () => {
    const out = buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(), subject: '数学' });
    expect(out.outcome).toBe('focused');
    expect(new Set(ids(out))).toEqual(new Set(['m1', 'm2']));
  });

  it('① 方向用的是 domainMatchesFocus：「数学」吃得下「高等数学」', () => {
    const out = buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(), subject: '高等数学' });
    expect(new Set(ids(out))).toEqual(new Set(['m1', 'm2']));
  });

  it('③ 没方向（没开钟 / 休息段）走原路：全库都在，到期的排前', () => {
    const out = buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(), subject: null });
    expect(out.outcome).toBe('none');
    expect(out.items).toHaveLength(4);
    expect(out.items.slice(0, 2).every((i) => i.origin === 'due')).toBe(true);
  });

  it('③ 空白方向按「没方向」处理，不会把人锁进一个空过滤器', () => {
    expect(buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(), subject: '   ' }).items).toHaveLength(4);
  });
});

describe('buildDrillQueue：排空后的三级兜底', () => {
  it('② 方向内今天都斩完了 ⇒ 忽略 exclude 重复巩固，而不是滑到别的方向', () => {
    const out = buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(['m1', 'm2']), subject: '数学' });
    expect(out.outcome).toBe('repeat');
    expect(new Set(ids(out))).toEqual(new Set(['m1', 'm2']));
    // 关键：重复的仍然只有数学，英语一条都没混进来
    expect(ids(out).some((id) => id.startsWith('e'))).toBe(false);
  });

  it('② 库里这个方向一条都没有 ⇒ 队列给空并标 exhausted（交给现场出题）', () => {
    const out = buildDrillQueue({ terms: lib, dayKey: 'd1', exclude: new Set(), subject: '法语' });
    expect(out.outcome).toBe('exhausted');
    expect(out.items).toHaveLength(0);
  });

  it('② 两种排空都要求补新词；正常出词与没方向都不打网络', () => {
    expect(needsFocusRefill('repeat')).toBe(true);
    expect(needsFocusRefill('exhausted')).toBe(true);
    expect(needsFocusRefill('focused')).toBe(false);
    expect(needsFocusRefill('none')).toBe(false);
  });
});

describe('drillFocusNotice：为什么你看到的是这些（ADR-5 不静默）', () => {
  it('正常出词不说话，排空两档都说明原因且带方向名', () => {
    expect(drillFocusNotice('focused', '数学')).toBe('');
    expect(drillFocusNotice('none', null)).toBe('');
    expect(drillFocusNotice('repeat', '数学')).toContain('数学');
    expect(drillFocusNotice('repeat', '数学')).toContain('重复巩固');
    expect(drillFocusNotice('exhausted', '法语')).toContain('现场出新词');
  });
});
