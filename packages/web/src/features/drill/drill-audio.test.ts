// @vitest-environment jsdom
/**
 * drill-audio 单测：jsdom 没有 Web Audio，注入桩上下文，钉四条口径——
 * 配乐用前瞻调度器（start 起表 / stop 清表且幂等）、静音是主增益归零而非停调度、
 * 静音时音效不建节点、没有 AudioContext 的环境一切静默不抛。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DrillAudio } from './drill-audio';

function param() {
  return {
    value: 1,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: param(), frequency: param(), type: '', buffer: null };
}

function fakeContext() {
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    state: 'suspended' as AudioContextState,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    suspend: vi.fn(async () => {
      ctx.state = 'suspended';
    }),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    createGain: vi.fn(node),
    createOscillator: vi.fn(node),
    createBufferSource: vi.fn(node),
    createBiquadFilter: vi.fn(node),
    createBuffer: vi.fn((_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) })),
  };
  return ctx;
}

describe('DrillAudio', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start：建上下文 + resume + 起调度器；stop 清表并挂起；两者都幂等', () => {
    const ctx = fakeContext();
    const a = new DrillAudio(() => ctx as unknown as AudioContext);
    expect(a.playing).toBe(false);
    a.start();
    a.start();
    expect(a.playing).toBe(true);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    const before = ctx.createOscillator.mock.calls.length;
    expect(before).toBeGreaterThan(0); // 前瞻窗口里的第一拍已排入
    ctx.currentTime += 0.5;
    vi.advanceTimersByTime(100);
    expect(ctx.createOscillator.mock.calls.length).toBeGreaterThan(before); // 时间推进 ⇒ 继续排音符
    a.stop();
    a.stop();
    expect(a.playing).toBe(false);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    const after = ctx.createOscillator.mock.calls.length;
    ctx.currentTime += 5;
    vi.advanceTimersByTime(1000);
    expect(ctx.createOscillator.mock.calls.length).toBe(after); // 停了就不再排
  });

  it('静音 = 主增益归零（调度器不停，切回有声还在拍上）；静音时音效不建节点', () => {
    const ctx = fakeContext();
    const a = new DrillAudio(() => ctx as unknown as AudioContext, true);
    expect(a.muted).toBe(true);
    a.play('correct');
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    a.start();
    expect(a.playing).toBe(true);
    const master = ctx.createGain.mock.results[0]?.value as ReturnType<typeof node>;
    expect(master.gain.value).toBe(0);
    a.setMuted(false);
    expect(a.muted).toBe(false);
    expect(master.gain.setTargetAtTime).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Number));
    expect(a.playing).toBe(true);
    const n = ctx.createOscillator.mock.calls.length;
    a.play('combo');
    expect(ctx.createOscillator.mock.calls.length).toBe(n + 4);
  });

  it('八款音效每款都能出声（有节点、都 start/stop）', () => {
    const ctx = fakeContext();
    const a = new DrillAudio(() => ctx as unknown as AudioContext);
    for (const sfx of ['correct', 'wrong', 'slash', 'flip', 'combo', 'new', 'ready', 'keep'] as const) {
      const before = ctx.createOscillator.mock.calls.length + ctx.createBufferSource.mock.calls.length;
      a.play(sfx);
      expect(ctx.createOscillator.mock.calls.length + ctx.createBufferSource.mock.calls.length).toBeGreaterThan(before);
    }
    for (const r of ctx.createOscillator.mock.results) {
      const osc = r.value as ReturnType<typeof node>;
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    }
  });

  it('dispose：停表 + close；没有 AudioContext 的环境所有调用静默', () => {
    const ctx = fakeContext();
    const a = new DrillAudio(() => ctx as unknown as AudioContext);
    a.start();
    a.dispose();
    expect(a.playing).toBe(false);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    const b = new DrillAudio(() => null);
    expect(() => {
      b.start();
      b.play('ready');
      b.setMuted(true);
      b.resume();
      b.stop();
      b.dispose();
    }).not.toThrow();
    expect(b.playing).toBe(false);
  });
});
