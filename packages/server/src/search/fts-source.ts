/**
 * search/fts-source — **「每种 kind 索引什么」的唯一口径**（契约 `docs/FTS-SPEC.md` §3.2 / §3.3）。
 *
 * ★ 为什么单独成文件（2026-09-20，FTS 批）：`search/fts-index.ts` 收齐写点接线与查询后涨到
 *   **410 行**，触 AGENTS.md「server `.ts` ≤400 行」红线。照仓规**拆文件、不压注释**
 *   ——那些注释记的是「为什么只索引这几个字段」，价值远高于行数。
 *   接缝选在「**读源表定索引内容**」vs「**用索引内容服务查询**」：前者随产品口径变
 *   （该索引哪些字段、哪些记录不该进），后者随检索策略变（MATCH 怎么写、怎么排序），
 *   两类改动几乎不会同时发生（同 `terms.ts` → `term-extract/term-recall` 的判据）。
 *
 * ★ 本文件的返回形状（`SourceRow`）是**索引层与重建函数的公共输入**：
 *   `indexRow` 与 `rebuildSearchIndex` 都只认它，故"哪些字段进索引"改一次就够，
 *   不会出现"增量写点与全量重建口径不一致"（那会导致重建后搜索结果与增量期不同，
 *   而两者本应完全等价）。
 *
 * ⚠️ `readSource` 返回 `null` 表示「这条不该进索引」，**"读不到"与"删掉"必须同义**：
 *   否则源行被删后索引会留下孤儿（搜得到、点进去 404），且直到下次全量重建都不会消失。
 */
import type { FtsKind } from '@sb/shared';
import { FTS_TITLE_CHARS } from '@sb/shared';
import { getDb } from '../storage/db.js';

/** 源表里一条待索引记录：索引层自己回源表读出来的**中间形态**。 */
interface SourceRow {
  refId: string;
  owner: string;
  /** 参与分词的全文（各 kind 口径不同，见 `readSource`） */
  tokensText: string;
  /** 展示主标题（非分词，已单行化 + 截断） */
  title: string;
  /** 摘要的取材原文（未截断，snippet 按查询词现算窗口） */
  snippetSource: string;
  updatedAt: string;
}

/** 把任意原文压成单行：结果列表里一条记录只占一行，换行会把列表撑乱。 */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 生成摘要：以**查询词在原文中的位置**为中心取窗口。
 *
 * ★ 为什么要自己算而不是用 fts5 的 `snippet()`：那个函数的输入是**分词后的 tokens**
 *   （中文 bigram 拼接），输出不可读（FTS-SPEC §3.2）。
 * ★ 为什么要有三级回退：分词是 bigram，用户搜「牛顿第二定律」时，命中可能来自
 *   分散在原文不同位置的 bigram（"牛顿"在一处、"定律"在另一处）⇒ 整体 `indexOf` 会失败。
 *   回退顺序＝整体查询 → 查询的前两字（一个 bigram）→ 第一个拉丁词元 → 取开头。
 * ★ 窗口必须**包含查询词**，否则前端拿 `indexOf` 做高亮时会整条都不亮（用户会以为搜错了）。
 */
export function makeSnippet(text: string, query: string, limit: number): string {
  const flat = flatten(text);
  if (flat.length <= limit) return flat;
  const candidates: string[] = [];
  const q = flatten(query);
  if (q) candidates.push(q);
  if (q.length >= 2) candidates.push(q.slice(0, 2));
  const latin = q.toLowerCase().match(/[a-z][a-z0-9.+-]*/);
  if (latin) candidates.push(latin[0]);
  let pos = -1;
  for (const c of candidates) {
    const at = flat.toLowerCase().indexOf(c.toLowerCase());
    if (at >= 0) {
      pos = at;
      break;
    }
  }
  if (pos < 0) return `${flat.slice(0, limit)}…`;
  const lead = Math.floor((limit - (candidates[0]?.length ?? 0)) / 2);
  const start = Math.max(0, pos - lead);
  const end = Math.min(flat.length, start + limit);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 回源表读一条记录，产出索引中间形态。**这是「每种 kind 索引什么」的唯一口径**。
 *
 * 返回 `null` 表示「这条不该进索引」，各 kind 的理由不同（见下），
 * 调用方据此走删除分支——**"读不到"必须与"删掉"同义**，否则源行被删后索引会留孤儿。
 */
export function readSource(kind: FtsKind, refId: string): SourceRow | null {
  const db = getDb();
  if (kind === 'message') {
    // ★ 索引范围刻意收窄到 user / assistant 且 content 非空：
    //   · `role='tool'` 行装的是**工具返回的原始结果**（网页抓取正文、JSON），
    //     索引它会把大段与用户问题无关的内容灌进来，噪声远大于收益；
    //   · `role='assistant'` 的空行是**流式占位**（persistRounds 先插空串再回填），
    //     没有索引价值。
    // ★ `[QUIZ]` / `[SCENARIO]` 协议登记消息一并排除：出题与情景演练会在会话里落一条
    //   机读登记文本（正文是整段 JSON），索引它的后果是搜索结果里出现
    //   `[QUIZ]{"title":...` 这种不可读片段，而它的正文另有结构化归宿（题库表）。
    //   按 FTS-SPEC §5，题库/资料的检索归 **P2**——P1 不索引协议文本，等 P2 从结构化字段
    //   取题干时再补，那时才能给出可读的结果行。
    // ★ 归属取自父会话（`sessions.user_id`）——messages 表**没有** user_id 列，
    //   「子表随父表」是 TENANCY-SPEC §1 的模型决定（消灭双事实源）。
    // ★ 已软删的会话**不进索引**（`deleted_at IS NULL`）：会话列表里看不见的会话，
    //   它的消息也不该被搜出来——否则"删了还在"是隐私问题不是体验问题。
    const row = db
      .prepare(
        `SELECT m.id AS ref_id, m.content AS content, m.created_at AS updated_at, s.user_id AS user_id
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.id = ? AND m.role IN ('user','assistant') AND m.content <> ''
            AND m.content NOT LIKE '[QUIZ]%' AND m.content NOT LIKE '[SCENARIO]%'
            AND s.deleted_at IS NULL`,
      )
      .get(refId) as { ref_id: string; content: string; updated_at: string | null; user_id: string | null } | undefined;
    if (!row) return null;
    const flat = flatten(row.content);
    return {
      refId: row.ref_id,
      owner: row.user_id ?? '',
      tokensText: row.content,
      title: flat.slice(0, FTS_TITLE_CHARS),
      snippetSource: row.content,
      updatedAt: row.updated_at ?? '',
    };
  }
  if (kind === 'term') {
    // ★ 词条要索引**三样**：term + definition + aliases。
    //   aliases 尤其不能漏——它是 AI 整理判定的同一概念的另一种写法（"闭包" 与 "closure"），
    //   用户按别名搜是**完全合理**的用法，只索引主名会让一半词条搜不到。
    const row = db
      .prepare(
        `SELECT id AS ref_id, term, definition, aliases, owner_id AS owner, updated_at
           FROM term_library WHERE id = ?`,
      )
      .get(refId) as
      | { ref_id: string; term: string; definition: string; aliases: string | null; owner: string; updated_at: string | null }
      | undefined;
    if (!row) return null;
    let aliasText = '';
    if (row.aliases) {
      try {
        const v = JSON.parse(row.aliases) as unknown;
        if (Array.isArray(v)) aliasText = v.filter((x): x is string => typeof x === 'string').join(' ');
      } catch {
        aliasText = ''; // 坏 JSON 不毁索引（ADR-4 降级），只是少了别名召回
      }
    }
    return {
      refId: row.ref_id,
      owner: row.owner,
      tokensText: `${row.term} ${row.definition} ${aliasText}`,
      title: flatten(row.term).slice(0, FTS_TITLE_CHARS),
      snippetSource: row.definition,
      updatedAt: row.updated_at ?? '',
    };
  }
  // note（错题本）
  // ★ 索引 `quiz_title` + **题干** + `body`（心得），**不索引 `question_data` 原始 JSON**：
  //   那串 JSON 里含选项、正确答案、解析，整串灌进去会让「搜一个选项词」命中一堆题，
  //   而且搜出来的 snippet 是 `{"options":[...` 这种不可读的东西。
  //   ⇒ 先解析出 `question` 字段再索引，是本 kind 唯一需要"读懂 JSON"的地方。
  const row = db
    .prepare(
      `SELECT id AS ref_id, quiz_title, question_data, body, owner_id AS owner, updated_at
         FROM quiz_notes WHERE id = ?`,
    )
    .get(refId) as
    | {
        ref_id: string;
        quiz_title: string;
        question_data: string;
        body: string;
        owner: string;
        updated_at: string | null;
      }
    | undefined;
  if (!row) return null;
  let question = '';
  try {
    const q = JSON.parse(row.question_data) as { question?: unknown };
    if (typeof q.question === 'string') question = q.question;
  } catch {
    question = ''; // 坏 JSON 不毁索引：至少 title 与 body 仍可搜
  }
  const body = row.body ?? '';
  return {
    refId: row.ref_id,
    owner: row.owner,
    tokensText: `${row.quiz_title} ${question} ${body}`,
    // 错题本里用户找的是「那道题」，故主标题取题干；题干缺失（坏快照）才退到套题名
    title: flatten(question || row.quiz_title).slice(0, FTS_TITLE_CHARS),
    snippetSource: body || question || row.quiz_title,
    updatedAt: row.updated_at ?? '',
  };
}
