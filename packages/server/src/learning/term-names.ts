/**
 * learning/term-names — 「用户库里已有哪些名字」这一件事的唯一实现。
 *
 * 等待时刷词出新词（`drill.ts`）与大陆开拓出词（`continent-expand.ts`）
 * 都要让模型**避开**用户已有的词条、并在模型给出重名时把它筛掉。两处若各自写一份"正名 + 别名 + 归一化"，
 * 迟早一处改了归一化口径另一处没改 ⇒ 同一个词在一边算重复、另一边算新词。⇒ 抽成这一个文件。
 *
 * ★ 归一口径与 `chest.ts` 的抽卡去重同：去空白 + 小写（`normName`）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { parseAliases } from './terms.js';

/** 归一名（与 `chest.ts` 的去重口径同：去空白 + 小写） */
export function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** 用户库里已有的名字（正名 + 别名，已归一）——新词条不许与之重名 */
export function ownedNames(ownerId: string | null): Set<string> {
  const owned = new Set<string>();
  const rows = getDb()
    .prepare('SELECT term, aliases FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ term: string; aliases: string | null }>;
  for (const r of rows) {
    owned.add(normName(r.term));
    for (const a of parseAliases(r.aliases)) owned.add(normName(a));
  }
  return owned;
}
