/**
 * chat/opening.test —— 「本轮首轮强制动作」装配层的单测（v18.4，2026-09-17）。
 *
 * 这层的存在理由就是「触发权不该在模型手里」，所以测的不是提示词文案好不好，
 * 而是**装配规则**是否如约（规则错了，提示词写得再对也没用）：
 * ① 两个开关都关 → 不注入、不干预（`toolChoice=undefined` = 适配器默认 auto）；
 * ② 联网开 → 硬指令 + 首轮强绑 search_web；
 * ③ 两个都开 → 强绑名额归 grill（GRILL_PRE 的「必须」与强绑 search 直接打架）；
 * ④ 摘除幂等、且只摘自己那条（摘错会误伤会话历史）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/types.js';
import { GRILL_PRE, GRILL_TOOL_CHOICE } from './grill.js';
import { SEARCH_FORCE, SEARCH_TOOL_CHOICE, buildOpening, dropOpening, finishToolRound } from './opening.js';

/** 指令消息的文本（content 类型是 `string | ContentPart[]`，本层恒为纯文本） */
const textOf = (msg: ChatMessage | null): string => String(msg?.content ?? '');

it('工具结果后偏好按引用移到末尾，多轮不重复，开场约束只摘一次', () => {
  const o = buildOpening({ grill: false, online: true });
  const style: ChatMessage = { role: 'system', content: '本轮学习回复' };
  const nudge: ChatMessage = { role: 'system', content: '首轮提示' };
  const user: ChatMessage = { role: 'user', content: '问题' };
  const tool: ChatMessage = { role: 'tool', content: '检索结果', toolCallId: 't' };
  const messages: ChatMessage[] = [user, style, nudge, o.msg!, tool];
  finishToolRound(messages, o, nudge, style, 0);
  expect(messages).toEqual([user, tool, style]);
  const next: ChatMessage = { role: 'tool', content: '后续结果', toolCallId: 't2' };
  messages.push(next);
  finishToolRound(messages, o, nudge, style, 1);
  expect(messages).toEqual([user, tool, next, style]);
  expect(messages.filter((m) => m === style)).toHaveLength(1);
  const missing = [...messages];
  finishToolRound(messages, o, null, null, 2);
  expect(messages).toEqual(missing);
  const original = style.content;
  messages.push({ role: 'assistant', content: '> [!CORE] 上一轮历史\n> 内容' });
  expect(finishToolRound(messages, o, null, style, 3, '我先查询')).toBe('');
  expect(style.content).toBe(original);
  const note = finishToolRound(messages, o, null, style, 4, '> [!CORE] 本轮已显示\n> 内容');
  expect(note).toContain('【已交付学习开篇】');
  expect(finishToolRound(messages, o, null, style, 5, '> [!ROUTE] 路线\n> 内容')).toBe('');
  expect(String(style.content).split('【已交付学习开篇】')).toHaveLength(2);
  expect(messages.filter((m) => m === style)).toHaveLength(1);
});

describe('buildOpening（开关 → 指令 + 首轮强绑）', () => {
  it('两个开关都关 → 不注入消息、不干预模型（auto）', () => {
    const o = buildOpening({ grill: false, online: false });
    expect(o.msg).toBeNull();
    expect(o.toolChoice).toBeUndefined();
    expect(o.grill).toBe(false);
  });

  it('联网开 → 消息带联网硬指令，首轮强绑 search_web', () => {
    const o = buildOpening({ grill: false, online: true });
    expect(textOf(o.msg)).toBe(SEARCH_FORCE);
    expect(o.toolChoice).toEqual(SEARCH_TOOL_CHOICE);
  });

  it('grill 开 → 消息带 grill 开场指令，首轮强绑 ask_choice，并标记 grill', () => {
    const o = buildOpening({ grill: true, online: false });
    expect(textOf(o.msg)).toBe(GRILL_PRE);
    expect(o.toolChoice).toEqual(GRILL_TOOL_CHOICE);
    expect(o.grill).toBe(true);
  });

  it('两个都开 → 强绑名额归 grill（一轮只有一个名额，取表述更硬的那个）', () => {
    const o = buildOpening({ grill: true, online: true });
    expect(o.toolChoice).toEqual(GRILL_TOOL_CHOICE);
  });

  it('两个都开 → 两段指令合成**同一条**消息（同位置同用途，不拆两条）', () => {
    const o = buildOpening({ grill: true, online: true });
    expect(textOf(o.msg)).toContain(GRILL_PRE);
    expect(textOf(o.msg)).toContain(SEARCH_FORCE);
  });

  it('SEARCH_TOOL_CHOICE 锁死 search_web —— 强绑靠这个常量，不靠提示词自觉', () => {
    expect(SEARCH_TOOL_CHOICE).toEqual({ type: 'function', name: 'search_web' });
  });

  it('联网硬指令不含「放弃」台阶（病灶正是那句「或基于已有知识回答」）', () => {
    expect(SEARCH_FORCE).toContain('已开启联网搜索');
    expect(SEARCH_FORCE).not.toContain('基于已有知识回答');
  });
});

describe('dropOpening（出循环即摘）', () => {
  it('只摘自己那条，其余消息一条不动', () => {
    const o = buildOpening({ grill: false, online: true });
    const other: ChatMessage = { role: 'user', content: '会话历史' };
    const messages: ChatMessage[] = [other, o.msg!];
    dropOpening(messages, o);
    expect(messages).toEqual([other]);
  });

  it('幂等：摘第二次不抛也不误伤', () => {
    const o = buildOpening({ grill: false, online: true });
    const messages: ChatMessage[] = [o.msg!];
    dropOpening(messages, o);
    dropOpening(messages, o);
    expect(messages).toHaveLength(0);
  });

  it('无指令时（两开关都关）安全空转', () => {
    const o = buildOpening({ grill: false, online: false });
    const messages: ChatMessage[] = [{ role: 'user', content: '历史' }];
    dropOpening(messages, o);
    expect(messages).toHaveLength(1);
  });
});
