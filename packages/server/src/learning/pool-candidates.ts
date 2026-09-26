/**
 * learning/pool-candidates — 词池候选的**读与裁决**（契约 `docs/TERM-CARDS-SPEC.md` §6）。
 *
 * ★ 本文件只管两件事：列出候选、把一条候选**定论**（通过／驳回）。
 *   「AI 生成候选」不在这里（任务 #7：走 agnes flash 免费档、产出全落 pending），
 *   「抽的时候怎么用」在 `chest.ts:drawablePool`（只有 `approved` 的才进池）。
 *   三者分开的判据是**权力不同**：生成可以是模型、裁决必须是用户、抽取必须是随机——
 *   写在一个文件里就会诱惑后来人"顺手让生成也自动通过"，而 §6.3 那条人工闸门正是防这个的。
 *
 * ★★ **驳回必须留行，不许删**。删了下次生成同一个词又会回来，用户会看到自己明确否过的
 *   建议反复出现（这是「AI 主动」类功能最常见的反向体验，v45 建表注释里同一条）。
 *   ⇒ `status` 三态 + `decided_at`，而不是一个布尔。
 *
 * ★ owner 条件写进 `WHERE` 且用 `ownerForWrite`（`null` ⇒ `''`）：与 `listTerms` 那条
 *   「归主之后漏传就是串台」同判据。别人的候选 id 在这里必须是"不存在"，不是"没权限"。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { reconcileTasks } from './tasks.js';

export type CandidateStatus = 'pending' | 'approved' | 'rejected';

export interface PoolCandidate {
  id: string;
  term: string;
  domain: string;
  definition: string;
  aliases: string[];
  status: CandidateStatus;
  /** 生成来源（`ai` / `manual`，库里原样透出，UI 据此标「待人工校对」） */
  source: string;
  created_at: string;
  decided_at: string | null;
}

/** 候选列表：默认只看 `pending`（设置页那张卡要的是"待我裁决的"）。 */
export function listCandidates(ownerId: string | null, status: CandidateStatus | 'all' = 'pending'): PoolCandidate[] {
  const owner = ownerForWrite(ownerId);
  const rows =
    status === 'all'
      ? (getDb()
          .prepare(
            `SELECT id, term, domain, definition, aliases, status, source, created_at, decided_at
                 FROM term_pool_candidate WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200`,
          )
          .all(owner) as Array<Omit<PoolCandidate, 'aliases'> & { aliases: string | null }>)
      : (getDb()
          .prepare(
            `SELECT id, term, domain, definition, aliases, status, source, created_at, decided_at
                 FROM term_pool_candidate WHERE owner_id = ? AND status = ?
                ORDER BY created_at ASC, rowid ASC LIMIT 200`,
          )
          .all(owner, status) as Array<Omit<PoolCandidate, 'aliases'> & { aliases: string | null }>);
  return rows.map((r) => ({ ...r, aliases: parseAliasJson(r.aliases) }));
}

export type DecideResult =
  | { ok: true; candidate: PoolCandidate; keysGranted: number }
  | { ok: false; error: string; status: number };

/**
 * 裁决一条候选。
 *
 * ★ `WHERE status = 'pending'` 是**幂等的唯一实现**：重复点第二次钮时 `changes === 0`，
 *   这里就返回 409，而不会把 `decided_at` 洗成新时间——「我什么时候定的」是审计要用的数。
 * ★★ 定论之后**立刻 `reconcileTasks`**（返回里带 `keysGranted`）。这不是顺手加的：
 *   「补池」那一单的完成判据就是「这条候选被裁决过」（`tasks.ts:isDone`），
 *   用户做完动作却拿不到钥匙、要等下一个 6 小时 tick 或者再点一次「我做完了」，
 *   等于把一次真实完成变成两次点击。★ 发钥匙仍只在 `status` 的 open→done 翻转上
 *   （`reconcileTasks` 内部那一处 `changes === 1`），本函数不碰那本账。
 * ⚠️ 驳回**同样**算完成：这一单要的是裁决，不是同意（契约 §5 意图 3）。
 */
export function decideCandidate(ownerId: string | null, id: string, approved: boolean): DecideResult {
  const owner = ownerForWrite(ownerId);
  const db = getDb();
  const r = db
    .prepare(`UPDATE term_pool_candidate SET status = ?, decided_at = datetime('now')
               WHERE id = ? AND owner_id = ? AND status = 'pending'`)
    .run(approved ? 'approved' : 'rejected', id, owner);
  if (r.changes !== 1) {
    const exists = db.prepare('SELECT 1 AS x FROM term_pool_candidate WHERE id = ? AND owner_id = ?').get(id, owner);
    return exists
      ? { ok: false, error: '这条候选已经裁决过了', status: 409 }
      : { ok: false, error: '候选不存在', status: 404 };
  }
  const row = db
    .prepare(
      `SELECT id, term, domain, definition, aliases, status, source, created_at, decided_at
         FROM term_pool_candidate WHERE id = ?`,
    )
    .get(id) as Omit<PoolCandidate, 'aliases'> & { aliases: string | null };
  const { keysGranted } = reconcileTasks(ownerId);
  return { ok: true, candidate: { ...row, aliases: parseAliasJson(row.aliases) }, keysGranted };
}

/** 别名 JSON → string[]（脏 JSON 当作没别名，与 `chest.ts` 的 `parseAliasList` 同一容错口径） */
function parseAliasJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
