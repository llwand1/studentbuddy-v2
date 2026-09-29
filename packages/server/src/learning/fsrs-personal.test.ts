/**
 * learning/fsrs-personal — 个人化 FSRS：样本从日志取且按用户隔离；拟合落库；
 * ★ 缩放只作用在读侧（间隔变长），写侧推进仍用原始 S（不复利）；重拟节奏。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fsrsNext } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { saveOneTerm } from './terms.js';
import { setDomainReviewScope } from './term-review-scope.js';
import { markReviewed, termReviewState } from './term-review.js';
import { FSRS_REFIT_EVERY, fitAndSave, fitSamples, personalization, shouldRefit } from './fsrs-personal.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fsrsfit-'));
  openIsolated(dir);
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const U = 'u1';
function term(name: string, owner = U): string {
  const row = saveOneTerm(name, `${name}的释义`, 'bio', owner);
  setDomainReviewScope('bio', true, owner);
  return row.id;
}
/** 直接写 n 条带预测 R 的复习日志 */
function logs(termId: string, n: number, r: number, remembered: (i: number) => boolean): void {
  const db = getDb();
  for (let i = 0; i < n; i += 1) {
    const id = randomUUID();
    db.prepare(`INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_at, reviewed_day) VALUES (?, ?, 1, ?, datetime('now', '-3 days'), '2026-09-26')`).run(id, termId, remembered(i) ? 1 : 0);
    db.prepare(`INSERT INTO term_review_fsrs (log_id, term_id, grade, stability, difficulty, retrievability, reviewed_at) VALUES (?, ?, 3, 5, 5, ?, datetime('now', '-3 days'))`).run(id, termId, r);
  }
}
function setFsrs(termId: string, stability: number): void {
  getDb().prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', '-1 days'), review_stage = 2 WHERE id = ?`).run(termId);
  getDb().prepare(`INSERT OR REPLACE INTO term_fsrs (term_id, stability, difficulty) VALUES (?, ?, 5)`).run(termId, stability);
}

describe('fitSamples / fitAndSave', () => {
  it('样本只取自己的、只取有预测的；不足 30 不落库', () => {
    const a = term('光合作用');
    const b = term('呼吸作用', 'u2');
    logs(a, 10, 0.8, () => true);
    logs(b, 50, 0.8, () => true);
    getDb().prepare(`INSERT INTO term_review_fsrs (log_id, term_id, grade, retrievability) VALUES ('x', ?, 3, NULL)`).run(a);
    expect(fitSamples(U)).toHaveLength(10);
    expect(fitAndSave(U)).toBeNull();
    expect(personalization(U)).toBeNull();
  });

  it('★ 记得比默认预测牢 ⇒ k>1 落库，学习者读侧间隔变长；别人不受影响', () => {
    const a = term('光合作用');
    logs(a, 60, 0.7, (i) => i % 20 !== 0); // 预测 70%，实际 95%
    const t = term('暗反应');
    setFsrs(t, 10);
    const before = termReviewState(t, U)!.review.intervalDays;
    const p = fitAndSave(U)!;
    expect(p.scale).toBeGreaterThan(1.2);
    expect(p.n).toBe(60);
    expect(p.lossFitted).toBeLessThan(p.lossDefault);
    const after = termReviewState(t, U)!.review.intervalDays;
    expect(after).toBeGreaterThan(before);
    const o = term('有丝分裂', 'u2');
    setFsrs(o, 10);
    expect(termReviewState(o, 'u2')!.review.intervalDays).toBe(before);
  });

  it('★ 写侧不复利：拟合后复习，存下的 S 仍按原始 S 推进', () => {
    const a = term('光合作用');
    logs(a, 60, 0.7, () => true);
    fitAndSave(U);
    const t = term('暗反应');
    setFsrs(t, 10);
    markReviewed(t, true, U);
    const s = (getDb().prepare('SELECT stability FROM term_fsrs WHERE term_id = ?').get(t) as { stability: number }).stability;
    expect(s).toBeCloseTo(fsrsNext({ stability: 10, difficulty: 5 }, 3, 1).stability, 6);
  });
});

describe('shouldRefit', () => {
  it('没拟合过看总数；拟合过看新增', () => {
    const a = term('光合作用');
    logs(a, 29, 0.8, () => true);
    expect(shouldRefit(U)).toBe(false);
    logs(a, 1, 0.8, () => true);
    expect(shouldRefit(U)).toBe(true);
    fitAndSave(U);
    getDb().prepare(`UPDATE fsrs_user_param SET fitted_at = datetime('now', '-1 days')`).run();
    expect(shouldRefit(U)).toBe(false);
    const db = getDb();
    for (let i = 0; i < FSRS_REFIT_EVERY; i += 1) {
      db.prepare(`INSERT INTO term_review_fsrs (log_id, term_id, grade, retrievability) VALUES (?, ?, 3, 0.8)`).run(randomUUID(), a);
    }
    expect(shouldRefit(U)).toBe(true);
  });
});
