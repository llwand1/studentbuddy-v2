import { describe, it, expect, beforeEach } from 'vitest';
import { publish, subscribe, snapshot, startNewRound } from './sse-bus.js';
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
});
