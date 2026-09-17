/**
 * learning/scenario-protocol — 解析阶梯测试（契约 §6）。
 * 每档阶梯对应模型的一种真实失败形态；引用完整性是 M2 的核心防线（评分点接不上桥接＝死题）。
 */
import { describe, expect, it } from 'vitest';
import { emptyScenarioGenReport, parseScenarioBlock, SCENARIO_PROTOCOL } from './scenario-protocol.js';
import { MAX_SCENARIO_HTML_CHARS } from '@sb/shared';

const JSON_OK = '[SCENARIO]{"title":"断电检修","tasks":[{"id":"t1","prompt":"先断开总闸","criteria":{"kind":"state","value":"off"}},{"id":"t2","prompt":"选出该带的护具","criteria":{"kind":"choice","answer":[0,2]}},{"id":"t3","prompt":"按顺序操作","criteria":{"kind":"order","answer":["断电","验电","挂牌"]}}]}[/SCENARIO]';
const HTML_OK = '[SCENARIO_HTML]<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><button onclick="SBScenario.report(\'t1\',\'off\')">断闸</button><script>SBScenario.report(\'t2\',[0,2]);SBScenario.report(\'t3\',[\'断电\',\'验电\',\'挂牌\']);</script></body></html>[/SCENARIO_HTML]';
const FULL_OK = `好的，这是情景题：\n${JSON_OK}\n${HTML_OK}\n以上。`;

describe('scenario-protocol — parseScenarioBlock 标准路径', () => {
  it('成对标记 + 前后杂质解析成功，三评分点全保留', () => {
    const r = emptyScenarioGenReport();
    const out = parseScenarioBlock(FULL_OK, r);
    expect(out).not.toBeNull();
    expect(out?.payload.title).toBe('断电检修');
    expect(out?.payload.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(out?.html).toContain('SBScenario.report');
    expect(r.truncated).toBe(false);
    expect(r.droppedTasks).toBe(0);
  });

  it('忘写 [SCENARIO] 标记、只给 JSON 时兜底抽取（htmlStart 前找 tasks）', () => {
    const out = parseScenarioBlock(`{"title":"T","tasks":[{"id":"t1","prompt":"p","criteria":{"kind":"state","value":"off"}}]}\n${HTML_OK}`);
    expect(out?.payload.tasks).toHaveLength(1);
  });
});

describe('scenario-protocol — 救援阶梯', () => {
  it('JSON 里漏转义（criteria 值带裸引号）经修复仍可解析', () => {
    // 模拟模型在字符串值里写了未转义引号：state 值 "off" 写成裸的 —— 这里用漏括号形态更可复现
    const broken = `[SCENARIO]{"title":"T","tasks":[{"id":"t1","prompt":"p","criteria":{"kind":"choice","answer":[1,2,3]}},"id":"t2","prompt":"q","criteria":{"kind":"state","value":"ok"}]}][/SCENARIO]`;
    const out = parseScenarioBlock(`${broken}${HTML_OK}`);
    // t1 的 criteria 数组漏了 ]：修复后 t1 保留
    expect(out?.payload.tasks[0]?.id).toBe('t1');
  });

  it('JSON 撞 max_tokens 截断（最后一个 task 残缺）→ 逐题回退保留完整部分', () => {
    // 切进 JSON 内部：去掉收尾 `}}]}` 与闭合标记，t3 的 task 对象没闭合——这才是真截断形态
    const truncated = JSON_OK.replace('[/SCENARIO]', '').slice(0, -4) + ',{"id":"t4","prompt":"残缺任务","criteria":{"kind":"sta';
    const r = emptyScenarioGenReport();
    const out = parseScenarioBlock(`${truncated}${HTML_OK}`, r);
    expect(out).not.toBeNull();
    expect(out?.payload.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(r.truncated).toBe(true);
  });

  it('HTML 无闭合标记 → 抢救到 </html>，truncated 如实报', () => {
    // 残缺形态：闭合标记被截掉，</html> 之后还有半截垃圾——抢救应收口到 </html>
    const htmlNoClose = HTML_OK.replace('[/SCENARIO_HTML]', '') + '<!-- 半截垃圾残缺';
    const r = emptyScenarioGenReport();
    const out = parseScenarioBlock(`${JSON_OK}\n${htmlNoClose}`, r);
    expect(out).not.toBeNull();
    expect(out?.html.toLowerCase().endsWith('</html>')).toBe(true);
    expect(r.htmlRescued).toBe(true);
    expect(r.truncated).toBe(true);
  });
});

describe('scenario-protocol — 引用完整性与硬限制', () => {
  it('id 没出现在 HTML 里的评分点整条丢弃并计数', () => {
    const json = '[SCENARIO]{"title":"T","tasks":[{"id":"t1","prompt":"有接线","criteria":{"kind":"state","value":"off"}},{"id":"t9","prompt":"幽灵任务","criteria":{"kind":"state","value":"x"}}]}[/SCENARIO]';
    const r = emptyScenarioGenReport();
    const out = parseScenarioBlock(`${json}\n${HTML_OK}`, r);
    expect(out?.payload.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(r.droppedTasks).toBe(1);
  });

  it('全部评分点都接不上 demo → 整组 null（死题不成套）', () => {
    const json = '[SCENARIO]{"title":"T","tasks":[{"id":"zz1","prompt":"p","criteria":{"kind":"state","value":"off"}}]}[/SCENARIO]';
    expect(parseScenarioBlock(`${json}\n${HTML_OK}`)).toBeNull();
  });

  it('没有 HTML 段 → null（情景题没有 demo 不成题）', () => {
    expect(parseScenarioBlock(JSON_OK)).toBeNull();
  });

  it('demo 超过 MAX_SCENARIO_HTML_CHARS → null 且 htmlOversized 如实报', () => {
    const big = '[SCENARIO_HTML]' + '<!--'.padEnd(MAX_SCENARIO_HTML_CHARS + 10, 'x') + '-->[/SCENARIO_HTML]';
    const r = emptyScenarioGenReport();
    expect(parseScenarioBlock(`${JSON_OK}\n${big}`, r)).toBeNull();
    expect(r.htmlOversized).toBe(true);
  });

  it('协议示例自带可解析性：SCENARIO_PROTOCOL 里的 JSON 部分能走通 normalize', () => {
    // 防提示词腐化：示例改坏了协议，解析器第一个发现
    const sample = SCENARIO_PROTOCOL.match(/\[SCENARIO\](\{[\s\S]*?\})\[\/SCENARIO\]/)?.[1] ?? '';
    expect(sample).not.toBe('');
    const out = parseScenarioBlock(`[SCENARIO]${sample}[/SCENARIO]\n${HTML_OK}`);
    expect(out?.payload.tasks.length).toBeGreaterThan(0);
    // 示例里的 id（t1/t2/t3）必须在 HTML_OK 里可引用——示例与测试 fixture 同一套 id
    expect(out?.payload.tasks.every((t) => ['t1', 't2', 't3'].includes(t.id))).toBe(true);
  });
});
