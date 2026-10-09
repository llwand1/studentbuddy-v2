export type AnswerVerdict = 'correct' | 'wrong' | 'review' | 'partial' | 'complete';
const KEY = 'sb:answer:sound';
const EVENT = 'sb:answer-sound';
let fallback: boolean | null = null;
let context: AudioContext | null = null;
export function answerSoundEnabled(): boolean {
  if (fallback !== null) return fallback;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function subscribeAnswerSound(listener: () => void): () => void {
  const onStorage = () => { fallback = null; listener(); };
  window.addEventListener(EVENT, listener); window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', onStorage); };
}
function audio(): AudioContext | null {
  if (typeof window.AudioContext !== 'function') return null;
  try {
    if (!context || context.state === 'closed') {
      context = new window.AudioContext();
      window.addEventListener('pagehide', () => { void context?.close(); context = null; }, { once: true });
    }
    return context;
  } catch { return null; }
}
export function toggleAnswerSound(): void {
  fallback = !answerSoundEnabled();
  try { localStorage.setItem(KEY, fallback ? '1' : '0'); } catch { /* Current-session preference still works. */ }
  if (fallback) { try { void audio()?.resume().catch(() => undefined); } catch { /* Audio is optional. */ } }
  window.dispatchEvent(new Event(EVENT));
}
/** Short synthesized impacts, only after an explicit sound opt-in. No network or scoring work. */
export function playAnswerSound(verdict: AnswerVerdict): void {
  if (!answerSoundEnabled() || document.hidden) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  const tones = verdict === 'wrong' ? [150, 95] : verdict === 'correct' ? [523, 784]
    : verdict === 'complete' ? [523, 659, 1047] : verdict === 'partial' ? [392, 523] : [392];
  try {
    tones.forEach((frequency, i) => {
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      const t = ctx.currentTime + i * .09;
      oscillator.type = verdict === 'wrong' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, t);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * .8, t + .18);
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(.035, t + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, t + .24);
      oscillator.connect(gain); gain.connect(ctx.destination);
      oscillator.start(t); oscillator.stop(t + .26);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  } catch { /* Browser audio restrictions never interrupt an answer. */ }
}
