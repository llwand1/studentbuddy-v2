/**
 * ai/gateway.test — AI 网关的**结果分类、超时、修复、记账**（router 全 mock，零网络零 DB）。
 *
 * 锁的是网关存在的理由：
 *   ① 五种失败分得开（no-model / timeout / aborted / upstream / parse）——调用点据此对用户说真话；
 *   ② 超时真能掐断一个挂住的上游（改前多数调用点没有超时：上游不回就一直挂着）；
 *   ③ 结构化输出坏了会修复一次，截断的不修（再问一次大概率同样被截，白花钱）；
 *   ④ **每一次尝试恰好记一行账**（修复那次也记，成功后改记 parse 不重复记）。
 * ★ 记账走总线：这里订阅 `llm_call` 事件收集，而不是查库——网关本身不许碰库。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TokenChunk } from '../llm/types.js';

const route = vi.hoisted(() => ({ target: null as unknown }));
vi.mock('../llm/router.js', () => ({ routeRole: () => route.target }));

const { aiText, aiJson, startLlmMeter } = await import('./gateway.js');
const { subscribeEvents } = await import('../events/bus.js');
type Rec = import('./gateway.js').LlmCallRecord;

let records: Rec[] = [];
let off: () => void = () => undefined;

function targetWith(chat: (req: { signal?: AbortSignal; messages: unknown[] }) => AsyncIterable<TokenChunk>) {
  return {
    adapter: { type: 'openai' as const, chat, listModels: async () => [] },
    model: 'm1', apiKey: 'k', baseUrl: '', streamMode: 'once' as const, type: 'openai' as const,
    quota: { ownerId: 'u1', platform: true },
  };
}

function says(...texts: string[]) {
  let i = 0;
  return targetWith(async function* () {
    const t = texts[Math.min(i, texts.length - 1)] ?? '';
    i += 1;
    yield { content: t, done: false };
    yield { content: '', done: true, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } };
  });
}

beforeEach(() => {
  records = [];
  off = subscribeEvents((ev) => {
    if (ev.type === 'llm_call') records.push(ev.record);
  });
});
afterEach(() => {
  off();
  vi.useRealTimers();
});

const base = { purpose: 'term.extract' as const, ownerId: 'u1', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('aiText', () => {
  it('成功：拼完整文本、带 usage；记一行 ok（用途、提示词版本、平台通道、token 都在）', async () => {
    route.target = says('你好');
    const r = await aiText(base);
    expect(r.ok && r.text).toBe('你好');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'term.extract', promptVersion: 1, role: 'explain', status: 'ok', platform: true, model: 'm1', usage: { promptTokens: 10, completionTokens: 5 } });
  });

  it('没配模型 ⇒ no-model（不是"可重试"），也记一行', async () => {
    route.target = null;
    const r = await aiText(base);
    expect(!r.ok && r.reason).toBe('no-model');
    expect(records[0]?.status).toBe('no-model');
  });

  it('调用方自带 target 时不再路由；显式传 null ⇒ no-model', async () => {
    route.target = null;
    expect((await aiText({ ...base, target: says('ok') })).ok).toBe(true);
    expect((await aiText({ ...base, target: null })).ok).toBe(false);
  });

  it('上游抛错 ⇒ upstream，错误原文带出来', async () => {
    route.target = targetWith(async function* () {
      yield { content: '半', done: false };
      throw new Error('502 bad gateway');
    });
    const r = await aiText(base);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('upstream');
      expect(r.error).toContain('502');
      expect(r.text).toBe('半'); // 已收到的部分不丢（coach 停止时要落"说了一半的话"）
    }
  });

  it('★ 超时能掐断挂住的上游 ⇒ timeout', async () => {
    route.target = targetWith(async function* (req) {
      await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      yield { content: '', done: true };
    });
    const r = await aiText({ ...base, timeoutMs: 20 });
    expect(!r.ok && r.reason).toBe('timeout');
    expect(records[0]?.status).toBe('timeout');
  });

  it('调用方取消 ⇒ aborted（与超时分开：用户点停止不算模型的错）', async () => {
    const ac = new AbortController();
    route.target = targetWith(async function* (req) {
      ac.abort();
      if (req.signal?.aborted) throw new Error('aborted');
      yield { content: 'x', done: true };
    });
    const r = await aiText({ ...base, signal: ac.signal });
    expect(!r.ok && r.reason).toBe('aborted');
  });

  it('onChunk 逐块回调（流式调用点边收边推）；工具调用带回来', async () => {
    route.target = targetWith(async function* () {
      yield { content: 'a', done: false };
      yield { content: 'b', done: false, toolCalls: [{ id: '1', name: 't', arguments: '{}' }] };
      yield { content: '', done: true };
    });
    const seen: string[] = [];
    const r = await aiText({ ...base, onChunk: (c) => seen.push(c.content) });
    expect(seen.join('')).toBe('ab');
    expect(r.ok && r.toolCalls?.[0]?.name).toBe('t');
  });
});

describe('aiJson', () => {
  const parse = (t: string) => (t.startsWith('{') ? (JSON.parse(t) as { n: number }) : null);

  it('一次就成形 ⇒ value，repaired=false，一行 ok', async () => {
    route.target = says('{"n":1}');
    const r = await aiJson({ ...base, parse });
    expect(r.ok && r.value).toEqual({ n: 1 });
    expect(r.ok && r.repaired).toBe(false);
    expect(records.map((x) => x.status)).toEqual(['ok']);
  });

  it('★ 第一次不成形 ⇒ 带着原输出回喂修复 ⇒ 成功；两行账：parse 然后 ok', async () => {
    const seenMessages: unknown[][] = [];
    let i = 0;
    route.target = targetWith(async function* (req) {
      seenMessages.push(req.messages);
      yield { content: i++ === 0 ? '抱歉我不会' : '{"n":2}', done: true };
    });
    const r = await aiJson({ ...base, parse, repairHint: '只输出 JSON' });
    expect(r.ok && r.value).toEqual({ n: 2 });
    expect(r.ok && r.repaired).toBe(true);
    expect(records.map((x) => [x.status, x.attempt])).toEqual([['parse', 1], ['ok', 2]]);
    const second = seenMessages[1] as Array<{ role: string; content: string }>;
    expect(second[1]).toEqual({ role: 'assistant', content: '抱歉我不会' });
    expect(second[2]?.content).toContain('只输出 JSON');
  });

  it('修复次数用完仍不成形 ⇒ parse 失败，原输出带回给调用方写错因', async () => {
    route.target = says('no', 'still no');
    const r = await aiJson({ ...base, parse });
    expect(!r.ok && r.reason).toBe('parse');
    expect(!r.ok && r.text).toBe('still no');
    expect(records).toHaveLength(2);
  });

  it('★ 被截断（finish_reason=length）不修复：再问一次大概率同样被截', async () => {
    route.target = targetWith(async function* () {
      yield { content: '{"n":', done: true, finishReason: 'length' };
    });
    const r = await aiJson({ ...base, parse: () => null });
    expect(!r.ok && r.reason).toBe('parse');
    expect(records).toHaveLength(1);
  });

  it('解析函数自己抛错也按"不成形"处理，不把异常漏给调用方', async () => {
    route.target = says('{bad', '{"n":3}');
    const r = await aiJson({ ...base, parse: (t) => JSON.parse(t) as { n: number } });
    expect(r.ok && r.value).toEqual({ n: 3 });
  });

  it('上游失败不修复，直接返回分类', async () => {
    route.target = null;
    const r = await aiJson({ ...base, parse });
    expect(!r.ok && r.reason).toBe('no-model');
  });
});

describe('startLlmMeter（流式调用点的计量器）', () => {
  it('记 usage 与结局；幂等：ok 之后再 fail 不多记', () => {
    const m = startLlmMeter('chat.turn', null, { model: 'm', quota: { platform: false } });
    m.see({ content: '', done: true, finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 4 } });
    m.ok();
    m.fail(new Error('late'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'chat.turn', status: 'ok', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 4 } });
  });

  it('用户停止记 aborted，其他异常记 upstream；缺 quota 的目标也不炸', () => {
    startLlmMeter('chat.turn', null, { model: 'm' }).fail(new Error('x'), true);
    startLlmMeter('chat.grill', 'u', { model: 'm' }).fail(new Error('boom'));
    expect(records.map((r) => r.status)).toEqual(['aborted', 'upstream']);
    expect(records[1]?.error).toBe('boom');
  });
});
