/**
 * learning/verdict.test.ts — [VERDICT] 解析与归一化（DEEP-UNDERSTANDING-SPEC v1.1 §6.1/§6.3 · §13 清单行 1+5）。
 * 纯函数测试不触 DB/LLM，Node 任意大版本可跑。
 */
import { describe, it, expect } from 'vitest';
import type { Verdict } from '@sb/shared';
import { parseVerdictBlock, normalizeVerdict } from './verdict.js';

const ALLOWED = new Set(['闭包', '栈']);

/** §6.1 契约示例逐字（含 v1.1 met）——「示例 JSON 自带 met 字段可被解析」防老坑回归 */
const SPEC_EXAMPLE =
  '{"term":"闭包","level":2,"verdict":"你把「函数记住外部变量」说清楚了，但没说清捕获的是变量本身还是值，这是 L2 到 L3 的关键。","gaps":["未区分捕获变量与捕获值","没提生命周期"],"nextGoal":"说清闭包捕获变量的生命周期，并举一个踩坑例子","evidence":"用户原话中最能支撑判定的一句","met":["说清了捕获的是变量本身而非值"]}';

describe('parseVerdictBlock — 容错阶梯', () => {
  it('契约 §6.1 示例逐字解析成功，met 与全字段在形', () => {
    const v = parseVerdictBlock(`[VERDICT]${SPEC_EXAMPLE}[/VERDICT]`);
    expect(v).not.toBeNull();
    expect(v?.term).toBe('闭包');
    expect(v?.met).toEqual(['说清了捕获的是变量本身而非值']);
    expect(v?.gaps).toHaveLength(2);
  });

  it('裸 JSON（无外层标记）也解析（gate.blocks 给的就是内文）', () => {
    expect(parseVerdictBlock(SPEC_EXAMPLE)?.term).toBe('闭包');
  });

  it('围栏 ```json 与前后杂质容错', () => {
    const v = parseVerdictBlock('前置说明\n```json\n' + SPEC_EXAMPLE + '\n```\n后置');
    expect(v?.level).toBe(2);
  });

  it('verdict 文本里含花括号不截错对象（string-aware 扫描）', () => {
    const raw = '{"term":"栈","level":1,"verdict":"说清了 } 这种符号也 { 能处理","met":[]}';
    const v = parseVerdictBlock(raw);
    expect(v?.verdict).toContain('}');
  });

  it('非法 JSON / 无对象 / 数组顶层 → null（ADR-4 降级不崩）', () => {
    expect(parseVerdictBlock('[VERDICT]not-json[/VERDICT]')).toBeNull();
    expect(parseVerdictBlock('完全无关文本')).toBeNull();
    expect(parseVerdictBlock('[1,2,3]')).toBeNull();
  });

  it('缺收尾括号的残缺块 → null（截断流走降级，不猜题）', () => {
    expect(parseVerdictBlock('{"term":"闭包","level":2,"verdict":"没写完')).toBeNull();
  });
});

describe('normalizeVerdict — §6.1 约束 + v1.1 met 三态与双空兜底', () => {
  it('term 白名单外 → 整块丢弃（防模型乱判别的词条）', () => {
    const v: Verdict = { term: '指针', level: 1, verdict: 'ok' };
    expect(normalizeVerdict(v, ALLOWED)).toBeNull();
  });

  it('term 两侧空白容错（trim 后再对白名单）', () => {
    const v: Verdict = { term: ' 闭包 ', level: 1, verdict: 'ok' };
    expect(normalizeVerdict(v, ALLOWED)?.term).toBe('闭包');
  });

  it('level 越界钳到 0..4，小数四舍五入；非数字 → 丢块', () => {
    const mk = (level: unknown): Verdict => ({ term: '闭包', level: level as number, verdict: 'ok' });
    expect(normalizeVerdict(mk(7), ALLOWED)?.level).toBe(4);
    expect(normalizeVerdict(mk(-2), ALLOWED)?.level).toBe(0);
    expect(normalizeVerdict(mk(2.6), ALLOWED)?.level).toBe(3);
    expect(normalizeVerdict(mk('2'), ALLOWED)).toBeNull();
    expect(normalizeVerdict(mk(NaN), ALLOWED)).toBeNull();
  });

  it('verdict 必填非空、超 500 字截断（丢块从宽惩罚过重，截断保语义）', () => {
    const long: Verdict = { term: '闭包', level: 1, verdict: '啊'.repeat(600) };
    expect(normalizeVerdict(long, ALLOWED)?.verdict).toHaveLength(500);
    expect(normalizeVerdict({ term: '闭包', level: 1, verdict: '   ' }, ALLOWED)).toBeNull();
  });

  it('met 三态之一：合法字符串数组超 3 条 → 截 3', () => {
    const v: Verdict = { term: '闭包', level: 1, verdict: 'ok', met: ['a', 'b', 'c', 'd', 'e'] };
    expect(normalizeVerdict(v, ALLOWED)?.met).toEqual(['a', 'b', 'c']);
  });

  it('met 三态之二：空数组合法保留（诚实档），与丢块是两回事', () => {
    const v: Verdict = { term: '闭包', level: 3, verdict: 'ok', gaps: ['缺边界'], met: [] };
    const n = normalizeVerdict(v, ALLOWED);
    expect(n?.met).toEqual([]);
    expect(n?.gaps).toEqual(['缺边界']);
  });

  it('met 三态之三：非数组 → 丢字段不丢块（verdict 主体保留）', () => {
    const dirty = { term: '闭包', level: 1, verdict: 'ok', met: '说清了捕获' } as unknown as Verdict;
    const n = normalizeVerdict(dirty, ALLOWED);
    expect(n).not.toBeNull();
    expect(n?.met).toEqual([]); // 单字段脏 + 无 gaps → 走双空兜底显式 []
  });

  it('met 含非字符串元素 → 整字段丢（§6.1「非字符串数组」严格读）', () => {
    const mixed = { term: '闭包', level: 1, verdict: 'ok', gaps: ['缺边界'], met: ['好', 42] } as unknown as Verdict;
    expect(normalizeVerdict(mixed, ALLOWED)?.met).toBeUndefined();
  });

  it('双空兜底：met/gaps 皆无 → met 显式置 []（反馈纪律：绝不静默吞卡）', () => {
    const v: Verdict = { term: '闭包', level: 2, verdict: '本轮判定完成' };
    const n = normalizeVerdict(v, ALLOWED);
    expect(Array.isArray(n?.met)).toBe(true);
    expect(n?.met).toHaveLength(0);
  });

  it('gaps 非字符串元素逐个过滤（v1 老口径，parseAliases 同族）；滤空则不落字段', () => {
    const dirty = { term: '闭包', level: 1, verdict: 'ok', gaps: ['缺边界', 7, null] } as unknown as Verdict;
    expect(normalizeVerdict(dirty, ALLOWED)?.gaps).toEqual(['缺边界']);
    const allDirty = { term: '闭包', level: 1, verdict: 'ok', gaps: [1, 2] } as unknown as Verdict;
    expect(normalizeVerdict(allDirty, ALLOWED)?.gaps).toBeUndefined();
  });

  it('nextGoal 保留 string 与 null 两形；数字等脏值丢字段', () => {
    const s: Verdict = { term: '闭包', level: 1, verdict: 'ok', gaps: ['x'], nextGoal: '讲边界' };
    expect(normalizeVerdict(s, ALLOWED)?.nextGoal).toBe('讲边界');
    const nul = { term: '闭包', level: 4, verdict: 'ok', nextGoal: null } as Verdict;
    expect(normalizeVerdict(nul, ALLOWED)?.nextGoal).toBeNull();
    const bad = { term: '闭包', level: 1, verdict: 'ok', gaps: ['x'], nextGoal: 3 } as unknown as Verdict;
    expect(normalizeVerdict(bad, ALLOWED)?.nextGoal).toBeUndefined();
  });

  it('不改入参（返回新对象；上游 raw 复用安全）', () => {
    const v: Verdict = { term: '闭包', level: 9, verdict: 'ok' };
    const frozen = JSON.stringify(v);
    normalizeVerdict(v, ALLOWED);
    expect(JSON.stringify(v)).toBe(frozen);
  });
});
