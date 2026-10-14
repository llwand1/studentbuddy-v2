import { DEFAULT_DESKTOP_STUDY, parseDesktopStudySettings, type DesktopStudySettings } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { generateCampfireOpener } from '../learning/campfire-opener.js';
import { browserStore } from './browser-store.js';
import { StudyClock } from './study-clock.js';
import { createHash } from 'node:crypto';
import { connection } from '../plugins/store.js';
import { bilibiliMaterial, loadBilibiliVideo } from '../plugins/bilibili-material.js';
const KEY = 'desktop.study';
const clocks = new Map<string, StudyClock>();
function load(owner: string | null): DesktopStudySettings {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?').get(ownerForWrite(owner), KEY) as { value: string } | undefined;
  try { return parseDesktopStudySettings(JSON.parse(row?.value ?? 'null')) ?? { ...DEFAULT_DESKTOP_STUDY }; } catch { return { ...DEFAULT_DESKTOP_STUDY }; }
}
export function studyClock(owner: string | null): StudyClock {
  const key = ownerForWrite(owner);
  let clock = clocks.get(key);
  if (clock) return clock;
  const settings = load(owner);
  clock = new StudyClock(settings, async (exclude, signal) => {
    const scope = studyClock(owner).state().settings.scope, browser = scope === 'browser';
    const video = scope === 'bilibili' && connection(owner,'bilibili').enabled ? loadBilibiliVideo(owner) : null;
    const material = video ? bilibiliMaterial(owner,video).text : browser ? browserStore.block(owner, null, '围绕当前阅读考查一个核心概念') : '';
    if (browser && !material) throw new Error('网页共读已断开，等待重新同步');
    if (scope === 'bilibili' && !video) throw new Error('请先启用 B站学习并选择视频');
    const result = await generateCampfireOpener(owner, exclude, signal, material, 'desktop.study');
    if (!result.ok) throw new Error(result.error);
    return video ? {...result.value,scope:video.title+' · 视频学习材料'} : result.value;
  }, () => {
    const scope=studyClock(owner).state().settings.scope;
    if (scope==='bilibili') {
      const video=connection(owner,'bilibili').enabled?loadBilibiliVideo(owner):null;
      if (!video) return '';
      try {return video.bvid+':'+video.selectedAt+':'+createHash('sha256').update(bilibiliMaterial(owner,video).text).digest('hex');} catch {return '';}
    }
    if (scope !== 'browser') return 'learning';
    const page = browserStore.state(owner);
    return page?.connected && page.chars > 0 ? `${page.sessionId}:${page.url}:${page.contentRevision}` : '';
  });
  clocks.set(key, clock);
  return clock;
}
export function saveStudySettings(owner: string | null, settings: DesktopStudySettings): void {
  getDb().prepare('INSERT INTO app_settings (owner_id,key,value) VALUES (?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value')
    .run(ownerForWrite(owner), KEY, JSON.stringify(settings));
  studyClock(owner).configure(settings);
}
