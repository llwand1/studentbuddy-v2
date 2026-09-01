/**
 * learning/terms — AI 自动词条库（忆域 v2，2026-09-01 契约）。
 * 取代旧「手动词条 + SRS 翻卡」（memorize/srs 已废弃）。
 *
 * 机制：
 *  1. 抽取：每轮对话/手动触发 → extractTerms 调 LLM 从材料中抽「重要术语」
 *     （英语单词 / 专业术语），[TERMS] JSON 协议，失败降级不崩（ADR-4）。
 *  2. 入库：saveTerms 按 UNIQUE(term, domain) 合并——同词条取更高 importance、更新释义。
 *  3. 使用：getRelevantTerms 按关键词重叠度 + 重要度 + 近期使用排序，注入后续对话
 *     （flow.ts 软性提示 AI 优先使用，保持自然）。
 *  4. 计数：countUsage 扫描已完成回复命中词条，累积 usage_count（反馈「记住了多少」）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { publishEvent } from '../events/bus.js';

export interface TermItem {
  id?: string;
  term: string;
  definition: string;
  domain?: string;
  sourceSessionId?: string | null;
  importance?: number;
}

export interface TermRow {
  id: string;
  term: string;
  definition: string;
  domain: string;
  source_session_id: string | null;
  importance: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const TERMS_PROTOCOL = `你是术语抽取引擎。从给定材料中抽取学习者应当记住的重要术语（英语单词 / 专业术语），严格按以下 JSON 格式输出，输出外围包一对 [TERMS]...[/TERMS] 标记：
[TERMS]{"terms":[{"term":"术语或单词","definition":"精炼中文释义（英语单词可含词性/例句要点；专业术语给准确定义）","domain":"english 或学科名如 math/cs/生物/化学 等，无法归类用 general","importance":0到1的数值，越核心越高}]}[/TERMS]
规则：只抽对学习有价值的术语，通常 3-8 条；term 用原文（英文单词保留英文，中文术语用中文）；definition 精炼准确；除该 JSON 外不要输出任何其他文字。`;

/** 解析模型输出中的 [TERMS] JSON（容错：多行/围栏/前后杂质；失败返回 [] 走降级） */
export function parseTermsBlock(text: string): TermItem[] {
  const m = text.match(/\[TERMS\]([\s\S]*?)\[\/TERMS\]/);
  let raw = m ? m[1] : '';
  if (!raw && text.includes('"terms"')) raw = text;
  if (!raw) return [];
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return [];
  try {
    const data = JSON.parse(objMatch[0]) as { terms?: TermItem[] };
    return normalizeTerms(data.terms ?? []);
  } catch {
    return [];
  }
}

/** 校验规范化：丢弃无 term/definition 的条目；importance 钳到 0-1。 */
export function normalizeTerms(items: TermItem[]): TermItem[] {
  const out: TermItem[] = [];
  for (const t of items ?? []) {
    const term = t.term?.trim();
    const definition = t.definition?.trim();
    if (!term || !definition) continue;
    const importance = Number(t.importance);
    out.push({
      term,
      definition,
      domain: (t.domain ?? '').trim().toLowerCase().slice(0, 30) || 'general',
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
    });
  }
  return out;
}

/** 一键抽取（材料 → 词条列表）；返回 [] 表示失败（降级由调用方处理）。 */
export async function extractTerms(material: string): Promise<TermItem[]> {
  if (!material?.trim()) return [];
  const target = routeRole('explain'); // 抽取复用讲解角色模型；契约留扩展点：可拆独立 extractor 角色
  if (!target || !target.model) return [];
  let acc = '';
  const prompt = `${TERMS_PROTOCOL}\n\n材料：\n${material.slice(0, 30000)}`;
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: prompt }],
    })) {
      acc += chunk.content;
      if (chunk.done) break;
    }
  } catch {
    return [];
  }
  return parseTermsBlock(acc);
}

/** 入库（UNIQUE(term,domain) 合并）：同词条保留更高 importance、更新释义；返回入库条数。 */
export function saveTerms(items: TermItem[], sourceSessionId?: string | null): number {
  const db = getDb();
  const norm = normalizeTerms(items);
  if (norm.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO term_library (id, term, definition, domain, source_session_id, importance)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, domain) DO UPDATE SET
       definition = CASE WHEN excluded.importance >= term_library.importance THEN excluded.definition ELSE term_library.definition END,
       importance = MAX(term_library.importance, excluded.importance),
       source_session_id = COALESCE(term_library.source_session_id, excluded.source_session_id),
       updated_at = datetime('now')`,
  );
  const tx = db.transaction(() => {
    for (const t of norm) {
      insert.run(randomUUID(), t.term, t.definition, t.domain, sourceSessionId ?? null, t.importance ?? 0.5);
    }
  });
  tx();
  publishEvent({ type: 'term_added', count: norm.length });
  return norm.length;
}

/** 手动存一条（列表页「添加」按钮），已存在则更新释义与重要度。 */
export function saveOneTerm(term: string, definition: string, domain?: string): TermRow {
  const db = getDb();
  const d = (domain ?? '').trim().toLowerCase().slice(0, 30) || 'general';
  db.prepare(
    `INSERT INTO term_library (id, term, definition, domain, importance)
     VALUES (?, ?, ?, ?, 0.5)
     ON CONFLICT(term, domain) DO UPDATE SET definition = excluded.definition, updated_at = datetime('now')`,
  ).run(randomUUID(), term.trim(), definition.trim(), d);
  const row = db
    .prepare('SELECT * FROM term_library WHERE term = ? AND domain = ?')
    .get(term.trim(), d) as TermRow;
  return row;
}

/** 词条列表（可按 domain 过滤；keyword 对 term 前缀模糊；JOIN 来源会话标题供 UI 展示）。 */
export function listTerms(domain?: string, keyword?: string): Array<TermRow & { source_title: string | null }> {
  const db = getDb();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (domain && domain !== 'all') {
    conds.push('t.domain = ?');
    args.push(domain);
  }
  if (keyword?.trim()) {
    conds.push('t.term LIKE ?');
    args.push(`${keyword.trim()}%`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT t.*, s.title AS source_title FROM term_library t
       LEFT JOIN sessions s ON s.id = t.source_session_id
       ${where} ORDER BY t.importance DESC, t.usage_count DESC, t.updated_at DESC LIMIT 500`,
    )
    .all(...args) as Array<TermRow & { source_title: string | null }>;
}

/** 领域统计（前端 Tab + 顶部统计）。 */
export function domainStats(): { total: number; domains: Array<{ domain: string; count: number }>; today: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  const domains = db
    .prepare('SELECT domain, COUNT(*) AS count FROM term_library GROUP BY domain ORDER BY count DESC')
    .all() as Array<{ domain: string; count: number }>;
  const today = (
    db.prepare("SELECT COUNT(*) AS c FROM term_library WHERE created_at >= date('now')").get() as { c: number }
  ).c;
  return { total, domains, today };
}

/** 删除词条。 */
export function removeTerm(id: string): void {
  getDb().prepare('DELETE FROM term_library WHERE id = ?').run(id);
}

/** 编辑词条（列表页编辑：释义/领域/重要度）。 */
export function updateTerm(id: string, patch: { definition?: string; domain?: string; importance?: number }): TermRow | null {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM term_library WHERE id = ?').get(id) as TermRow | undefined;
  if (!cur) return null;
  const importance = patch.importance === undefined ? cur.importance : Math.min(1, Math.max(0, Number(patch.importance)));
  const domain = patch.domain?.trim().toLowerCase().slice(0, 30) || cur.domain;
  const definition = patch.definition?.trim() || cur.definition;
  db.prepare('UPDATE term_library SET definition = ?, domain = ?, importance = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
    definition,
    domain,
    importance,
    id,
  );
  return db.prepare('SELECT * FROM term_library WHERE id = ?').get(id) as TermRow;
}

// ── 检索与使用计数（flow.ts 注入用）──

/** 轻量分词：英文按单词/驼峰切，中文按连续片段。 */
function tokens(s: string): string[] {
  const en = s.match(/[A-Za-z][A-Za-z0-9]+/g) ?? [];
  const cn = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...en, ...cn];
}

/**
 * 相关性打分：term 直接出现在 query 里权重最高；否则 query 词元与 term 互相包含加分。
 * 无直接匹配返回 0（不相关）；有匹配后加 AI 重要度（×0.8）与近期使用（×0.3）作排序权重。
 * 零依赖、无向量库。
 */
function score(query: string, row: TermRow): number {
  const q = query.toLowerCase();
  const t = row.term.toLowerCase();
  let s = 0;
  if (q.includes(t) || t.includes(q)) s += 2.0;
  else {
    for (const tk of tokens(q)) {
      if (tk.length >= 2 && (t.includes(tk.toLowerCase()) || tk.toLowerCase().includes(t))) {
        s += 0.5;
        break;
      }
    }
  }
  if (s <= 0) return 0; // 无直接匹配 → 不相关，不参与注入
  s += (row.importance ?? 0.5) * 0.8;
  if (row.last_used_at) s += 0.3; // 近期用过的小幅加权（学生刚学的内容更可能接着问）
  return s;
}

/** 检索与 query 相关的 Top-K 词条（供对话注入）。 */
export function getRelevantTerms(query: string, limit = 15): TermRow[] {
  if (!query?.trim()) return [];
  const rows = getDb().prepare('SELECT * FROM term_library').all() as TermRow[];
  return rows
    .map((r) => ({ r, s: score(query, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

/** 回复完成后扫描命中词条：usage_count+1、last_used_at 更新（反馈「真正用上了」）。 */
export function countUsage(replyText: string): number {
  if (!replyText?.trim()) return 0;
  const rows = getDb().prepare('SELECT id, term FROM term_library').all() as Array<{ id: string; term: string }>;
  const db = getDb();
  const upd = db.prepare('UPDATE term_library SET usage_count = usage_count + 1, last_used_at = datetime(\'now\') WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.term && replyText.includes(r.term)) upd.run(r.id);
    }
  });
  tx();
  return rows.filter((r) => r.term && replyText.includes(r.term)).length;
}
