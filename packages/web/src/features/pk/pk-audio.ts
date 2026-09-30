/**
 * pk-audio — 对战关键事件的短音效，Web Audio 现场合成、零素材文件。
 *
 * 对战只做事件音效、不铺背景音乐：答题的专注感优先，且音效只在题目到达、判分、连击等真实事件上出现。
 * AudioContext 按需创建；自动播放策略拒绝时静默，用户点音效开关或答题后还可再次 resume。
 */
export type PkSfx = 'question' | 'correct' | 'wrong' | 'timeout' | 'combo';
export type PkAudioFactory = () => AudioContext | null;

function defaultFactory(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

const midiHz = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

export class PkAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  constructor(private readonly factory: PkAudioFactory = defaultFactory, private muted = false) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  play(sfx: PkSfx): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const t = ctx.currentTime + 0.008;
    const tone = (frequency: number, offset: number, duration: number, type: OscillatorType, end?: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = t + offset;
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, start);
      if (end !== undefined) osc.frequency.exponentialRampToValueAtTime(end, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    };
    switch (sfx) {
      case 'question':
        tone(midiHz(76), 0, 0.09, 'triangle');
        tone(midiHz(83), 0.085, 0.13, 'triangle');
        return;
      case 'correct':
        tone(midiHz(76), 0, 0.1, 'square');
        tone(midiHz(81), 0.08, 0.14, 'triangle');
        return;
      case 'wrong':
        tone(220, 0, 0.18, 'sawtooth', 110);
        return;
      case 'timeout':
        tone(440, 0, 0.1, 'triangle');
        tone(330, 0.13, 0.16, 'triangle');
        return;
      case 'combo':
        [76, 81, 85, 88].forEach((note, i) => tone(midiHz(note), i * 0.065, 0.11, 'square'));
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = this.factory();
    if (!ctx) return null;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);
    return ctx;
  }
}

const SOUND_KEY = 'sb:pk:sound';

/** 对战音效开关只属于本机；存储不可用时仍可在当前页面切换。 */
export function loadPkSound(): boolean {
  try {
    const value = typeof window === 'undefined' ? null : window.localStorage.getItem(SOUND_KEY);
    return value !== 'off';
  } catch {
    return true;
  }
}

export function savePkSound(enabled: boolean): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
  } catch {
    /* 隐私模式或配额满：只保留本次页面选择 */
  }
}
