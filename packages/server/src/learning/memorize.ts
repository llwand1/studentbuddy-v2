/**
 * learning/memorize — 背背背词条服务（SRS 引擎第一个接入者）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { schedule, nextReviewAt, isDue, type SrsQuality } from './srs.js';
import { publishEvent } from '../events/bus.js';

export interface MemorizeRow {
  id: string;
  term: string;
  definition: string;
  category: string | null;
  difficulty: number;
  status: string;
  ease_factor: number;
  interval_days: number;
  next_review_at: string | null;
  review_count: number;
  lapse_count: number;
}

export function listTerms(category?: string): MemorizeRow[] {
  const sql = category
    ? 'SELECT * FROM memorize WHERE category = ? ORDER BY created_at DESC'
    : 'SELECT * FROM memorize ORDER BY created_at DESC';
  return (category ? getDb().prepare(sql).all(category) : getDb().prepare(sql).all()) as MemorizeRow[];
}

export function addTerm(term: string, definition: string, category?: string): string {
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO memorize (id, term, definition, category) VALUES (?, ?, ?, ?)')
    .run(id, term, definition, category ?? null);
  return id;
}

export function addTermsBatch(items: Array<{ term: string; definition: string; category?: string }>): number {
  const stmt = getDb().prepare('INSERT INTO memorize (id, term, definition, category) VALUES (?, ?, ?, ?)');
  let n = 0;
  const tx = getDb().transaction(() => {
    for (const it of items) {
      if (!it.term?.trim() || !it.definition?.trim()) continue;
      stmt.run(randomUUID(), it.term.trim(), it.definition.trim(), it.category ?? null);
      n += 1;
    }
  });
  tx();
  return n;
}

export function removeTerm(id: string): void {
  getDb().prepare('DELETE FROM memorize WHERE id = ?').run(id);
}

/** 今日待复习队列：新词或到期词，按到期时间升序（走 (status,next_review_at) 索引）。 */
export function dueQueue(now: Date, limit = 50): MemorizeRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM memorize WHERE status != 'mastered' ORDER BY next_review_at IS NULL DESC, next_review_at ASC LIMIT ?`)
    .all(limit) as MemorizeRow[];
  return rows.filter((r) => isDue(r.next_review_at, now));
}

/** 提交一次复习：SRS 引擎调度 → 更新词条。 */
export function reviewTerm(id: string, quality: SrsQuality, now: Date): { intervalDays: number; nextReviewAt: string } | null {
  const row = getDb().prepare('SELECT * FROM memorize WHERE id = ?').get(id) as MemorizeRow | undefined;
  if (!row) return null;
  const next = schedule(
    { easeFactor: row.ease_factor, intervalDays: row.interval_days, reviewCount: row.review_count, lapseCount: row.lapse_count },
    quality,
  );
  const nra = nextReviewAt(now, next.intervalDays);
  // 连续 5 次记住且间隔 ≥21 天 → mastered（可再激活）
  const mastered = next.reviewCount >= 5 && next.intervalDays >= 21 ? 1 : 0;
  getDb()
    .prepare(
      `UPDATE memorize SET ease_factor=?, interval_days=?, next_review_at=?, review_count=?, lapse_count=?, status=? WHERE id=?`,
    )
    .run(next.easeFactor, next.intervalDays, nra, next.reviewCount, next.lapseCount, mastered ? 'mastered' : 'learning', id);
  publishEvent({ type: 'review_done', termId: id, quality });
  return { intervalDays: next.intervalDays, nextReviewAt: nra };
}

export function stats(): { total: number; mastered: number; due: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) c FROM memorize').get() as { c: number }).c;
  const mastered = (db.prepare("SELECT COUNT(*) c FROM memorize WHERE status='mastered'").get() as { c: number }).c;
  const due = dueQueue(new Date(), 100000).length;
  return { total, mastered, due };
}
