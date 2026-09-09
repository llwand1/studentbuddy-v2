/**
 * learning/verdict-gate.test.ts — [VERDICT] 流式闸门边界（COGNITIVE-EVOLUTION-SPEC v1 §6.3 · §13 清单行 2）。
 * 锁死：跨 chunk 标记切分不吞文、未闭合 flush 原样吐回、一轮多块、闭合后正文继续。
 */
import { describe, it, expect } from 'vitest';
import { VerdictGate, VERDICT_OPEN, VERDICT_CLOSE, parseVerdictBlock, normalizeVerdict } from './verdict.js';

const BLOCK = `${VERDICT_OPEN}{"term":"闭包","level":2,"verdict":"要素齐了","met":["说清捕获变量"]}${VERDICT_CLOSE}`;

function feedAll(chunks: string[]): { visible: string; blocks: string[] } {
  const g = new VerdictGate();
  const visible: string[] = [];
  const blocks: string[] = [];
  for (const c of chunks) {
    const r = g.push(c);
    visible.push(r.visible);
    blocks.push(...r.blocks);
  }
  const f = g.flush();
  visible.push(f.visible);
  blocks.push(...f.blocks);
  return { visible: visible.join(''), blocks };
}

describe('VerdictGate — 标记与正文', () => {
  it('纯正文单 chunk：全量上屏、零块', () => {
    const { visible, blocks } = feedAll(['你好，世界']);
    expect(visible).toBe('你好，世界');
    expect(blocks).toEqual([]);
  });

  it('单 chunk 正文+完整判定块：块被摘出，正文一根毛不少', () => {
    const { visible, blocks } = feedAll(['讲得不错。' + BLOCK]);
    expect(visible).toBe('讲得不错。');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('"term":"闭包"');
  });

  it('OPEN 标记跨 chunk 切断（[VER + DICT]）：不误上屏、不丢块', () => {
    const { visible, blocks } = feedAll(['好。[VER', 'DICT]{"term":"闭包","level":1,"verdict":"x"}', '[/VERD', 'ICT]']);
    expect(visible).toBe('好。');
    expect(blocks).toHaveLength(1);
  });

  it('逐字符喂入整段（最刁钻流式）：结果与整块喂入一致', () => {
    const text = '先点评。' + BLOCK + '下轮再见。';
    const perChar = feedAll([...text]);
    const oneShot = feedAll([text]);
    expect(perChar.visible).toBe('先点评。下轮再见。');
    expect(perChar.visible).toBe(oneShot.visible);
    expect(perChar.blocks).toEqual(oneShot.blocks);
  });

  it('假标记原样吐回（[VERY 不是 OPEN 前缀的延续）', () => {
    const { visible, blocks } = feedAll(['数组下标 [VERY 大的写法']);
    expect(visible).toBe('数组下标 [VERY 大的写法');
    expect(blocks).toEqual([]);
  });

  it('一轮多块（用户一次讲多个词条）：两块独立摘出，中间正文上屏', () => {
    const b2 = `${VERDICT_OPEN}{"term":"栈","level":1,"verdict":"y"}${VERDICT_CLOSE}`;
    const { visible, blocks } = feedAll([`第一段。${BLOCK}衔接。${b2}收尾。`]);
    expect(visible).toBe('第一段。衔接。收尾。');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain('"栈"');
  });
});

describe('VerdictGate — 收口与降级', () => {
  it('整轮无标记：flush 后累计 visible == 原文（屏上==库内不破坏）', () => {
    const g = new VerdictGate();
    let acc = '';
    for (const c of ['今日', '练习', '完成']) acc += g.push(c).visible;
    acc += g.flush().visible;
    expect(acc).toBe('今日练习完成');
  });

  it('悬空真前缀（[VERDICT 未成 OPEN）flush 原样吐回，绝不吞字', () => {
    const { visible, blocks } = feedAll(['看这里 [VERDICT']);
    expect(visible).toBe('看这里 [VERDICT');
    expect(blocks).toEqual([]);
  });

  it('进入块后流被截断（无 CLOSE）：OPEN+半截 JSON 全量吐回可见文本（宁漏上不静默丢）', () => {
    const { visible, blocks } = feedAll(['评语。' + VERDICT_OPEN + '{"term":"闭包","level":']);
    expect(visible).toBe('评语。' + VERDICT_OPEN + '{"term":"闭包","level":');
    expect(blocks).toEqual([]);
  });

  it('gate → parse → normalize 全链：跨 chunk 流入、v1.1 met 出得去', () => {
    const { blocks } = feedAll(['很好。[VERDICT]{"term":"闭包","le', 'vel":3,"verdict":"边界清楚了","met":["讲清了生命周期"]}', '[/VERDICT]继续练。']);
    expect(blocks).toHaveLength(1);
    const parsed = parseVerdictBlock(blocks[0]!);
    const n = parsed && normalizeVerdict(parsed, new Set(['闭包']));
    expect(n?.level).toBe(3);
    expect(n?.met).toEqual(['讲清了生命周期']);
  });
});
