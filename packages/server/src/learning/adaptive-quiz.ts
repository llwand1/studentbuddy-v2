/**
 * learning/adaptive-quiz — 从学习事件流里取答题历史 ⇒ 估能力 ⇒ 给出题提示词一段难度要求。
 * 纯计算在 `@sb/shared` adaptive.ts；这里只负责取数（最近 200 题，旧 → 新）。
 */
import type { AbilityEstimate } from '@sb/shared';
import { difficultyInstruction, estimateAbility } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

const WINDOW = 200;

export function abilityFor(ownerId: string | null): AbilityEstimate {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(payload, '$.qtype') AS qtype, json_extract(payload, '$.correct') AS correct
         FROM learning_event WHERE owner_id = ? AND kind = 'quiz.answered' ORDER BY id DESC LIMIT ?`,
    )
    .all(ownerForWrite(ownerId), WINDOW) as Array<{ qtype: string | null; correct: number | null }>;
  return estimateAbility(rows.reverse().filter((r) => r.correct !== null).map((r) => ({ qtype: r.qtype, correct: r.correct === 1 })));
}

/** 出题用；取数失败或样本不足 ⇒ ''（提示词与旧版一致） */
export function buildDifficultyBlock(ownerId: string | null): string {
  try {
    return difficultyInstruction(abilityFor(ownerId));
  } catch {
    return '';
  }
}
