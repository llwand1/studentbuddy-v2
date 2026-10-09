/**
 * drill-audio — 「等待时刷词」的 8-bit 配乐与音效，**全部用 Web Audio 现场合成**（零音频文件、零联网）。
 *
 * ★ 为什么合成而不是放 mp3：仓库对外承诺 0 个第三方 UI 库、静态产物里没有二进制素材；一段 8 小节的
 *   芯片音乐用方波 / 三角波 / 噪声就能写出来，体积是几十行数组，改一个音符是一次 diff 而不是重新导出文件。
 * ★ 配乐：A 小调、132 BPM、8 小节循环——低音（三角波）+ 主旋律（方波）+ 琶音（方波、低音量）+ 鼓组
 *   （正弦下扫当底鼓、带通噪声当军鼓、高通噪声当踩镲）。用「前瞻调度」（lookahead 120ms、每 25ms 排一次）
 *   而不是 setTimeout 逐音符触发：后者在标签页失焦时会乱拍。
 * ★ 音效八款（答对 / 答错 / 斩 / 收录 / 翻卡 / 连击 / 新词 / 回复到了），使用短促的芯片音。
 * ★ 浏览器自动播放策略：`AudioContext` 只在 `start()` 时创建并 `resume()`；发送消息那一下点击已给页面
 *   "用户激活"，多数浏览器允许随后出声；被拒时静默（`state` 仍是 suspended），首个点击选项时再 resume 一次。
 * ★ 静音是**主增益归零**而不是停调度：这样切回有声时音乐正好在拍上，不会从头开始。
 * ★ 可测：构造函数接受 `AudioContext` 工厂；jsdom 没有 Web Audio，单测注入桩。
 */

export type DrillSfx = 'correct' | 'wrong' | 'slash' | 'flip' | 'combo' | 'new' | 'ready' | 'keep';

const BPM = 132;
const STEP = 60 / BPM / 4;
const STEPS_PER_BAR = 16;
const BARS = 8;
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

const BGM_GAIN = 0.55;
const SFX_GAIN = 1;

/** 每小节的和弦根音（MIDI）与大小三度：Am | F | G | Am | Am | F | G | E */
const CHORDS: ReadonlyArray<{ root: number; third: number }> = [
  { root: 45, third: 3 },
  { root: 41, third: 4 },
  { root: 43, third: 4 },
  { root: 45, third: 3 },
  { root: 45, third: 3 },
  { root: 41, third: 4 },
  { root: 43, third: 4 },
  { root: 40, third: 4 },
];

/** 低音：每小节 8 个八分音符，相对根音的半音偏移 */
const BASS_PATTERN: readonly number[] = [0, 0, 7, 0, 12, 7, 0, 7];

/** 主旋律：[小节内起始步, MIDI, 时值（步）]，按小节分组 */
const LEAD: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[0, 69, 2], [2, 72, 2], [4, 76, 4], [8, 74, 2], [10, 72, 2], [12, 69, 4]],
  [[0, 72, 2], [2, 74, 2], [4, 72, 2], [6, 69, 4], [10, 67, 2], [12, 69, 4]],
  [[0, 67, 2], [2, 71, 2], [4, 74, 4], [8, 76, 2], [10, 74, 2], [12, 71, 4]],
  [[0, 69, 6], [8, 64, 2], [10, 67, 2], [12, 69, 4]],
  [[0, 76, 2], [2, 76, 2], [4, 79, 2], [6, 76, 2], [8, 74, 2], [10, 72, 2], [12, 74, 4]],
  [[0, 72, 2], [2, 69, 2], [4, 72, 4], [8, 74, 2], [10, 76, 2], [12, 72, 4]],
  [[0, 74, 2], [2, 71, 2], [4, 67, 4], [8, 71, 2], [10, 74, 2], [12, 79, 4]],
  [[0, 76, 4], [4, 74, 2], [6, 71, 2], [8, 68, 4], [12, 64, 4]],
];

const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export type ContextFactory = () => AudioContext | null;

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

export class DrillAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgm: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  private mutedFlag: boolean;

  constructor(
    private readonly factory: ContextFactory = defaultFactory,
    muted = false,
  ) {
    this.mutedFlag = muted;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  /** 配乐在放吗（调度器活着） */
  get playing(): boolean {
    return this.timer !== null;
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = this.factory();
    if (!ctx) return null;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.mutedFlag ? 0 : 1;
    this.master.connect(ctx.destination);
    this.bgm = ctx.createGain();
    this.bgm.gain.value = BGM_GAIN;
    this.bgm.connect(this.master);
    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /** 尝试解除挂起（自动播放策略）；失败静默 */
  resume(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  setMuted(m: boolean): void {
    this.mutedFlag = m;
    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  /** 开始配乐（幂等） */
  start(): void {
    const ctx = this.ensure();
    if (!ctx || this.timer !== null) return;
    this.resume();
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.05;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  /** 停配乐：停调度器 + 挂起上下文（已排入前瞻窗口的那一两个音符自然收尾） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  /** 彻底释放（弹窗卸载时） */
  dispose(): void {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.bgm = null;
    this.noise = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      this.playStep(this.step, this.nextTime);
      this.step = (this.step + 1) % (STEPS_PER_BAR * BARS);
      this.nextTime += STEP;
    }
  }

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const i = step % STEPS_PER_BAR;
    const chord = CHORDS[bar] ?? { root: 45, third: 3 };
    if (i % 2 === 0) {
      const off = BASS_PATTERN[i / 2] ?? 0;
      this.tone(this.bgm, 'triangle', midiHz(chord.root + off), t, STEP * 1.6, 0.22);
    }
    for (const [at, midi, len] of LEAD[bar] ?? []) {
      if (at === i) this.tone(this.bgm, 'square', midiHz(midi), t, STEP * len * 0.92, 0.075);
    }
    const arp = [0, chord.third, 7, 12][i % 4] ?? 0;
    this.tone(this.bgm, 'square', midiHz(chord.root + 24 + arp), t, STEP * 0.7, 0.03);
    if (i === 0 || i === 8) this.tone(this.bgm, 'sine', 150, t, 0.09, 0.5, 45);
    if (i === 4 || i === 12) this.burst(this.bgm, t, 0.1, 0.18, 'bandpass', 1800);
    if (i % 2 === 0) this.burst(this.bgm, t, 0.03, i % 4 === 2 ? 0.07 : 0.035, 'highpass', 7000);
  }

  private tone(
    out: AudioNode | null,
    type: OscillatorType,
    freq: number,
    t: number,
    dur: number,
    gain: number,
    endFreq?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private burst(out: AudioNode | null, t: number, dur: number, gain: number, kind: BiquadFilterType, hz: number, endHz?: number): void {
    const ctx = this.ctx;
    if (!ctx || !out || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.setValueAtTime(hz, t);
    if (endHz !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** 放一个音效；静音或没上下文时什么都不做 */
  play(sfx: DrillSfx): void {
    const ctx = this.ensure();
    if (!ctx || this.mutedFlag) return;
    this.resume();
    const out = this.master;
    const t = ctx.currentTime + 0.005;
    const s = SFX_GAIN;
    switch (sfx) {
      case 'correct':
        this.tone(out, 'square', 659, t, 0.06, 0.16 * s);
        this.tone(out, 'square', 880, t + 0.06, 0.1, 0.16 * s);
        return;
      case 'wrong':
        this.tone(out, 'sawtooth', 160, t, 0.22, 0.12 * s, 90);
        this.burst(out, t, 0.12, 0.08 * s, 'lowpass', 600);
        return;
      case 'slash':
        this.burst(out, t, 0.18, 0.22 * s, 'highpass', 4000, 300);
        this.tone(out, 'square', 1200, t, 0.09, 0.1 * s, 300);
        return;
      case 'flip':
        this.tone(out, 'triangle', 900, t, 0.035, 0.07 * s);
        return;
      case 'keep':
        [523, 659, 1047].forEach((hz, k) => this.tone(out, 'triangle', hz, t + k * 0.07, 0.11, 0.11 * s));
        this.tone(out, 'sine', 262, t + 0.18, 0.1, 0.08 * s);
        return;
      case 'combo':
        [440, 523, 659, 880].forEach((hz, k) => this.tone(out, 'square', hz, t + k * 0.07, 0.09, 0.15 * s));
        return;
      case 'new':
        [1568, 2093, 2637].forEach((hz, k) => this.tone(out, 'sine', hz, t + k * 0.06, 0.14, 0.09 * s));
        return;
      case 'ready':
        [1047, 1319, 1568].forEach((hz, k) => this.tone(out, 'triangle', hz, t + k * 0.12, 0.2, 0.13 * s));
        return;
    }
  }
}
