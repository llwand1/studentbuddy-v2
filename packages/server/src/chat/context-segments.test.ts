/**
 * chat/context-segments 单测（**零依赖、零 IO**）。
 *
 * 只锁**纯函数**：`assembleContextMessages` 与 `countSegmentTokens`。
 * `collectContextSegments` 要拉 5 个真实数据源（摘要/画像/词条/文档/偏好），
 * 它的段顺序与条数由 `flow.test.ts` 的「长期记忆注入」describe **端到端**锁——
 * 那里用真库真数据源，比在这里桩一堆模块更接近真实出站形状。
 *
 * 为什么值得单独立锁：`openai` 适配器把多段 system 全量透传（`anthropic` 侧会合并），
 * 所以**段的位置对模型有语义**；而位置是这类重构最容易悄悄改坏的东西——
 * 改坏了不报错，只是模型读到的上下文换了个次序。
 */
import { describe, it, expect } from 'vitest';
import { assembleContextMessages, countSegmentTokens, type ContextSegment } from './context-segments.js';

describe('assembleContextMessages', () => {
  it('头部段插在基础提示词之后、历史之前；其余段追加在历史之后', () => {
    const segs: ContextSegment[] = [
      { kind: 'summary', content: '摘要正文' },
      { kind: 'terms', content: '词条正文' },
    ];

    const { messages } = assembleContextMessages(segs, [{ role: 'user', content: '本轮提问' }]);

    expect(messages[0]?.role).toBe('system'); // 基础提示词
    expect(messages[1]?.content).toBe('摘要正文'); // 它逻辑上是「历史的开头」
    expect(messages[2]?.content).toBe('本轮提问'); // 历史紧随其后
    expect(messages[3]?.content).toBe('词条正文'); // 辅助材料在历史之后
  });

  it('头部段按清单顺序落位（日期在摘要之前——防「恒插 1」的倒序退化）', () => {
    const segs: ContextSegment[] = [
      { kind: 'date', content: '日期段' },
      { kind: 'summary', content: '摘要段' },
      { kind: 'terms', content: '尾部' },
    ];

    const { messages } = assembleContextMessages(segs, [{ role: 'user', content: '提问' }]);

    // 顺序反了就成「先读摘要、再读今天几号」——日期是本次对话的前提，必须在最前
    expect(messages.slice(1, 3).map((m) => m.content)).toEqual(['日期段', '摘要段']);
    expect(messages[3]?.content).toBe('提问');
  });

  it('空内容段跳过：不产生空的 system 消息（预算算过的段一定会上屏，反之亦然）', () => {
    const segs: ContextSegment[] = [
      { kind: 'summary', content: '' },
      { kind: 'terms', content: '词条正文' },
      { kind: 'doc', content: '' },
    ];

    const { messages } = assembleContextMessages(segs, []);

    expect(messages).toHaveLength(2); // 基础提示词 + 词条，两个空段都不上屏
    expect(messages[1]?.content).toBe('词条正文');
  });

  it('返回的 nudgeMsg 就是数组里那一个（首轮结束后要能精确摘除）', () => {
    const segs: ContextSegment[] = [
      { kind: 'terms', content: '词条正文' },
      { kind: 'nudge', content: '硬指令' },
    ];

    const { messages, nudgeMsg } = assembleContextMessages(segs, []);

    expect(nudgeMsg?.content).toBe('硬指令');
    // 引用相等而非内容相等：flow 靠 indexOf 摘除，内容相等但对象不同就摘不掉
    expect(messages.findIndex((m) => m === nudgeMsg)).toBeGreaterThan(0);
  });

  it('没有可摘除段时 nudgeMsg 为 null（flow 据此跳过摘除）', () => {
    const { nudgeMsg } = assembleContextMessages([{ kind: 'terms', content: '词条正文' }], []);

    expect(nudgeMsg).toBeNull();
  });
});

describe('countSegmentTokens', () => {
  it('空清单为 0', () => {
    expect(countSegmentTokens([])).toBe(0);
  });

  it('等于逐段之和（CJK 一字一 token，故可精确断言）', () => {
    const segs: ContextSegment[] = [
      { kind: 'terms', content: '字'.repeat(10) },
      { kind: 'doc', content: '字'.repeat(5) },
    ];

    expect(countSegmentTokens(segs)).toBe(15);
  });

  it('空内容段贡献 0（剔除与否都不影响预算口径）', () => {
    const withEmpty: ContextSegment[] = [
      { kind: 'terms', content: '字'.repeat(7) },
      { kind: 'doc', content: '' },
    ];

    expect(countSegmentTokens(withEmpty)).toBe(7);
  });
});
