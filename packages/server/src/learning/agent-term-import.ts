/** 新词追加、批次幂等、来源回执；整个批次一个事务，事件在提交后才发布。 */
import { createHash } from 'node:crypto';
import type { AgentTermBatch, AgentImportReceipt, AgentTermResult } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { saveOneTerm, buildTermIndex } from './terms.js';
import { setTermReviewScope } from './term-review-scope.js';
import { loadExamContext } from './exam-mode.js';
import { termIdsInScope } from './term-source.js';
import { indexRow } from '../search/fts-index.js';
import { publishEvent } from '../events/bus.js';

export class AgentImportConflict extends Error {}
export function importAgentTerms(batch: AgentTermBatch, ownerId: string | null, keyId: string): AgentImportReceipt {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const hash = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  const freshIds: string[] = [];
  const result = db.transaction(() => {
    const previous = db.prepare('SELECT payload_hash,response_json FROM agent_term_receipt WHERE owner_id = ? AND batch_id = ?')
      .get(owner, batch.batchId) as { payload_hash: string; response_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) throw new AgentImportConflict('同一个 batchId 已用于不同内容，请使用新的 batchId。');
      return { ...(JSON.parse(previous.response_json) as AgentImportReceipt), replayed: true };
    }
    const index = buildTermIndex(ownerId);
    const results: AgentTermResult[] = [];
    for (const [i, t] of batch.terms.entries()) {
      const hit = index.find(t.term, t.domain);
      let id = hit;
      if (!id) {
        id = saveOneTerm(t.term, t.definition, t.domain, ownerId, { urls: t.sourceUrls, origin: 'agent' }, index).id;
        db.prepare('UPDATE term_library SET importance = ?, aliases = ? WHERE id = ? AND owner_id = ?')
          .run(t.importance, JSON.stringify(t.aliases), id, owner);
        if (batch.review) setTermReviewScope(id, true, ownerId);
        indexRow('term', id);
        index.add(t.term, t.domain, id, t.aliases);
        freshIds.push(id);
      }
      results.push({ index: i, id, term: t.term, status: hit ? 'skipped' : 'added', visibleInCurrentScope: true, warnings: [], sourceNote: t.sourceNote });
    }
    const exam = loadExamContext(ownerId);
    const visible = exam.on && exam.hosts.length ? termIdsInScope(ownerId, exam.hosts) : null;
    for (const row of results) {
      row.visibleInCurrentScope = visible === null || visible.has(row.id);
      if (!row.visibleInCurrentScope) row.warnings.push('已保存，但没有命中当前应试白名单的完整来源 URL，当前应试视图不会显示。');
    }
    const receipt: AgentImportReceipt = { batchId: batch.batchId, added: freshIds.length, skipped: results.length - freshIds.length, replayed: false, results };
    db.prepare('INSERT INTO agent_term_receipt (owner_id,batch_id,key_id,payload_hash,response_json) VALUES (?,?,?,?,?)')
      .run(owner, batch.batchId, keyId, hash, JSON.stringify(receipt));
    return receipt;
  })();
  if (freshIds.length) publishEvent({ type: 'term_added', count: freshIds.length, ownerId, termIds: freshIds });
  return result;
}
