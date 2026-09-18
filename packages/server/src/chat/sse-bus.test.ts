import { describe, it, expect, beforeEach, vi } from 'vitest';
import { publish, subscribe, snapshot, startNewRound, startHeartbeat } from './sse-bus.js';
import type { SseEvent } from '@sb/shared';

/** 最小 Response 桩：收集写入的 SSE 帧 */
function fakeRes() {
  const frames: string[] = [];
  return {
    frames,
    writableEnded: false,
    destroyed: false,
    writeHead: () => {},
    write: (s: string) => frames.push(s),
    on: () => {},
  } as unknown as import('express').Response & { frames: string[] };
}

function parse(frame: string): SseEvent {
  return JSON.parse(frame.replace(/^data: /, '').trim());
}

describe('sse-bus — 按 sessionId 隔离广播（v1 串台防护回归）', () => {
  beforeEach(() => {
    startNewRound('s1');
    startNewRound('s2');
  });

  it('两会话并发订阅，各自只收自己会话的事件', () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    subscribe('s1', r1);
    subscribe('s2', r2);
    publish('s1', { type: 'token', sessionId: 's1', content: '甲' });
    publish('s2', { type: 'token', sessionId: 's2', content: '乙' });

    const e1 = r1.frames.map(parse).filter((e) => e.type === 'token');
    const e2 = r2.frames.map(parse).filter((e) => e.type === 'token');
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ type: 'token', content: '甲' });
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ type: 'token', content: '乙' });
  });

  it('seq 按会话独立单调递增；since 只补齐错过的事件', () => {
    fakeRes();
    publish('s1', { type: 'token', sessionId: 's1', content: 'a' });
    const seqA = publish('s1', { type: 'token', sessionId: 's1', content: 'b' });
    expect(seqA).toBe(2);

    const r2 = fakeRes();
    subscribe('s1', r2, 1); // 只回放 seq > 1
    const tokens = r2.frames.map(parse).filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ content: 'b' });
  });

  it('新一轮对话 seq 从 1 重新计数，快照清空', () => {
    publish('s1', { type: 'token', sessionId: 's1', content: 'old' });
    startNewRound('s1');
    expect(snapshot('s1')).toHaveLength(0);
    expect(publish('s1', { type: 'token', sessionId: 's1', content: 'new' })).toBe(1);
  });

  it('已完结的一轮：新订阅只补 done，不重放正文与 step（真机重复气泡回归）', () => {
    publish('s1', { type: 'token', sessionId: 's1', content: '已落库的正文' });
    publish('s1', { type: 'step', sessionId: 's1', tool: 'search_web', status: 'running', detail: 'q' });
    publish('s1', { type: 'done', sessionId: 's1', usage: { promptTokens: 1, completionTokens: 2, source: 'provider' } });

    const fresh = fakeRes();
    subscribe('s1', fresh);
    const evs = fresh.frames.map(parse);
    expect(evs.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(evs.filter((e) => e.type === 'step')).toHaveLength(0);
    expect(evs.some((e) => e.type === 'done')).toBe(true);
  });

  it('进行中的一轮：新订阅仍全量回放，切回会话不丢已生成的字', () => {
    publish('s1', { type: 'token', sessionId: 's1', content: '半句' });
    const mid = fakeRes();
    subscribe('s1', mid);
    const tokens = mid.frames.map(parse).filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ content: '半句' });
  });

  it('★ 陈旧 since 重连不被饿死（B-007）：带上一轮的 since 订阅，新一轮的帧仍全部送达', () => {
    // 场景：上一轮 seq 已到 101；`startNewRound` 清缓冲后 seq 从 1 重计；
    // 客户端带着**上一轮的** since=101 重连。若照单全收这个 since，`publish` 里
    // `full.seq > c.since` 恒不成立 ⇒ 整轮（含 done）一条都发不出去 ⇒ 前端永久卡在「生成中」。
    publish('s1', { type: 'token', sessionId: 's1', content: '上一轮' });
    startNewRound('s1');

    const stale = fakeRes();
    subscribe('s1', stale, 101);
    publish('s1', { type: 'token', sessionId: 's1', content: '这一轮' });
    publish('s1', { type: 'done', sessionId: 's1' });

    const evs = stale.frames.map(parse);
    expect(evs.filter((e) => e.type === 'token').map((e) => e.content)).toEqual(['这一轮']);
    expect(evs.some((e) => e.type === 'done')).toBe(true);
  });

  it('不越界：since 未超过本轮已产出的 seq 时，回放口径一字不变（只补错过的）', () => {
    publish('s1', { type: 'token', sessionId: 's1', content: 'a' });
    publish('s1', { type: 'token', sessionId: 's1', content: 'b' });

    const r = fakeRes();
    subscribe('s1', r, 1); // 1 未超过本轮最大 seq(2) ⇒ 仍按原意只回放 seq > 1
    const tokens = r.frames.map(parse).filter((e) => e.type === 'token');
    expect(tokens.map((e) => e.content)).toEqual(['b']);
  });
});

describe('sse-bus — 缓冲 TTL 回收（buffers 泄漏回归，原版 now % TTL 闸门永不触发）', () => {
  it('无订阅者且超 TTL 的缓冲被心跳回收；有订阅者的不回收', async () => {
    vi.useFakeTimers();
    try {
      startNewRound('ttl-a');
      startNewRound('ttl-b');
      publish('ttl-a', { type: 'token', sessionId: 'ttl-a', content: 'x' });
      publish('ttl-b', { type: 'token', sessionId: 'ttl-b', content: 'y' });

      const r = fakeRes();
      subscribe('ttl-a', r); // ttl-a 有订阅者

      const hb = startHeartbeat();
      // 快进 80s：跨过多个 15s 心跳周期（60s 心跳时差值恰为 TTL 不满足 >，75s 心跳时才回收）
      vi.advanceTimersByTime(80_000);

      // ttl-a 仍可正常发布（缓冲未被回收）
      expect(publish('ttl-a', { type: 'token', sessionId: 'ttl-a', content: 'z' })).toBeGreaterThan(0);
      // ttl-b 无订阅者且超时：缓冲应已被回收（快照为空说明 Map 条目已删或 events 清空——
      // 直接验证 Map 回收需要导出内部状态，这里以"再次订阅无旧事件回放"作为外部可见行为）
      const late = fakeRes();
      subscribe('ttl-b', late);
      expect(late.frames.map(parse).filter((e) => e.type === 'token')).toHaveLength(0);
      clearInterval(hb);
    } finally {
      vi.useRealTimers();
    }
  });
});
