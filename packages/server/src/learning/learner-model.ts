/**
 * learning/learner-model — 学习者模型：误区的读写 + 由事实派生的画像 + 注入对话的那一段。
 *
 * ★ 与 `chat/memory.ts`（长期画像）的分工：那边是**会话压缩时模型总结出来的**偏好与背景
 *   （"在备考""喜欢类比"），这边是**由学习数据算出来的**掌握情况——哪些词条快忘了（FSRS）、
 *   哪类题弱（答题事件）、误解了什么（评分诊断）。前者是"他说过什么"，后者是"他会什么"。
 * ★ 归属按 `ownerForWrite`（本地模式 ''），与 `learning_event` 同口径。
 */
import { randomUUID } from 'node:crypto';
import type { LearnerMisconception, LearnerModel, LearnerWeakTerm } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { rowsAll, toReviewTerm } from './term-review.js';
import { personalization } from './fsrs-personal.js';
import { abilityFor } from './adaptive-quiz.js';

/** 快忘的阈值：当前可提取度低于它才算"快忘了" */
export const WEAK_RETENTION = 0.8;
const MAX_WEAK = 8;
const MAX_MISCONCEPTIONS = 10;
/** 校准至少要这么多条带预测的复习才给数（样本太少的"预测 vs 实际"只是噪音） */
export const CALIBRATION_MIN_N = 10;

export function recordMisconception(ownerId: string | null, m: { termId: string | null; topic: string; note: string }): string {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const note = m.note.trim().slice(0, 120);
  // ★ 同一个误区再犯只计数：按 (owner, 词条或主题, 原文) 去重，且**已解决的会被重新打开**——
  //   又犯了就说明没真解决。
  const hit = db
    .prepare(
      `SELECT id FROM learner_misconception
        WHERE owner_id = ? AND COALESCE(term_id, '') = ? AND topic = ? AND note = ? LIMIT 1`,
    )
    .get(owner, m.termId ?? '', m.termId ? '' : m.topic, note) as { id: string } | undefined;
  if (hit) {
    db.prepare(`UPDATE learner_misconception SET count = count + 1, last_seen = datetime('now'), resolved_at = NULL WHERE id = ?`).run(hit.id);
    return hit.id;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO learner_misconception (id, owner_id, term_id, topic, note) VALUES (?, ?, ?, ?, ?)').run(
    id,
    owner,
    m.termId,
    m.termId ? '' : m.topic,
    note,
  );
  return id;
}

/** 答对了挂在该词条上的题 ⇒ 该词条的未解决误区一并标为已解决。返回解决条数。 */
export function resolveMisconceptions(ownerId: string | null, termId: string): number {
  return getDb()
    .prepare(`UPDATE learner_misconception SET resolved_at = datetime('now') WHERE owner_id = ? AND term_id = ? AND resolved_at IS NULL`)
    .run(ownerForWrite(ownerId), termId).changes;
}

/** 手动标记一条已解决（学习者自己说"这个我懂了"）。不是自己的 ⇒ false。 */
export function resolveMisconception(ownerId: string | null, id: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE learner_misconception SET resolved_at = datetime('now') WHERE id = ? AND owner_id = ? AND resolved_at IS NULL`)
      .run(id, ownerForWrite(ownerId)).changes > 0
  );
}

export function openMisconceptions(ownerId: string | null, limit = MAX_MISCONCEPTIONS): LearnerMisconception[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.term_id, COALESCE(t.term, m.topic) AS topic, m.note, m.count, m.last_seen
         FROM learner_misconception m LEFT JOIN term_library t ON t.id = m.term_id
        WHERE m.owner_id = ? AND m.resolved_at IS NULL
        ORDER BY m.last_seen DESC, m.count DESC LIMIT ?`,
    )
    .all(ownerForWrite(ownerId), limit) as Array<{ id: string; term_id: string | null; topic: string; note: string; count: number; last_seen: string }>;
  return rows.map((r) => ({ id: r.id, termId: r.term_id, topic: r.topic, note: r.note, count: r.count, lastSeen: r.last_seen }));
}

/** 复习过、没毕业、当前可提取度低于阈值的词条，最危险的在前 */
export function weakTerms(ownerId: string | null, now = new Date(), limit = MAX_WEAK): LearnerWeakTerm[] {
  return rowsAll(undefined, ownerId)
    .map((r) => toReviewTerm(r, now))
    .filter((t) => t.review.basis === 'review' && !t.review.mastered && t.review.retention < WEAK_RETENTION)
    .sort((a, b) => a.review.retention - b.review.retention)
    .slice(0, limit)
    .map((t) => ({ id: t.id, term: t.term, retention: Math.round(t.review.retention * 100) / 100, difficulty: t.review.difficulty ?? null }));
}

function byType(ownerId: string | null): LearnerModel['byType'] {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(payload, '$.qtype') AS qtype, COUNT(*) AS answers,
              SUM(CASE WHEN json_extract(payload, '$.correct') = 1 THEN 1 ELSE 0 END) AS correct
         FROM learning_event
        WHERE owner_id = ? AND kind = 'quiz.answered' AND created_at >= datetime('now', '-30 days')
        GROUP BY qtype ORDER BY answers DESC`,
    )
    .all(ownerForWrite(ownerId)) as Array<{ qtype: string | null; answers: number; correct: number }>;
  return rows.map((r) => ({ qtype: r.qtype ?? 'unknown', answers: r.answers, correct: r.correct ?? 0 }));
}

/** 近 90 天：FSRS 复习时预测的平均可提取度 vs 实际记住比例 */
export function calibration(ownerId: string | null): LearnerModel['calibration'] {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n, AVG(f.retrievability) AS predicted, AVG(l.remembered) AS actual
         FROM term_review_fsrs f
         JOIN term_review_log l ON l.id = f.log_id
         JOIN term_library t ON t.id = f.term_id
        WHERE t.owner_id = ? AND f.retrievability IS NOT NULL AND f.reviewed_at >= datetime('now', '-90 days')`,
    )
    .get(ownerForWrite(ownerId)) as { n: number; predicted: number | null; actual: number | null };
  if (row.n < CALIBRATION_MIN_N || row.predicted === null || row.actual === null) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: row.n, predicted: r2(row.predicted), actual: r2(row.actual) };
}

export function learnerModel(ownerId: string | null, now = new Date()): LearnerModel {
  return {
    weakTerms: weakTerms(ownerId, now),
    misconceptions: openMisconceptions(ownerId),
    byType: byType(ownerId),
    calibration: calibration(ownerId),
    ability: abilityFor(ownerId),
    fsrs: personalization(ownerId),
  };
}

/**
 * 注入对话 system 位的一段。★ 只放"会改变回答方式"的两样：快忘的词条（顺带帮他回忆）与未解决的误区
 * （讲到相关内容时主动纠正）。题型正确率与校准不进提示词——它们是给人看的，不是给模型的。
 * ★ 空模型返回 ''（由段组装统一剔除，不占窗口）。取数失败同样回 ''：画像是增强，不能挡住对话。
 */
export function buildLearnerBlock(ownerId: string | null, now = new Date()): string {
  try {
    const weak = weakTerms(ownerId, now, 5);
    const mis = openMisconceptions(ownerId, 5);
    if (weak.length === 0 && mis.length === 0) return '';
    const lines = ['【学习者当前状况】（系统依据复习与作答记录生成，仅供你调整讲法；不要逐条念给学生）'];
    if (weak.length > 0) {
      lines.push(`快要忘记的词条：${weak.map((w) => `${w.term}（约 ${Math.round(w.retention * 100)}%）`).join('、')}。话题相关时可以顺带帮他回忆。`);
    }
    if (mis.length > 0) {
      lines.push('尚未纠正的误区（讲到相关内容时请主动、温和地纠正）：');
      for (const m of mis) lines.push(`- ${m.topic ? `${m.topic}：` : ''}${m.note}${m.count > 1 ? `（出现 ${m.count} 次）` : ''}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 出题用的一段：未解决的误区。★ 模型不知道误区与本次材料是否相关，故指令写成"相关时才针对"，
 * 避免为了考误区而离题。没有误区 ⇒ ''（出题提示词与旧版逐字一致）。
 */
export function buildLearnerQuizBlock(ownerId: string | null): string {
  try {
    const mis = openMisconceptions(ownerId, 5);
    if (mis.length === 0) return '';
    const list = mis.map((m) => `- ${m.topic ? `${m.topic}：` : ''}${m.note}`).join('\n');
    return `\n学生此前暴露过这些误区。若与本次材料相关，请至少设计一道能区分"真懂"与"这种误解"的题（干扰项可以正是这种误解）；无关则忽略：\n${list}\n`;
  } catch {
    return '';
  }
}
