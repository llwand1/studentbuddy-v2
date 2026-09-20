/**
 * storage/term-delete-log — 词条删除快照与按批撤销（契约 TOOL-ECOSYSTEM-SPEC §4.5，迁移 v34）。
 *
 * 存在理由：删除权限（拍板⑥「AI 全权增删改查」）的**授权前提是可撤销**——删前逐条把整行
 * JSON 存进来，撤销＝按 `affected_batch` 整批 UPSERT 回库并删该批日志行。
 *
 * ★ 刻意**不做软删列 `deleted_at`**（契约原话）：那要给 `listTerms`/`getRelevantTerms`/
 *   `countUsage`/`domainStats`/`planTidy`/`normalizeTidyPlan` 全量加过滤（10+ 触点，漏一处
 *   就是隐蔽 bug）；快照表零改动现有查询即达到同等可恢复性。
 * ★ **归属即撤销门禁（v1.4 堵归主洞）**：`undoDeleteBatch` 的 `WHERE owner_id = ?` 拿不到行
 *   就按「批次不存在」回 null——**不区分「不存在」与「归属他人」**，与 `removeTerm` 的
 *   删 0 行同形口径一致，不给探测面（否则 A 能用 404/403 差异枚举 B 的批次号）。
 * ★ 冲突**不覆盖、如实报告**（§4.5）：撤销前用户手动加了同 (owner,term,domain) 的行时，
 *   该条**跳过复原、保留日志行**（日志行就是「这批还没撤干净」的事实，删了它等于把冲突藏起来）。
 * ★ 调用方负责「先 SELECT 整行再 DELETE」——本模块只认传进来的整行，不回查（回查时行已没了）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { indexRow } from '../search/fts-index.js';
import type { TermRow } from '../learning/terms.js';

/** `actor` 两态（v1.4 拍板⑯）：AI 工具删的、UI 手动删的——同表同回滚码，不加第二套逻辑 */
export type DeleteActor = 'ai_tool' | 'ui';

/**
 * 删除前取整行快照原料（调用方顺序恒为 select → delete → log，**行没了就凑不出快照**）。
 * ★ 为什么本模块自己写这句 `SELECT *` 而不复用 `learning/terms.ts` 的查询：快照要的是
 *   **原始整行**（`aliases` 保持 JSON 字符串、带 `TermRow` 接口没声明的 evo 列），
 *   而 `listTerms` 返回的是解析后 + JOIN 列的形状，`findTermByName` 只认名字不认 id——
 *   契约 §5.1 判据「learning/* 零改动」同时成立（不给既有域层加只为快照服务的口子）。
 * 归属条件与 `removeTerm` 同款进 `WHERE`：查不到＝不存在或不是你的，两态同形（空数组）。
 */
export function selectTermRowsForSnapshot(ids: string[], ownerId: string | null): TermRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const marks = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM term_library WHERE owner_id = ? AND id IN (${marks})`)
    .all(ownerForWrite(ownerId), ...ids) as TermRow[];
}

export interface LogDeletionsInput {
  /** 删除**前**逐条 SELECT 出的整行（字段全集进 snapshot，撤销才可逆） */
  rows: TermRow[];
  ownerId: string | null;
  actor: DeleteActor;
  /** `delete_terms` | `tidy_terms:auto` | `tidy_terms:merge` | `tidy_terms:rename_domain`；actor='ui' 时传 null */
  tool: string | null;
}

/** 写一批快照，返回批次号（撤销与「撤销这 N 条」都以它为键）。空 rows 不开空批次（0 条的批次是噪音） */
export function logTermDeletions(input: LogDeletionsInput): { batch: string; logged: number } {
  const batch = randomUUID();
  if (input.rows.length === 0) return { batch, logged: 0 };
  const owner = ownerForWrite(input.ownerId);
  const insert = getDb().prepare(
    `INSERT INTO term_delete_log (owner_id, term_id, snapshot, actor, tool, affected_batch)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = getDb().transaction(() => {
    for (const r of input.rows) insert.run(owner, r.id, JSON.stringify(r), input.actor, input.tool, batch);
  });
  tx();
  return { batch, logged: input.rows.length };
}

export interface UndoableBatch {
  batch: string;
  count: number;
  actor: DeleteActor;
  tool: string | null;
  /** 批次内首条的落库时间（UTC `YYYY-MM-DD HH:MM:SS`），给 UI 说「几分钟前删了 N 条」 */
  createdAt: string;
}

/** 可撤销批次（词条页撤销条数据源）。不定 TTL——「不清理」是契约判据（单行 ≈0.5KB，量级可忽略） */
export function listUndoableBatches(ownerId: string | null): UndoableBatch[] {
  return getDb()
    .prepare(
      `SELECT affected_batch AS batch, COUNT(*) AS count, actor, tool, MIN(created_at) AS createdAt
         FROM term_delete_log WHERE owner_id = ? AND affected_batch IS NOT NULL
        GROUP BY affected_batch
        ORDER BY createdAt DESC LIMIT 50`,
    )
    .all(ownerForWrite(ownerId)) as UndoableBatch[];
}

export interface UndoResult {
  restored: number;
  /** 与现有词条撞 (owner,term,domain) 而被跳过的快照（文案由调用方组织，这里只给事实） */
  conflicts: string[];
}

/**
 * 按批撤销：归属校验 → 逐条查撞键 → 不撞的 UPSERT 回库并删该行日志，撞的**跳过并保留日志**。
 * 返回 null ＝「批次不存在或不属于你」（404 同形，见头注）。整批一个事务：
 * 半撤状态比冲突更糟——撤失败就该整批原样留着，让用户重试或找回来路。
 */
export function undoDeleteBatch(batch: string, ownerId: string | null): UndoResult | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const rows = db
    .prepare('SELECT id, term_id, snapshot FROM term_delete_log WHERE affected_batch = ? AND owner_id = ?')
    .all(batch, owner) as Array<{ id: number; term_id: string; snapshot: string }>;
  if (rows.length === 0) return null;

  const exists = db.prepare('SELECT 1 FROM term_library WHERE id = ? OR (owner_id = ? AND term = ? AND domain = ?)');
  /**
   * 复原列清单＝`term_library` **全 18 列**（v1 建表 11 + v4 aliases + v14 深度理解三列
   * evo_level/best_level/evo_updated_at + v22 复习两列 + v28 review_enabled + v31 owner_id）。
   * ★ 深度理解三列不在 `TermRow` 接口里，但快照来自调用方的 `SELECT *`，运行时**带着它们**——
   *   复原不写回的话「撤销」会把用户的 evo_level 静默清零，撤销可逆的承诺就破了一半。
   *   列漏了不报错（回落 DEFAULT），所以这份清单要随迁移追加（同 TermRow 的纪律）。
   */
  const restore = db.prepare(
    `INSERT INTO term_library (id, term, definition, domain, source_session_id, importance, usage_count,
        last_used_at, created_at, updated_at, aliases, evo_level, best_level, evo_updated_at,
        owner_id, review_stage, last_reviewed_at, review_enabled)
     VALUES (@id, @term, @definition, @domain, @source_session_id, @importance, @usage_count,
        @last_used_at, @created_at, @updated_at, @aliases, @evo_level, @best_level, @evo_updated_at,
        @owner_id, @review_stage, @last_reviewed_at, @review_enabled)`,
  );
  const dropLog = db.prepare('DELETE FROM term_delete_log WHERE id = ?');

  const conflicts: string[] = [];
  let restored = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      let snap: TermRow & Partial<Record<'evo_level' | 'best_level' | 'evo_updated_at', unknown>>;
      try {
        snap = JSON.parse(r.snapshot) as typeof snap;
      } catch {
        // 快照坏行＝事实受损，不猜内容也不静默吞：如实计入冲突面（保留日志行，界面上看得见没撤成）
        conflicts.push(r.term_id);
        continue;
      }
      if (exists.get(snap.id, owner, snap.term, snap.domain)) {
        conflicts.push(snap.term);
        continue;
      }
      restore.run({
        ...snap,
        owner_id: owner,
        // 老快照可能缺深度理解列（建表顺序决定），缺列按 DEFAULT 复原而不是让整个批次失败
        aliases: snap.aliases ?? '[]',
        usage_count: snap.usage_count ?? 0,
        evo_level: snap.evo_level ?? 0,
        best_level: snap.best_level ?? 0,
        evo_updated_at: snap.evo_updated_at ?? null,
        review_stage: snap.review_stage ?? 0,
        last_reviewed_at: snap.last_reviewed_at ?? null,
        review_enabled: snap.review_enabled ?? null,
      });
      dropLog.run(r.id);
      // 搜索索引（契约 docs/FTS-SPEC.md §3.3）：撤销删除＝把整行 UPSERT 回库，
      // 它是**新增了一条可搜的记录**——不同步的话，刚撤回来的词条搜不到，
      // 用户会以为撤销没生效（而库里明明有了）。
      indexRow('term', snap.id);
      restored++;
    }
  });
  tx();
  return { restored, conflicts };
}

/** 日志总条数（设置页「如实显示日志总条数」，§4.5 尾判据） */
export function countDeleteLog(ownerId: string | null): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM term_delete_log WHERE owner_id = ?')
    .get(ownerForWrite(ownerId)) as { n: number };
  return row.n;
}
