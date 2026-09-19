/**
 * storage/term-delete-log —— 快照与按批撤销回归（契约 TOOL-ECOSYSTEM-SPEC §4.5，迁移 v34，P3 收口批）。
 *
 * 存在理由再钉一遍：删除权限（拍板⑥）的**授权前提是可撤销**——本文件不是锦上添花，
 * 是那条前提的验收。三样必测：
 * ① **逐字段可逆**，含 `TermRow` 接口没声明的深度理解三列（evo_level/best_level/
 *    evo_updated_at）——复原列清单漏了不报错、只回落 DEFAULT，「撤销」会把用户进度静默清零；
 * ② 冲突**不覆盖、如实报**（撤销前用户手动加了同名行 → 跳过复原、保留日志行）；
 * ③ 归属门禁**不给探测面**（跨用户撤销与批次不存在回同一个 null，404 同形口径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from './db.js';
import { saveOneTerm } from '../learning/terms.js';
import {
  selectTermRowsForSnapshot,
  logTermDeletions,
  listUndoableBatches,
  undoDeleteBatch,
  countDeleteLog,
} from './term-delete-log.js';
import type { TermRow } from '../learning/terms.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tdl-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一条「有历史包袱」的词条：别名/用量/深度理解三列都非默认值，撤销必须原样带回 */
function seedLoadedTerm(term: string, ownerId: string | null): TermRow {
  const row = saveOneTerm(term, `${term}的释义`, 'cs', ownerId);
  getDb()
    .prepare(
      `UPDATE term_library SET aliases = '["老别名"]', usage_count = 7, importance = 0.9,
         evo_level = 2, best_level = 3, evo_updated_at = '2026-01-02 03:04:05', source_session_id = 'sess-x'
       WHERE id = ?`,
    )
    .run(row.id);
  const rows = selectTermRowsForSnapshot([row.id], ownerId);
  if (rows.length !== 1) throw new Error('种子未落库');
  return rows[0] as TermRow;
}

function rowById(id: string): (TermRow & Record<string, unknown>) | undefined {
  return getDb().prepare('SELECT * FROM term_library WHERE id = ?').get(id) as
    | (TermRow & Record<string, unknown>)
    | undefined;
}

describe('term-delete-log — 逐字段可逆（含 TermRow 没声明的深度理解三列）', () => {
  it('select→delete→log→undo 全环：整行原样回库（id/别名 JSON 串/evo 三列/created_at 都不许变）', async () => {
    const snap = seedLoadedTerm('闭包', null);
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run(snap.id);
    const { batch, logged } = logTermDeletions({ rows: [snap], ownerId: null, actor: 'ai_tool', tool: 'delete_terms' });
    expect(logged).toBe(1);
    expect(rowById(snap.id)).toBeUndefined();
    const undo = undoDeleteBatch(batch, null);
    expect(undo).toEqual({ restored: 1, conflicts: [] });
    const back = rowById(snap.id);
    if (!back) throw new Error('撤销后行没回来');
    // 撤成功的日志行必须删掉（留着＝「还没撤干净」的谎）
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_delete_log WHERE affected_batch = ?').get(batch)).toEqual({ n: 0 });
    expect(back.term).toBe(snap.term);
    expect(back.definition).toBe(snap.definition);
    expect(back.domain).toBe(snap.domain);
    expect(back.aliases).toBe(snap.aliases); // 保持 JSON 字符串原文，不被解析/重排
    expect(back.usage_count).toBe(7);
    expect(back.importance).toBe(0.9);
    expect(back.created_at).toBe(snap.created_at);
    expect(back.source_session_id).toBe('sess-x');
    expect(back.evo_level).toBe(2); // ★ 深度理解三列：漏列不报错只回落 DEFAULT，这里必须看得见
    expect(back.best_level).toBe(3);
    expect(back.evo_updated_at).toBe('2026-01-02 03:04:05');
  });

  it('空 rows 不开空批次（0 条的批次是撤销列表里的噪音）', () => {
    const { logged } = logTermDeletions({ rows: [], ownerId: null, actor: 'ai_tool', tool: 'delete_terms' });
    expect(logged).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_delete_log').get()).toEqual({ n: 0 });
    expect(listUndoableBatches(null)).toHaveLength(0);
  });
});

describe('term-delete-log — 冲突不覆盖、如实报', () => {
  it('撤销前用户手动加了同 (owner,term,domain) 行 → 跳过复原、日志行留着、用户行不动', () => {
    const snap = seedLoadedTerm('分数', null);
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run(snap.id);
    const { batch } = logTermDeletions({ rows: [snap], ownerId: null, actor: 'ai_tool', tool: 'delete_terms' });
    const userRow = saveOneTerm('分数', '用户自己重写的新释义', 'cs', null);
    const undo = undoDeleteBatch(batch, null);
    expect(undo?.restored).toBe(0);
    expect(undo?.conflicts).toEqual(['分数']);
    // 冲突行不撤＝日志保留（它是「这批还没撤干净」的事实），用户行内容原样
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_delete_log WHERE affected_batch = ?').get(batch)).toEqual({ n: 1 });
    expect(rowById(userRow.id)?.definition).toBe('用户自己重写的新释义');
    expect(rowById(snap.id)).toBeUndefined(); // 没覆盖式硬塞第二条同名行
  });

  it('一批两条只撞一条：撤一条、记一条冲突、日志只剩冲突那行（部分成功如实分层）', () => {
    const a = seedLoadedTerm('甲', null);
    const b = seedLoadedTerm('乙', null);
    getDb().prepare('DELETE FROM term_library WHERE id IN (?, ?)').run(a.id, b.id);
    const { batch } = logTermDeletions({ rows: [a, b], ownerId: null, actor: 'ai_tool', tool: 'delete_terms' });
    saveOneTerm('乙', '用户重建的乙', 'cs', null);
    const undo = undoDeleteBatch(batch, null);
    expect(undo?.restored).toBe(1);
    expect(undo?.conflicts).toEqual(['乙']);
    expect(rowById(a.id)?.term).toBe('甲');
    const left = getDb().prepare('SELECT snapshot AS s FROM term_delete_log WHERE affected_batch = ?').all(batch) as Array<{ s: string }>;
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0]?.s ?? '{}').term).toBe('乙');
  });
});

describe('term-delete-log — 归属即门禁（不给探测面）', () => {
  it('跨用户撤销与批次不存在回同一个 null（404 同形）；取行/写行/列表/计数全按人隔离', () => {
    const mine = seedLoadedTerm('我的词', 'u1');
    expect(selectTermRowsForSnapshot([mine.id], 'u2')).toEqual([]); // 别人的 id 查不到，与不存在同形
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run(mine.id);
    const { batch } = logTermDeletions({ rows: [mine], ownerId: 'u1', actor: 'ai_tool', tool: 'delete_terms' });
    expect(undoDeleteBatch(batch, 'u2')).toBeNull();
    expect(undoDeleteBatch('ghost-batch', 'u1')).toBeNull(); // 两条 null 同形，不区分
    expect(undoDeleteBatch(batch, 'u1')?.restored).toBe(1);
    expect(countDeleteLog('u2')).toBe(0);
  });

  it('listUndoableBatches：一批一行、count 正确、UI 删的 actor=ui/tool=null 也在列（同表同回滚码）', () => {
    const a = seedLoadedTerm('甲', 'u1');
    const b = seedLoadedTerm('乙', 'u1');
    const c = seedLoadedTerm('丙', 'u1');
    const db = getDb();
    db.prepare('DELETE FROM term_library WHERE id IN (?, ?, ?)').run(a.id, b.id, c.id);
    logTermDeletions({ rows: [a, b], ownerId: 'u1', actor: 'ai_tool', tool: 'tidy_terms:auto' });
    logTermDeletions({ rows: [c], ownerId: 'u1', actor: 'ui', tool: null });
    db.prepare("UPDATE term_delete_log SET created_at = '2026-09-01 00:00:00' WHERE term_id = ?").run(a.id); // 定序防同秒
    const batches = listUndoableBatches('u1');
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ count: 1, actor: 'ui', tool: null }); // createdAt 新→旧
    expect(batches[1]).toMatchObject({ count: 2, actor: 'ai_tool', tool: 'tidy_terms:auto' });
    expect(listUndoableBatches('u2')).toHaveLength(0); // 无主列表不外泄
  });
});

describe('term-delete-log — 审计侧口径', () => {
  it('countDeleteLog 按人计数（设置页「日志总条数」显示的是事实不是猜）', () => {
    const a = seedLoadedTerm('甲', null);
    const b = seedLoadedTerm('乙', 'u9');
    getDb().prepare('DELETE FROM term_library WHERE id IN (?, ?)').run(a.id, b.id);
    logTermDeletions({ rows: [a], ownerId: null, actor: 'ai_tool', tool: 'delete_terms' });
    logTermDeletions({ rows: [b], ownerId: 'u9', actor: 'ui', tool: null });
    expect(countDeleteLog(null)).toBe(1);
    expect(countDeleteLog('u9')).toBe(1);
  });
});
