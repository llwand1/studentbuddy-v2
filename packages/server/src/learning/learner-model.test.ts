/**
 * learning/learner-model.test — FSRS 写路径（经真实 `markReviewed`）＋ 误区读写 ＋ 学习者模型派生 ＋ 注入段。
 *
 * ★ FSRS 这组锁的是**起点三种**与**同日闸门**：新词条首复习 ⇒ fsrsInit、无 R；老词条（有阶段无 FSRS）
 *   ⇒ 按旧间隔折算后推进、有 R；同日重复记住 ⇒ S/D 不动（与阶段同一道闸）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsrsFromLegacy, fsrsInit, fsrsRetrievability, reviewIntervalDays } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { saveOneTerm } from './terms.js';
import { setDomainReviewScope } from './term-review-scope.js';
import { markReviewed } from './term-review.js';
import {
  CALIBRATION_MIN_N,
  buildLearnerBlock,
  buildLearnerQuizBlock,
  calibration,
  learnerModel,
  openMisconceptions,
  recordMisconception,
  resolveMisconception,
  resolveMisconceptions,
  weakTerms,
} from './learner-model.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-learner-'));
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
/** 把"上次复习"挪到 n 天前（状态列与最新一条流水一起挪，同 demo-seed 的口径） */
function backdate(id: string, days: number): void {
  const db = getDb();
  db.prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id);
  db.prepare(`UPDATE term_review_log SET reviewed_at = datetime('now', ?), reviewed_day = '2000-01-01' WHERE term_id = ?`).run(`-${days} days`, id);
}
const fsrsRow = (id: string) => getDb().prepare('SELECT stability, difficulty FROM term_fsrs WHERE term_id = ?').get(id) as { stability: number; difficulty: number } | undefined;
const fsrsLogs = (id: string) =>
  getDb().prepare('SELECT grade, stability, retrievability FROM term_review_fsrs WHERE term_id = ? ORDER BY rowid').all(id) as Array<{ grade: number; stability: number | null; retrievability: number | null }>;

describe('FSRS 写路径（markReviewed）', () => {
  it('★ 新词条首次复习 ⇒ fsrsInit(评分)，流水记评分、无预测 R；返回的状态带稳定性', () => {
    const id = term('光合作用');
    const r = markReviewed(id, true, U)!;
    expect(fsrsRow(id)?.stability).toBeCloseTo(fsrsInit(3).stability, 6);
    expect(fsrsLogs(id)).toEqual([{ grade: 3, stability: fsrsInit(3).stability, retrievability: null }]);
    expect(r.review.stability).toBeCloseTo(fsrsInit(3).stability, 6);
  });

  it('显式四档评分生效（轻松 > 记得）', () => {
    const a = term('甲');
    const b = term('乙');
    markReviewed(a, true, U, { grade: 4 });
    markReviewed(b, true, U, { grade: 3 });
    expect(fsrsRow(a)!.stability).toBeGreaterThan(fsrsRow(b)!.stability);
  });

  it('★ 隔几天再复习 ⇒ 记下复习时的预测 R；记住后稳定性变大', () => {
    const id = term('呼吸作用');
    markReviewed(id, true, U);
    const s0 = fsrsRow(id)!.stability;
    backdate(id, 5);
    markReviewed(id, true, U);
    const logs = fsrsLogs(id);
    expect(logs[1]?.retrievability).toBeCloseTo(fsrsRetrievability(5, s0), 6);
    expect(fsrsRow(id)!.stability).toBeGreaterThan(s0);
  });

  it('★ 同日重复且记住 ⇒ S/D 不动，流水照记但不带 S/R；忘了照样更新', () => {
    const id = term('蒸腾作用');
    markReviewed(id, true, U);
    const s0 = fsrsRow(id)!.stability;
    markReviewed(id, true, U);
    expect(fsrsRow(id)!.stability).toBe(s0);
    expect(fsrsLogs(id)[1]).toEqual({ grade: 3, stability: null, retrievability: null });
    markReviewed(id, false, U);
    expect(fsrsRow(id)!.stability).toBeLessThanOrEqual(s0);
  });

  it('★ 老词条（有阶段、无 FSRS 行）⇒ 按旧间隔折算起点', () => {
    const id = term('渗透');
    getDb().prepare(`UPDATE term_library SET review_stage = 3, last_reviewed_at = datetime('now', '-7 days') WHERE id = ?`).run(id);
    markReviewed(id, true, U);
    const legacy = fsrsFromLegacy(reviewIntervalDays(3));
    expect(fsrsLogs(id)[0]?.retrievability).toBeCloseTo(fsrsRetrievability(7, legacy.stability), 6);
  });
});

describe('误区', () => {
  it('★ 同一误区再犯只计数；已解决的再犯会重新打开', () => {
    const t = term('酶');
    const a = recordMisconception(U, { termId: t, topic: '', note: '酶会被反应消耗' });
    expect(recordMisconception(U, { termId: t, topic: '', note: '酶会被反应消耗' })).toBe(a);
    expect(openMisconceptions(U)[0]).toMatchObject({ id: a, count: 2, topic: '酶', termId: t });
    expect(resolveMisconceptions(U, t)).toBe(1);
    expect(openMisconceptions(U)).toEqual([]);
    recordMisconception(U, { termId: t, topic: '', note: '酶会被反应消耗' });
    expect(openMisconceptions(U)[0]?.count).toBe(3);
  });

  it('没有词条时按主题归类；手动解决只认自己的', () => {
    const id = recordMisconception(U, { termId: null, topic: '细胞分裂', note: '以为减数分裂染色体数不变' });
    expect(openMisconceptions(U)[0]?.topic).toBe('细胞分裂');
    expect(resolveMisconception('someone', id)).toBe(false);
    expect(resolveMisconception(U, id)).toBe(true);
    expect(resolveMisconception(U, id)).toBe(false);
  });

  it('★ 归属隔离', () => {
    recordMisconception('u2', { termId: null, topic: 'x', note: '别人的误区' });
    expect(openMisconceptions(U)).toEqual([]);
  });
});

describe('学习者模型', () => {
  it('快忘的词条：只含复习过、没毕业、可提取度低于阈值的，最危险在前', () => {
    const a = term('快忘甲');
    const b = term('快忘乙');
    const fresh = term('刚复习');
    term('没复习过');
    for (const id of [a, b, fresh]) markReviewed(id, true, U);
    backdate(a, 30);
    backdate(b, 10);
    const weak = weakTerms(U);
    expect(weak.map((w) => w.term)).toEqual(['快忘甲', '快忘乙']);
    expect(weak[0]!.retention).toBeLessThan(weak[1]!.retention);
  });

  it('★ 校准：样本不足给 null；够了给预测 vs 实际', () => {
    const ids = Array.from({ length: CALIBRATION_MIN_N }, (_, i) => term(`校准${i}`));
    for (const id of ids) markReviewed(id, true, U);
    expect(calibration(U)).toBeNull(); // 首次复习没有预测 R
    ids.forEach((id, i) => {
      backdate(id, 3);
      markReviewed(id, i % 2 === 0, U);
    });
    const c = calibration(U)!;
    expect(c.n).toBe(CALIBRATION_MIN_N);
    expect(c.actual).toBe(0.5);
    expect(c.predicted).toBeGreaterThan(0.5);
  });

  it('题型正确率来自学习事件', () => {
    const db = getDb();
    const ins = db.prepare(`INSERT INTO learning_event (owner_id, kind, payload, day) VALUES (?, 'quiz.answered', ?, '2026-09-29')`);
    ins.run(U, JSON.stringify({ correct: true, qtype: 'fill' }));
    ins.run(U, JSON.stringify({ correct: false, qtype: 'fill' }));
    ins.run(U, JSON.stringify({ correct: true, qtype: 'choice' }));
    expect(learnerModel(U).byType).toEqual([
      { qtype: 'fill', answers: 2, correct: 1 },
      { qtype: 'choice', answers: 1, correct: 1 },
    ]);
  });
});

describe('注入段', () => {
  it('空模型 ⇒ 空串（不占窗口，出题提示词与旧版一致）', () => {
    expect(buildLearnerBlock(U)).toBe('');
    expect(buildLearnerQuizBlock(U)).toBe('');
  });
  it('有快忘词条与误区 ⇒ 两类都写进去，且说明不要念给学生', () => {
    const id = term('卡尔文循环');
    markReviewed(id, true, U);
    backdate(id, 30);
    recordMisconception(U, { termId: id, topic: '', note: '以为暗反应只在夜里进行' });
    recordMisconception(U, { termId: id, topic: '', note: '以为暗反应只在夜里进行' });
    const block = buildLearnerBlock(U);
    expect(block).toContain('卡尔文循环（约');
    expect(block).toContain('以为暗反应只在夜里进行（出现 2 次）');
    expect(block).toContain('不要逐条念');
    expect(buildLearnerQuizBlock(U)).toContain('以为暗反应只在夜里进行');
  });
  it('库不可用时回空串，不挡住对话', () => {
    closeDb();
    expect(buildLearnerBlock(U)).toBe('');
    openIsolated(dir);
  });
});
