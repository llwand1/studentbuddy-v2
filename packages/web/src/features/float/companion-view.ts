import type { DesktopBrowserState, DesktopStudyState } from '@sb/shared';
import { SPRITE } from '../chat/Mascot';

export const COMPANION_SIZE = 64;
export const COMPANION_BODY = 32;
export const HOST_SHAPE = 'sb-float:shape:';
export type CompanionMood = 'idle' | 'focus' | 'preparing' | 'question' | 'reading' | 'retrieving' | 'selecting' | 'waiting' | 'offline' | 'celebrate' | 'encourage' | 'play';
export const COMPANION_LABELS: Record<CompanionMood, string> = {
  idle: '陪你待着', focus: '守着下一次练习', preparing: '正在施法备题', question: '有一道小练习',
  reading: '正在陪你读网页', retrieving: '正在查找网页里的知识', selecting: '正在看你划选的段落',
  waiting: '等你选择共读网页', offline: '连接暂时断开', celebrate: '答对啦，星星送给你',
  encourage: '再试一次，我陪着你', play: '星屑魔法！',
};
export function companionMood(study: DesktopStudyState | null, page: DesktopBrowserState | null, error = ''): CompanionMood {
  if (error) return 'offline';
  if (study?.awaiting) return 'question';
  if (study?.error) return study.settings.scope === 'browser' && !page?.chars ? 'waiting' : 'offline';
  if (study?.preparing) return 'preparing';
  if (page?.connected && page.chars > 0) {
    if (page.retrieving) return 'retrieving';
    return page.selection.trim() ? 'selecting' : 'reading';
  }
  if (page || (study?.settings.enabled && study.settings.scope === 'browser')) return 'waiting';
  return study?.settings.enabled ? 'focus' : 'idle';
}

export type ClipRect = [x: number, y: number, width: number, height: number];
type Particle = { rects: ClipRect[]; tone: 'dust' | 'star' | 'rune' };
const silhouette = SPRITE.flatMap((row, y) => {
  const runs: ClipRect[] = [];
  for (const match of row.matchAll(/[^.]+/g)) runs.push([match.index * 2, y * 2, match[0].length * 2, 2]);
  return runs;
});
/** One integer-pixel frame supplies both SVG paint and the native hit/clip region. */
export function companionFrame(mood: CompanionMood, frame: number, animated = true, hovered = false) {
  const active = ['preparing', 'retrieving', 'celebrate', 'play', 'question'].includes(mood);
  const wave = animated ? Math.sin(frame / (active ? 2.5 : 7)) : 0;
  const x = 16;
  const y = 16 + (animated ? Math.round(wave * (active || hovered ? 2 : 1)) : 0);
  const count = active ? 18 : mood === 'idle' || mood === 'offline' || mood === 'waiting' ? 6 : 12;
  const particles: Particle[] = Array.from({ length: count }, (_, i) => {
    const phase = i * Math.PI * 2 / count + (animated ? frame * (active ? 0.13 : 0.035) : 0);
    const age = ((animated ? frame : 0) + i * 4) % 24 / 24;
    const radius = mood === 'celebrate' || mood === 'play' ? 16 + age * 11
      : mood === 'retrieving' ? 27 - age * 10 : 20 + i % 3 * 3;
    const px = Math.round(32 + Math.cos(phase) * radius);
    const py = mood === 'focus' ? Math.round(54 - age * 41)
      : Math.round(31 + Math.sin(phase) * radius * (mood === 'reading' || mood === 'selecting' ? 0.72 : 1));
    const star = i % 4 === 0;
    const rects: ClipRect[] = star ? [[px, py - 2, 1, 5], [px - 2, py, 5, 1]] : [[px, py, i % 3 === 0 ? 2 : 1, i % 3 === 0 ? 2 : 1]];
    return { rects, tone: star ? 'star' : i % 3 === 0 ? 'rune' : 'dust' };
  });
  const body = silhouette.map(([rx, ry, w, h]): ClipRect => [x + rx, y + ry, w, h]);
  return { x, y, particles, clips: [...body, ...particles.flatMap(p => p.rects)] };
}

