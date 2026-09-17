/**
 * chat/memory — 长期记忆**第二层**：跨会话学习画像（契约 `docs/MEMORY-SPEC.md` §5）。
 *
 * 与第一层（`chat/compact.ts` 的会话内压缩）的分工：
 *   - 压缩管「这个会话聊过什么」——随会话生死，存 `sessions.summary`；
 *   - 画像管「这位学习者是谁」——跨会话存活，存 `user_memory`。
 *
 * ★ 本层**只由压缩过程写入**（借道 `[MEMORY]` 协议块，见 MEMORY-SPEC §5.1）：
 *   独立抽取任务需要「何时跑 / 跑多少 / 从哪段跑」三套策略，而压缩已经是一个天然的
 *   「该沉淀了」信号点——省一次 LLM 调用，也少一套调度。
 * ★ 注入是**恒注入不检索**（§5.2）：词条是「与本次提问相关的知识」，检索合理；
 *   画像是「你是谁」，与具体问题无关——「他偏好先看例子」对任何提问都成立，
 *   检索只会把它漏掉。代价是恒占窗口，故必须硬限长（`MEMORY_INJECT_MAX_CHARS`）。
 * ★ 淘汰即**真删**、不做软删（§5.3）：词条被删有 `evolution_event` 冗余快照兜底，
 *   画像没有下游引用，软删只是留垃圾。
 */
import { randomUUID } from 'node:crypto';
import {
  MEMORY_INJECT_MAX_CHARS,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  MEMORY_MAX_ITEMS,
  MEMORY_MIN_IMPORTANCE,
  isMemoryKind,
  normalizeImportance,
  normalizeMemoryContent,
} from '@sb/shared';
import type { MemoryDraft, MemoryItem } from '@sb/shared';
import { getDb } from '../storage/db.js';

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  importance: number;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function toItem(r: MemoryRow): MemoryItem {
  return {
    // 库里理论上只存白名单内的 kind（写入侧已过滤），此处仍兜一层：
    // 手改库 / 老数据 / 未来缩窄白名单都可能让非法值进来，回落会误导，丢弃才是对的。
    id: r.id,
    kind: isMemoryKind(r.kind) ? r.kind : 'profile',
    content: r.content,
    importance: r.importance,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 全量画像（按 importance 倒序）。记忆页与管理动作都用这一份。 */
export function loadMemoryItems(): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, content, importance, source_session_id, created_at, updated_at
         FROM user_memory ORDER BY importance DESC, updated_at DESC`,
    )
    .all() as MemoryRow[];
  return rows.filter((r) => isMemoryKind(r.kind)).map(toItem);
}

/**
 * 入库（幂等）：同 `kind` + 同 `content` 视为同一条，只刷新 `importance`（取 MAX）与 `updated_at`，
 * **不新增行**——与 `term_library` 的 `UNIQUE(term, domain)` 同一手法。
 * 返回实际处理的条数（非新增行数），非法条目在归一阶段即被丢弃。
 */
export function upsertMemoryItems(drafts: MemoryDraft[], sourceSessionId?: string | null): number {
  const db = getDb();
  const clean = drafts
    .filter((d) => isMemoryKind(d.kind))
    .map((d) => ({
      kind: d.kind,
      content: normalizeMemoryContent(d.content),
      importance: normalizeImportance(d.importance),
    }))
    .filter((d) => d.content.length > 0);
  if (clean.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO user_memory (id, kind, content, importance, source_session_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, content) DO UPDATE SET
       importance        = MAX(user_memory.importance, excluded.importance),
       updated_at        = datetime('now')`,
  );
  const apply = db.transaction(() => {
    for (const d of clean) stmt.run(randomUUID(), d.kind, d.content, d.importance, sourceSessionId ?? null);
  });
  apply();
  return clean.length;
}

/** 超上限时按 `importance ASC, updated_at ASC` 删到上限；返回删除条数。 */
export function pruneMemoryItems(): number {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM user_memory').get() as { c: number }).c;
  const excess = total - MEMORY_MAX_ITEMS;
  if (excess <= 0) return 0;
  const res = db
    .prepare(
      `DELETE FROM user_memory WHERE id IN (
         SELECT id FROM user_memory ORDER BY importance ASC, updated_at ASC LIMIT ?
       )`,
    )
    .run(excess);
  return res.changes;
}

/**
 * 构造注入段。**纯函数**（不碰库）——注入顺序与截断是回归锁要钉的东西，
 * 混进 DB 读写就测不到（先例：`mix-report.ts` 的判定逻辑从组件里搬出来）。
 *
 * 返回 `usedIds` 供调用方记账（`markMemoryUsed`）——本函数不写库，保持可测。
 * 按 kind 固定顺序分组（`MEMORY_KINDS` 的声明序）而非按 importance 混排：
 * 模型读「【学习偏好】…【薄弱点】…」比读一堆无标签句子更容易用对。
 */
export function buildMemoryBlock(items: MemoryItem[]): { block: string; usedIds: string[] } {
  const eligible = items
    .filter((m) => m.importance >= MEMORY_MIN_IMPORTANCE)
    .sort((a, b) => b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));

  const head = '关于这位学习者，你已知道（长期记忆，请自然地用上，不必逐条复述）：';
  const lines: string[] = [];
  const usedIds: string[] = [];
  let used = head.length;

  for (const kind of MEMORY_KINDS) {
    const group = eligible.filter((m) => m.kind === kind);
    if (group.length === 0) continue;
    const label = MEMORY_KIND_LABELS[kind];
    const parts: string[] = [];
    for (const m of group) {
      const candidate = `【${label}】${[...parts, m.content].join('；')}`;
      // +1 是换行符；宁可少一条也不超预算（超了会挤掉历史，得不偿失）
      if (used + candidate.length + 1 > MEMORY_INJECT_MAX_CHARS) break;
      parts.push(m.content);
      usedIds.push(m.id);
    }
    if (parts.length > 0) {
      const line = `【${label}】${parts.join('；')}`;
      lines.push(line);
      used += line.length + 1;
    }
  }

  if (lines.length === 0) return { block: '', usedIds: [] };
  return { block: `${head}\n${lines.join('\n')}`, usedIds };
}

/**
 * 记账「这些记忆被注入过」。**只写 usage_count，不参与排序**——
 * 它是后续调参的观察窗（哪些记忆真被反复用上），不是淘汰依据。
 */
export function markMemoryUsed(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE user_memory SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?`,
  );
  const apply = db.transaction(() => {
    for (const id of ids) stmt.run(id);
  });
  apply();
}

/**
 * 一步到位：读库 → 选条目 → 建段 → 记账。`flow.ts` 只调这一个函数。
 *
 * 打包的理由不只是省行数（`flow.ts` 已贴 400 行红线）：这四步**必须一起发生**——
 * 少记账等于观察窗失效，少建段等于白读一次库，分开写在调用方很容易漏掉其中一步。
 */
export function injectMemoryBlock(): string {
  const { block, usedIds } = buildMemoryBlock(loadMemoryItems());
  markMemoryUsed(usedIds);
  return block;
}

/** 删一条；返回是否真的删掉了（供路由区分 200 与 404）。 */
export function removeMemory(id: string): boolean {
  return getDb().prepare('DELETE FROM user_memory WHERE id = ?').run(id).changes > 0;
}

/** 清空全部画像（记忆页「全部清空」）。 */
export function clearMemory(): number {
  return getDb().prepare('DELETE FROM user_memory').run().changes;
}
