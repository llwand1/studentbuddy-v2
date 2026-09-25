/**
 * search/fts-index — 全站全文搜索的**索引层**（契约 `docs/FTS-SPEC.md` §3）。
 *
 * ⚠️ 本目录下有两个同名概念，别混：`search/index.ts` 是**联网搜索**（`search_web` 工具，
 *    走 exa/tavily 外部 API + SSRF 守卫）；**本文件**是**本地库全文检索**（SQLite fts5）。
 *    两者零调用关系，只是恰好都叫 "search"。
 *
 * ── 三条硬约束（FTS-SPEC §2，决定了本文件的一切形状）──────────────────────────
 *
 * ① **零新依赖**：只用 better-sqlite3 自带的 SQLite（本机实测 3.49.2，`ENABLE_FTS5` 已编译，
 *    见 FTS-SPEC §8 的实跑记录）。禁引分词器 / spellchecker / 向量库。
 * ② **派生索引，真相在源表**：`search_index` 是影子表，可随时全量重建；
 *    **任何查询路径不得从索引表读业务字段**——索引坏了降级为「搜不到」而不是「搜错」。
 *    故本文件**只从源表读**，索引表只用来 MATCH + 出 snippet/title 快照。
 * ③ **鉴权关闭时行为不变**：未登录（`ownerId === null`）的可见性见 `searchAll` 内的
 *    分档 WHERE（★ 那两行是本文件最需要小心的地方，改动前先读 TENANCY-SPEC §8）。
 *
 * ── 为什么写点只传 `(kind, refId)` ────────────────────────────────────────────
 *
 * `indexRow(kind, refId)` **自己回源表读**要索引的字段，调用方只报"哪一行变了"。
 * 这样做的两个理由，都是冲着「漏写点 / 漏字段」这两类静默故障去的：
 *   · **口径集中**：每种 kind 索引哪些字段（含"不该索引哪些"）只在本文件一处；
 *     若让每个写点自己拼 tokens，`messages` 有 8 个写点就要抄 8 遍口径，漏一处 = 那类
 *     记录永久搜不到，且不报错。
 *   · **写点极简**：调用方只需加一行 `indexRow('term', id)`，改动面小到不容易漏。
 *
 * ⚠️ **同步方式是「写侧显式维护」不是触发器**（FTS-SPEC §3.3）：SQL 触发器**调不到 JS
 *    分词函数**（better-sqlite3 不暴露 fts5 自定义 tokenizer 注册），触发器只与内置
 *    trigram 分词器兼容——而 trigram 因「中文双字词不可查」已被 §1 排除。选型锁死了同步方式。
 *
 * ⚠️ **绕过 server 直接写库的脚本不会同步索引**（`tools/`、`_probe/` 里那些，如
 *    `claim-legacy.mjs`）。这正是留全量重建函数（`rebuildSearchIndex`）的原因。
 */
import type { FtsHit, FtsKind } from '@sb/shared';
import { buildFtsMatch, FTS_KINDS, FTS_SNIPPET_CHARS, FTS_TOP_K, tokenizeForFts } from '@sb/shared';
import { getDb } from '../storage/db.js';
// ★ 索引内容口径（每种 kind 索引哪些字段）与摘要算法已拆到 `fts-source.ts`——见该文件头注
//   的拆分理由（本文件收齐写点接线与查询后涨到 410 行，触 server 400 行红线）。
import { makeSnippet, readSource } from './fts-source.js';

/**
 * 索引行落库（upsert）。**各源表的每个写点末尾都要调它**（FTS-SPEC §3.3）。
 *
 * ★ 与源表写入**同事务**：better-sqlite3 默认单连接串行，成本为零，
 *   换掉「最终一致」那套复杂度（索引落后于源表的那段时间里，用户搜到的是过期结果）。
 *   ⇒ 调用方**不要**自己开新事务包它，跟着源表的事务走即可。
 * ★ fts5 虚表**没有主键、不支持 `INSERT OR REPLACE`**（无唯一约束可冲突），
 *   故 upsert 只能写成「先按 (kind, ref_id) 删、再插」两步。
 * ★ 源行读不到（已删除 / 不满足索引条件）⇒ 走删除分支。**这个 fallback 不是可选的**：
 *   少了它，`DELETE FROM messages` 之后索引里会永远留着那条孤儿，且 rebuild 之前都不会消失。
 */
export function indexRow(kind: FtsKind, refId: string): void {
  const src = readSource(kind, refId);
  const db = getDb();
  db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
  if (!src) return;
  db.prepare(
    `INSERT INTO search_index (tokens, kind, ref_id, owner, title, snippet, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenizeForFts(src.tokensText).join(' '),
    kind,
    src.refId,
    src.owner,
    src.title,
    // 写侧不知道查询词（同一行会被无数种查询命中），故此处存**原文前段**作兜底；
    // 真正的「命中处附近」窗口由 searchAll 在查询期用 makeSnippet 现算。
    makeSnippet(src.snippetSource, '', FTS_SNIPPET_CHARS),
    src.updatedAt,
  );
}

/** 删索引行（源行被删时调用）。幂等：删不存在的行是 no-op。 */
export function dropRow(kind: FtsKind, refId: string): void {
  getDb().prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
}

/**
 * 会话级联删索引（会话被软删时调用，FTS-SPEC §4 的 ★ 条目）。
 *
 * ★ 为什么必须显式做：`messages` 表的行**不会**随会话删除而消失（sessions 是软删，
 *   见 `routes.ts` 的 `UPDATE sessions SET deleted_at = …`），所以索引行也不会自己消失。
 *   不级联的后果是「删掉的会话，其消息仍能被搜出来并跳转到一个 404 的会话」。
 * ★ 用 `IN (SELECT …)` 一次删干净，不要拉出 id 列表再逐个删（本地库量级虽小，
 *   但一次 SQL 更不容易写出"删了一半崩了"的中间态）。
 */
export function dropSessionMessages(sessionId: string): void {
  getDb()
    .prepare(`DELETE FROM search_index WHERE kind = 'message' AND ref_id IN (SELECT id FROM messages WHERE session_id = ?)`)
    .run(sessionId);
}

/** 索引行数（`ensureSearchIndex` 与测试用）。 */
export function countIndexRows(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM search_index').get() as { n: number };
  return row.n;
}

/**
 * 全量重建索引（v37 之后**首次启动**的灌入路径，也是索引疑似损坏时的兜底）。
 *
 * ★ **为什么必须存在**：绕过 server 直接写库的脚本（`tools/probes/*`、`_probe/*`）
 *   不会走写点 ⇒ 它们的写入不进索引。这是「写侧显式维护」方案的已知代价，
 *   重建函数就是它的对价（FTS-SPEC §3.3 明确接受）。
 * ★ **为什么必须过滤已软删会话**：`messages` 表里留着已删会话的消息，全量重建若不过滤，
 *   会把它们**重新灌回索引**——即「删了又活了」，比不删更糟（用户会以为删除没生效）。
 * ★ 在一个事务里做：中途失败回滚到旧索引，不会留下"清空了但没灌完"的空壳。
 */
export function rebuildSearchIndex(): number {
  const db = getDb();
  let n = 0;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM search_index').run();
    const insert = db.prepare(
      `INSERT INTO search_index (tokens, kind, ref_id, owner, title, snippet, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const put = (kind: FtsKind, refId: string): void => {
      const src = readSource(kind, refId);
      if (!src) return;
      insert.run(
        tokenizeForFts(src.tokensText).join(' '),
        kind,
        src.refId,
        src.owner,
        src.title,
        makeSnippet(src.snippetSource, '', FTS_SNIPPET_CHARS),
        src.updatedAt,
      );
      n += 1;
    };
    const msgIds = db
      .prepare(
        `SELECT m.id AS id FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.role IN ('user','assistant') AND m.content <> ''
            AND m.content NOT LIKE '[QUIZ]%' AND m.content NOT LIKE '[SCENARIO]%'
            AND s.deleted_at IS NULL`,
      )
      .all() as Array<{ id: string }>;
    for (const r of msgIds) put('message', r.id);
    const termIds = db.prepare('SELECT id FROM term_library').all() as Array<{ id: string }>;
    for (const r of termIds) put('term', r.id);
  });
  tx();
  return n;
}

/**
 * 启动兜底：索引为空就灌一遍（**不是**每次启动都重建）。
 *
 * ★ 为什么用「空则灌」而不是「每次都灌」：全量重建在 ~10⁴ 行量级是百毫秒级
 *   （FTS-SPEC §7 预言 1 给出 <2s 的上界），每次启动白跑一遍纯属浪费；
 *   而用「空则灌」正好覆盖**唯一必须灌的那次**——老库升级到 v37 后第一次启动
 *   （v37 只建了空表，历史数据要靠这一步进索引）。
 * ★ 已知局限（诚实记账）：若索引**非空但不全**（例如上次进程崩在写点与提交之间），
 *   本函数不会自动修复——需要手工调 `rebuildSearchIndex()`。全量校验的代价（每次启动
 *   逐表 count 比对）对本地单用户场景不划算，故不做（FTS-SPEC §5「明确不做」精神）。
 */
export function ensureSearchIndex(): number {
  if (countIndexRows() > 0) return 0;
  return rebuildSearchIndex();
}

/**
 * 全站检索（`GET /api/search` 的实现在 `routes/search.ts`，本函数只做 SQL）。
 *
 * ★★ **本函数是全仓最需要小心的一处可见性判据**（FTS-SPEC §2 硬约束 3 的 landmine）。
 *   未登录（`ownerId === null`）时**不能**统一用 `owner = ''`：
 *   · `message` 的 owner 冗余自 `sessions.user_id`，而未登录模式下**历史会话可能是
 *     `NULL`/`''`、也可能是某个用户 id**（过渡期库里两者并存）。若统一按 `owner = ''`
 *     过滤，未登录用户会**搜不到自己以前聊过的内容**——「本地单人模式行为不变」当场破。
 *     故 message 在未登录时**不过滤**（等价于今天 `sessions` 列表的 `ownerFilter(null)`）。
 *   · `term` 的 owner 是 `ownerForWrite` 写的（`''` = 无主），
 *     未登录模式下**全部数据本来就是无主行** ⇒ 按 `owner = ''` 过滤即"看到自己的全部"，
 *     同时天然挡住过渡期里别的用户写入的行（那正是 M2d 系列表要防的跨用户泄露）。
 *   ⇒ 两档合起来写成一条 SQL：`kind = 'message' OR owner = ?`。
 * ★ 认证态下**一律** `owner = ?`（不含 `''`）：无主行"谁都不泄露"是 M2d 的既定口径
 *   （`migrations-list-v31.ts` 头注：无主 = 谁都看不见，主人用 `_claim-legacy` 认领）。
 * ★ 空 MATCH 直接短路返回空数组：fts5 的 `MATCH ''`（以及纯空白串）会抛
 *   `SqliteError: fts5: syntax error near ""` ⇒ 不短路的话，用户敲几个空格就是 500。
 *   （实测见 `tools/probes/fts-capability.mjs` §5。）
 * ★ `bm25()` 越小越相关（负的成本值），故 `ORDER BY score` 升序，**不加 DESC**。
 */
export function searchAll(
  q: string,
  opts: { kinds?: FtsKind[]; ownerId: string | null; limit?: number } = { ownerId: null },
): FtsHit[] {
  const match = buildFtsMatch(tokenizeForFts(q));
  if (!match) return [];
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? FTS_TOP_K)), FTS_TOP_K);
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : ([...FTS_KINDS] as FtsKind[]);
  const placeholders = kinds.map(() => '?').join(', ');
  const db = getDb();
  const sql =
    opts.ownerId === null
      ? `SELECT kind, ref_id, owner, title, snippet, updated_at, bm25(search_index) AS score
           FROM search_index
          WHERE search_index MATCH ? AND kind IN (${placeholders}) AND (kind = 'message' OR owner = '')
          ORDER BY score LIMIT ?`
      : `SELECT kind, ref_id, owner, title, snippet, updated_at, bm25(search_index) AS score
           FROM search_index
          WHERE search_index MATCH ? AND kind IN (${placeholders}) AND owner = ?
          ORDER BY score LIMIT ?`;
  const args: unknown[] = [match, ...kinds];
  if (opts.ownerId !== null) args.push(opts.ownerId);
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Array<{
    kind: string;
    ref_id: string;
    owner: string;
    title: string;
    snippet: string;
    updated_at: string;
    score: number;
  }>;
  // 命中处的 snippet 在**查询期**现算（写侧不知道将来谁会来搜什么），
  // 并顺带补上跳转定位信息（message 要跳会话）。
  const sessionOf = db.prepare('SELECT session_id FROM messages WHERE id = ?');
  return rows.map((r) => {
    const kind = r.kind as FtsKind;
    // ★★ snippet **必须在查询期用查询词现算**，不能直接用索引里那一列：
    //   写侧不知道将来谁会来搜什么（同一行会被无数种查询命中），它存的是**原文前段**，
    //   只作源行读不到时的兜底。不重算的话，命中落在原文 200 字处的记录，
    //   摘要会显示开头那段**不含查询词**的文字 ⇒ 前端 `indexOf` 高亮整条不亮
    //   ⇒ 用户看到的是"搜出来的东西跟我的关键词没关系"（比搜不到更让人困惑）。
    //   代价是每条命中多一次源表读（≤20 条，本地库 <1ms/次），换来的是摘要必然含命中词。
    const src = readSource(kind, r.ref_id);
    const hit: FtsHit = {
      kind,
      refId: r.ref_id,
      title: r.title,
      snippet: src ? makeSnippet(src.snippetSource, q, FTS_SNIPPET_CHARS) : r.snippet,
      updatedAt: r.updated_at,
      score: r.score,
    };
    if (kind === 'message') {
      const s = sessionOf.get(r.ref_id) as { session_id: string } | undefined;
      if (s) hit.parentId = s.session_id;
    }
    return hit;
  });
}
