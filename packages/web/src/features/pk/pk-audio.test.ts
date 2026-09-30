// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PkAudio, loadPkSound, savePkSound } from './pk-audio';

function param() {
  return { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
}
function audioNode() {
  return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: param(), frequency: param(), type: '' };
}
function fakeContext() {
  const ctx = {
    currentTime: 0, state: 'suspended' as AudioContextState, destination: {},
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    createGain: vi.fn(audioNode), createOscillator: vi.fn(audioNode),
  };
  return ctx;
}

afterEach(() => localStorage.clear());

describe('PkAudio', () => {
  it('按需建上下文，各类关键音效都用有界短音符合成', () => {
    const ctx = fakeContext();
    const audio = new PkAudio(() => ctx as unknown as AudioContext);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    for (const sound of ['question', 'correct', 'wrong', 'timeout', 'combo'] as const) audio.play(sound);
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.createOscillator.mock.calls.length).toBe(11);
    for (const { value } of ctx.createOscillator.mock.results) {
      expect((value as ReturnType<typeof audioNode>).start).toHaveBeenCalled();
      expect((value as ReturnType<typeof audioNode>).stop).toHaveBeenCalled();
    }
    audio.dispose();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('静音不创建音频节点，恢复有声时淡入主增益', () => {
    const ctx = fakeContext();
    const audio = new PkAudio(() => ctx as unknown as AudioContext, true);
    audio.play('correct');
    expect(ctx.createGain).not.toHaveBeenCalled();
    audio.setMuted(false);
    audio.play('correct');
    audio.setMuted(true);
    audio.setMuted(false);
    expect(ctx.createGain).toHaveBeenCalledTimes(3); // 主增益 + 两个音符包络
    expect(ctx.createGain.mock.results[0]?.value.gain.setTargetAtTime).toHaveBeenCalledWith(1, 0, 0.02);
  });

  it('无 Web Audio 环境静默降级；音效偏好按本机保存', () => {
    const audio = new PkAudio(() => null);
    expect(() => audio.play('question')).not.toThrow();
    expect(loadPkSound()).toBe(true);
    savePkSound(false);
    expect(loadPkSound()).toBe(false);
    savePkSound(true);
    expect(loadPkSound()).toBe(true);
  });
});
