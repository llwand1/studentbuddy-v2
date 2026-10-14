import type { DesktopBrowserState, DesktopStudyState } from '@sb/shared';
import { SPRITE } from '../chat/Mascot';
import { companionGlyphs } from './companion-glyphs';

export const COMPANION_SIZE = 64;
export const COMPANION_BODY = 32;
export const HOST_SHAPE = 'sb-float:shape:';
export type CompanionMood = 'idle' | 'focus' | 'preparing' | 'question' | 'reading' | 'retrieving' | 'selecting' | 'waiting' | 'offline' | 'retry' | 'celebrate' | 'encourage' | 'play' | 'dragging';
export const COMPANION_LABELS: Record<CompanionMood, string> = {
  idle: '陪你待着', focus: '守着下一次练习', preparing: '正在施法备题', question: '有一道小练习',
  reading: '正在陪你读网页', retrieving: '正在查找网页里的知识', selecting: '正在看你划选的段落',
  waiting: '等你选择共读网页', offline: '连接暂时断开', retry: '这次备题没成功，稍后再试', celebrate: '答对啦，星星送给你',
  encourage: '再试一次，我陪着你', play: '暗黑魔法！', dragging: '火焰随行',
};
export function companionMood(study: DesktopStudyState | null, page: DesktopBrowserState | null, error = ''): CompanionMood {
  if (error) return 'offline';
  if (study?.awaiting) return 'question';
  if (study?.error) return study.settings.scope === 'bilibili' || study.settings.scope === 'browser' && !page?.chars ? 'waiting' : 'retry';
  if (study?.preparing) return 'preparing';
  if (page?.connected && page.chars > 0) {
    if (page.retrieving) return 'retrieving';
    return page.selection.trim() ? 'selecting' : 'reading';
  }
  if (page || (study?.settings.enabled && study.settings.scope === 'browser')) return 'waiting';
  return study?.settings.enabled ? 'focus' : 'idle';
}

export type ClipRect = [x: number, y: number, width: number, height: number];
export type SpellSchool = 'hex' | 'soul' | 'rift' | 'ember' | 'omen' | 'nova';
type Particle = { rects: ClipRect[]; tone: 'dust' | 'star' | 'rune' | 'secondary' };
type BookLayer = { rects: ClipRect[]; tone: 'cover' | 'page' | 'spine' | 'ink' | 'clasp' };
const silhouette = SPRITE.flatMap((row, y) => {
  const runs: ClipRect[] = [];
  for (const match of row.matchAll(/[^.]+/g)) runs.push([match.index * 2, y * 2, match[0].length * 2, 2]);
  return runs;
});
/** Union painted pixels into row runs so overlapping spell layers do not inflate the native Region. */
function clipUnion(rects: ClipRect[]): ClipRect[] {
  const pixels = new Uint8Array(COMPANION_SIZE * COMPANION_SIZE);
  for (const [x, y, w, h] of rects) for (let row = y; row < y + h; row++) pixels.fill(1, row * 64 + x, row * 64 + x + w);
  const runs: ClipRect[] = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    if (!pixels[y * 64 + x]) continue;
    const start = x;
    while (x + 1 < 64 && pixels[y * 64 + x + 1]) x++;
    runs.push([start, y, x - start + 1, 1]);
  }
  return runs;
}
/** One integer-pixel frame supplies both SVG paint and the native hit/clip region. */
export function companionFrame(mood: CompanionMood, frame: number, animated = true, hovered = false, cast?: SpellSchool) {
  const school: SpellSchool = mood === 'play' ? cast ?? 'hex' : mood === 'preparing' ? 'hex'
    : mood === 'retrieving' ? 'rift' : mood === 'question' ? 'omen' : mood === 'celebrate' ? 'nova'
    : ['reading', 'selecting', 'encourage'].includes(mood) ? 'soul' : 'ember';
  const tick = animated ? frame : 0;
  const active = ['preparing', 'retrieving', 'celebrate', 'play', 'question', 'dragging'].includes(mood);
  const wave = animated ? Math.sin(frame / (active ? 2.5 : 7)) : 0;
  const x = 16;
  const y = 16 + (animated ? Math.round(wave * (active || hovered ? 2 : 1)) : 0);
  const count = mood === 'dragging' ? 10 : active ? 24 : ['idle', 'offline', 'waiting', 'retry'].includes(mood) && !hovered ? 10 : 16;
  const rect = (rx: number, ry: number, w = 2, h = 2): ClipRect => [
    Math.max(1, Math.min(63 - w, Math.round(rx))), Math.max(1, Math.min(63 - h, Math.round(ry))), w, h];
  const particles: Particle[] = Array.from({ length: count }, (_, i) => {
    const phase = i * Math.PI * 2 / count + tick * (active ? 0.13 : 0.035);
    const age = (tick + i * 5) % 24 / 24;
    const radius = school === 'nova' ? 15 + age * 13 : school === 'rift' ? 28 - age * 14 : 21 + i % 3 * 3;
    const px = school === 'ember' ? 12 + i % 3 * 18 + Math.sin(phase) * 5 : 32 + Math.cos(phase) * radius;
    const py = school === 'ember' ? 59 - age * 46 : 31 + Math.sin(phase) * radius * (school === 'soul' ? .65 : 1);
    let rects: ClipRect[];
    if (school === 'ember') rects = [rect(px, py, 3, 4), rect(px + 1, py - 3, 1, 3)];
    else if (school === 'soul') rects = [rect(px, py, 3, 2), rect(px - Math.cos(phase) * 4, py - Math.sin(phase) * 3, 2, 1)];
    else if (school === 'rift') rects = [rect(px, py, 3, 2), rect(px + 2, py - 2, 1, 3)];
    else if (school === 'hex') rects = [rect(px, py - 2, 1, 5), rect(px, py + 2, 4, 1)];
    else rects = [rect(px, py - 2, 1, 5), rect(px - 2, py, 5, 1)];
    return { rects, tone: i % 5 === 0 ? 'star' : i % 3 === 0 ? 'secondary' : i % 2 === 0 ? 'rune' : 'dust' };
  });
  const sigil: ClipRect[] = [];
  const line = (ax: number, ay: number, bx: number, by: number, steps = 8) => {
    for (let n = 0; n <= steps; n++) sigil.push(rect(ax + (bx - ax) * n / steps, ay + (by - ay) * n / steps));
  };
  if (active) {
    const rotation = tick * .035;
    if (school === 'hex') {
      const point = (i: number): [number, number] => {
        const angle = rotation - Math.PI / 2 + i * Math.PI * 2 / 5;
        return [32 + Math.cos(angle) * 25, 31 + Math.sin(angle) * 25];
      };
      for (let i = 0; i < 5; i++) { const a = point(i); const b = point((i + 2) % 5); line(a[0], a[1], b[0], b[1]); }
      for (let i = 0; i < 20; i++) { const a = rotation + i * Math.PI / 10; sigil.push(rect(32 + Math.cos(a) * 28, 31 + Math.sin(a) * 28)); }
    } else if (school === 'rift') {
      for (let i = 0; i < 28; i++) { const a = -rotation + i * Math.PI / 14; sigil.push(rect(32 + Math.cos(a) * (19 + i % 2 * 5), 31 + Math.sin(a) * 27)); }
    } else if (school === 'soul') {
      for (let i = 0; i < 16; i++) { const px = 5 + i * 3.3; sigil.push(rect(px, 42 + Math.sin(i / 3 + rotation) * 7, 3, 1), rect(px, 20 - Math.sin(i / 3 + rotation) * 7, 2, 1)); }
    } else if (school === 'omen') {
      for (const side of [-1, 1]) for (let i = 0; i < 4; i++) line(32 + side * (19 + i % 2 * 6), 9 + i * 11, 32 + side * (19 + (i + 1) % 2 * 6), 20 + i * 11, 4);
    } else if (school === 'nova') {
      for (let i = 0; i < 20; i++) { const a = i * Math.PI / 10; const radius = 10 + (tick % 20) * .9; sigil.push(rect(32 + Math.cos(a) * radius, 31 + Math.sin(a) * radius), rect(32 + Math.cos(a) * 28, 31 + Math.sin(a) * 28, 1, 3)); }
    }
  }
  // A continuous projected seal below the feet reads as a magic circle at the actual 64px size.
  const circle: ClipRect[] = [];
  const mark = (px: number, py: number) => circle.push(rect(px, py, 1, 1));
  for (const [rx, ry] of [[28, 9], [23, 6]] as const) for (let i = 0; i < 180; i++) {
    const a = i * Math.PI / 90;
    mark(32 + Math.cos(a) * rx, 52 + Math.sin(a) * ry);
  }
  const rotation = tick * (active ? .055 : .018);
  const point = (i: number): [number, number] => [32 + Math.cos(rotation + i * Math.PI * 2 / 5) * 20, 52 + Math.sin(rotation + i * Math.PI * 2 / 5) * 5];
  for (let i = 0; i < 5; i++) {
    const a = point(i), b = point((i + 2) % 5);
    const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])));
    for (let n = 0; n <= steps; n++) mark(a[0] + (b[0] - a[0]) * n / steps, a[1] + (b[1] - a[1]) * n / steps);
  }
  for (const px of [8, 54]) circle.push(rect(px, 50, 1, 4), rect(px - 1, 52, 3, 1));
  // A real miniature grimoire: dark cover, gold binding, ivory pages and a turning leaf.
  const bookOpen = !['idle', 'focus', 'waiting', 'offline', 'retry', 'dragging'].includes(mood);
  const bx = 47, by = 29 + (animated ? Math.round(Math.sin(tick / 5) * 2) : 0);
  const book: BookLayer[] = bookOpen ? [
    { tone: 'cover', rects: [rect(bx, by + 2, 15, 10), rect(bx + 1, by + 12, 13, 1)] },
    { tone: 'page', rects: [rect(bx + 1, by, 6, 10), rect(bx + 8, by, 6, 10), rect(bx + 2, by + 10, 4, 1), rect(bx + 9, by + 10, 4, 1)] },
    { tone: 'spine', rects: [rect(bx + 7, by + 1, 1, 11)] },
    { tone: 'ink', rects: [rect(bx + 2, by + 3, 4, 1), rect(bx + 3, by + 5, 3, 1), rect(bx + 9, by + 3, 4, 1), rect(bx + 9, by + 6, 3, 1)] },
    { tone: 'clasp', rects: [rect(bx, by + 10, 1, 2), rect(bx + 14, by + 10, 1, 2)] },
  ] : [
    { tone: 'cover', rects: [rect(bx + 2, by, 11, 13)] },
    { tone: 'page', rects: [rect(bx + 4, by + 11, 9, 1)] },
    { tone: 'spine', rects: [rect(bx + 2, by, 2, 13)] },
    { tone: 'clasp', rects: [rect(bx + 5, by + 2, 6, 1), rect(bx + 5, by + 8, 6, 1), rect(bx + 7, by + 4, 2, 3), rect(bx + 6, by + 5, 4, 1)] },
  ];
  if (bookOpen && animated) {
    const leaf = tick % 12;
    if (leaf < 6) book.push({ tone: 'page', rects: [rect(bx + 7 - leaf, by - 1, 1 + Math.min(leaf, 3), 8)] });
  }
  const glyphs=companionGlyphs(mood,tick);
  const halo = [...sigil, ...particles.flatMap(p => p.rects),...glyphs.flatMap(p=>p.rects)].map(([rx, ry, w, h]): ClipRect => [rx - 1, ry - 1, w + 2, h + 2]);
  const body = silhouette.map(([rx, ry, w, h]): ClipRect => [x + rx, y + ry, w, h]);
  const circleOutline = clipUnion(circle);
  return { x, y, school, particles, sigil, halo, circle: circleOutline, book, bookOpen,glyphs,
    clips: clipUnion([...body, ...halo, ...sigil, ...particles.flatMap(p => p.rects), ...circleOutline, ...book.flatMap(p => p.rects),...glyphs.flatMap(p=>p.rects)]) };
}

