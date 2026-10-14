import type { LearningVideosBlockPayload, VideoHit, VideoRouteResult } from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { examAllowed, loadExamContext } from '../learning/exam-mode.js';
type Entry = { ticket: number; at: number; snapshot: LearningVideosBlockPayload | null; pool: VideoHit[] };
const entries = new Map<string, Entry>();
let sequence = 0;
const key = (owner: string | null, sessionId: string) => JSON.stringify([owner ?? '', sessionId]);
function current(owner: string | null, sessionId: string): Entry | undefined {
  const k = key(owner, sessionId), value = entries.get(k);
  if (value && Date.now() - value.at > 1800000) { entries.delete(k); return; }
  return value;
}
function allowed(owner: string | null, hits: VideoHit[]): VideoHit[] {
  const exam = loadExamContext(owner);
  return exam.on ? hits.filter(hit => examAllowed(hit.url,exam)) : hits;
}
export function beginVideoSearch(owner: string | null, sessionId: string): number {
  const k = key(owner, sessionId), prior = current(owner, sessionId), ticket = ++sequence;
  entries.delete(k); entries.set(k, {ticket, at:Date.now(), snapshot:prior?.snapshot ?? null, pool:prior?.pool ?? []});
  while (entries.size > 128) entries.delete(entries.keys().next().value!);
  return ticket;
}
function emit(entry: Entry, sessionId: string, result: VideoRouteResult): LearningVideosBlockPayload {
  const revision = ++sequence;
  entry.ticket = revision; entry.at = Date.now();
  entry.snapshot = {kind:'learning-videos',sessionId,revision,result:{...result,revision}};
  publish(sessionId, {type:'block',sessionId,blockId:'learning-videos',done:true,payload:entry.snapshot});
  return structuredClone(entry.snapshot);
}
export function finishVideoSearch(owner: string | null, sessionId: string, ticket: number, result: VideoRouteResult, append = false): LearningVideosBlockPayload | null {
  const entry = current(owner, sessionId);
  if (!entry || entry.ticket !== ticket) return null;
  const previous = append && entry.snapshot?.result.route === result.route ? entry.pool : [];
  entry.pool = allowed(owner,[...new Map([...previous,...result.hits].map(hit => [hit.url,hit])).values()].slice(0,24));
  const via = result.via === 'none' && entry.pool.length ? entry.snapshot?.result.via ?? 'web' : result.via;
  return emit(entry, sessionId, {...result,via,hits:entry.pool, ...(previous.length ? {note:'追加检索结果，保留此前同平台的候选；标题和地址均来自真实检索。'} : {})});
}
export function readLearningVideos(owner: string | null, sessionId: string): LearningVideosBlockPayload | null {
  const snapshot = current(owner, sessionId)?.snapshot;
  return snapshot ? structuredClone({...snapshot,result:{...snapshot.result,hits:allowed(owner,snapshot.result.hits)}}) : null;
}
export function curateLearningVideos(owner: string | null, sessionId: string, revision: number, urls: unknown): LearningVideosBlockPayload {
  const entry = current(owner, sessionId), snapshot = entry?.snapshot;
  if (!entry || !snapshot || revision !== snapshot.revision) throw new Error('视频候选已更新或过期，请先读取最新候选');
  if (!Array.isArray(urls) || urls.length > 24 || urls.some(url => typeof url !== 'string') || new Set(urls).size !== urls.length) throw new Error('请使用不重复的候选 URL 清单（最多 24 条）');
  const selected: VideoHit[] = [];
  for (const url of urls) {
    const hit = allowed(owner,entry.pool).find(h => h.url === url);
    if (!hit) throw new Error('不能添加未检索到的视频；请先搜索或追加检索');
    selected.push(hit);
  }
  return emit(entry, sessionId, {...snapshot.result,hits:selected,note:'AI 已按本次学习要求筛选/排序；保留的视频均来自实际检索，未自动播放。'});
}
export function resetLearningVideos(): void { entries.clear(); }
