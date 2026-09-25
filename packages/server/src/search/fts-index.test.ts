/**
 * search/fts-index — 全站搜索**索引层**的门禁（契约 `docs/FTS-SPEC.md` §6）。
 *
 * 本文件锁三件事，每件对应一类"不报错的静默故障"：
 *
 * ① **两侧分词一致**（§6 第 1 行）：索引侧与查询侧共用 `tokenizeForFts`。切法一旦分叉，
 *    症状是「库里有、就是搜不到」——不报错、不崩溃，只是召回静默变空。
 * ② **写点全覆盖**（§6 第 3 行）：每类源表都**走真实写函数**跑一遍 insert→update→delete，
 *    再断言 `searchAll` 的结果跟着变。★ 这一条是 FTS-SPEC §7 预言 3 的落点——
 *    漏接任一写函数，本文件**首跑即红**，比人工 grep 可靠（写点清单以它为准）。
 * ③ **索引范围与级联**：不该进的（tool 行 / 协议消息 / 已软删会话）不进，
 *    该删的（源行删除、会话软删）立刻删——否则留下「搜得到、点进去 404」的幽灵结果。
 *
 * ★ 测试一律走 `openIsolated` 的**临时库**，绝不碰真库（`tools/probes/db-isolation-check.mjs`
 *   的纪律）。临时目录名带 `sb-fts-test-` 前缀，便于排查时识别。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fts-test-'));

const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const { searchAll, rebuildSearchIndex, countIndexRows, indexRow, dropSessionMessages } = await import('./fts-index.js');
const { saveOneTerm, saveTerms, updateTerm, removeTerm } = await import('../learning/terms.js');
const { mergeTerms } = await import('../learning/tidy.js');
const { logTermDeletions, undoDeleteBatch, selectTermRowsForSnapshot } = await import('../storage/term-delete-log.js');
const { insertUserMessage, insertAssistantMessage, dropMessagesAfter, updateMessageContent } =
  await import('../chat/persist.js');
const { insertSession } = await import('../auth/ownership.js');
const { tokenizeForFts, buildFtsMatch, FTS_TITLE_CHARS } = await import('@sb/shared');

openIsolated(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fts-db-')));
afterAll(() => closeDb());

/** 取首元素；空数组直接抛（替代 `!` 非空断言——本仓 `no-non-null-assertion` 对测试同样生效） */
function first<T>(arr: T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error('期望至少一条结果，实际为空');
  return v;
}

/** 造一个会话（messages 有外键，消息必须挂在存在的会话下） */
function mkSession(id: string, userId: string | null): void {
  insertSession(id, userId);
}

const U1 = 'u-fts-1';
const U2 = 'u-fts-2';

describe('search/fts-index — 分词与 MATCH 表达式', () => {
  it('中文按 bigram 切，长度为 1 的连续串保留单字', () => {
    expect(tokenizeForFts('牛顿第二定律')).toEqual(['牛顿', '顿第', '第二', '二定', '定律']);
    expect(tokenizeForFts('熵')).toEqual(['熵']);
  });

  it('英文/数字按词切，大小写不敏感（统一小写后匹配）', () => {
    expect(tokenizeForFts('Closure F=ma 9.8')).toEqual(expect.arrayContaining(['closure', 'f', 'ma', '9.8']));
  });

  it('★ 词元一律用双引号包成字面量：c++ / -牛顿 这类含 fts5 语法字符的输入不许漏出去', () => {
    // 不转义的后果是**语法错误 ⇒ 500**（实测：`MATCH 'c++'` → syntax error near "+"；
    // `MATCH '-牛顿'` → no such column；`MATCH ''` → syntax error near ""）。
    // ★ fts5 的 NOT 只能做二元运算符（`a NOT b`），**没有 `-term` 前缀简写** ⇒
    // 这里锁的不是"语义反转"（那个说法是错的，已按 tools/probes/fts-capability.mjs §5 订正），
    // 而是"用户输一个 `+` 就能把接口打成 500"。
    expect(buildFtsMatch(['c++'])).toBe('"c++"');
    expect(buildFtsMatch(['-牛顿'])).toBe('"-牛顿"');
    expect(buildFtsMatch(['node.js', '闭包'])).toBe('"node.js" AND "闭包"');
  });

  it('空词元 → 空串（调用方据此短路，不发 SQL：fts5 的 MATCH 空串是语法错误 ⇒ 不短路就是 500）', () => {
    expect(buildFtsMatch([])).toBe('');
    expect(buildFtsMatch(['', ''])).toBe('');
    expect(searchAll('   ', { ownerId: null })).toEqual([]);
  });

  it('多词元用 AND 连接、且去重（同一词元出现两次不该让 fts5 重复算一遍）', () => {
    expect(buildFtsMatch(['闭包', '闭包', 'js'])).toBe('"闭包" AND "js"');
  });
});

describe('search/fts-index — 词条写点全覆盖', () => {
  it('saveOneTerm（新增）→ 立刻可搜到', () => {
    const row = saveOneTerm('牛顿第二定律', '物体加速度与合外力成正比', '物理', U1);
    const hits = searchAll('牛顿', { kinds: ['term'], ownerId: U1 });
    expect(hits.map((h) => h.refId)).toContain(row.id);
  });

  it('★ saveOneTerm（命中已有）→ 走 UPDATE 分支，索引内容跟着变（不是幽灵）', () => {
    const row = saveOneTerm('动量守恒', '旧释义占位', '物理', U1);
    saveOneTerm('动量守恒', '系统不受外力时总动量不变', '物理', U1);
    // 新释义可搜
    expect(searchAll('总动量', { kinds: ['term'], ownerId: U1 }).map((h) => h.refId)).toContain(row.id);
    // 旧释义搜不到（索引被整体替换，不是追加）
    expect(searchAll('旧释义占位', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
  });

  it('saveTerms（批量 upsert）→ 可搜到；并入已有行时不会留下第二条索引', () => {
    saveTerms([{ term: '加速度', definition: '速度变化率', domain: '物理' }], null, U1);
    expect(searchAll('速度变化率', { kinds: ['term'], ownerId: U1 }).length).toBeGreaterThan(0);
    // 同词同域再存一次 → 走 mergeInto 分支，索引仍只有一条
    saveTerms([{ term: '加速度', definition: '速度变化率（并入）', domain: '物理' }], null, U1);
    expect(searchAll('速度变化率', { kinds: ['term'], ownerId: U1 })).toHaveLength(1);
  });

  it('★ 别名可搜（索引文本 = term + definition + aliases）', () => {
    const row = saveOneTerm('闭包', '能访问外层作用域变量的函数', '编程', U1);
    // 直接给该行补一个别名（走真实 UPDATE 写点）
    getDb().prepare(`UPDATE term_library SET aliases = ? WHERE id = ?`).run(JSON.stringify(['closure']), row.id);
    indexRow('term', row.id);
    expect(searchAll('closure', { kinds: ['term'], ownerId: U1 }).map((h) => h.refId)).toContain(row.id);
  });

  it('updateTerm（改释义）→ 新释义可搜、旧释义搜不到', () => {
    const row = saveOneTerm('虚数单位', '记为 i，满足 i² = -1', '数学', U1);
    updateTerm(row.id, { definition: '平方等于负一的数' }, U1);
    expect(searchAll('平方等于负一', { kinds: ['term'], ownerId: U1 }).map((h) => h.refId)).toContain(row.id);
    expect(searchAll('记为', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
  });

  it('removeTerm → 索引行立刻消失（不留「搜得到、点进去 404」的幽灵）', () => {
    const row = saveOneTerm('临时词条甲', '这条马上会被删掉', '测试', U1);
    expect(searchAll('这条马上会被删掉', { kinds: ['term'], ownerId: U1 })).toHaveLength(1);
    removeTerm(row.id, U1);
    expect(searchAll('这条马上会被删掉', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
  });

  it('★ mergeTerms（整理合并）→ 被并入行的别名并进保留行，可搜；被并入行自己搜不到', () => {
    saveOneTerm('超文本标记语言', 'HTML 的中文全称', '编程', U1);
    saveOneTerm('HTML', 'HyperText Markup Language', '编程', U1);
    mergeTerms(['超文本标记语言', 'HTML'], U1);
    // 合并后：保留行的索引文本含两边的词，故两个词都能搜到同一条
    const byCn = searchAll('超文本标记语言', { kinds: ['term'], ownerId: U1 });
    const byEn = searchAll('HTML', { kinds: ['term'], ownerId: U1 });
    expect(byCn).toHaveLength(1);
    expect(byEn).toHaveLength(1);
    expect(first(byCn).refId).toBe(first(byEn).refId);
  });

  it('★ 撤销删除（undoDeleteBatch）→ 撤回来的词条立刻可搜（不同步会让用户以为撤销没生效）', () => {
    const row = saveOneTerm('撤销词条乙', '被删掉又撤回来', '测试', U1);
    // 快照必须是**从库里 SELECT * 出来的整行**（`aliases` 是 JSON 字符串）——
    // 直接传 API 形状（`aliases: string[]`）会在 bind 阶段报「只能绑定数字/字符串/null」
    const rows = selectTermRowsForSnapshot([row.id], U1);
    const { batch } = logTermDeletions({ rows, actor: 'ui', tool: null, ownerId: U1 });
    removeTerm(row.id, U1);
    expect(searchAll('被删掉又撤回来', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
    undoDeleteBatch(batch, U1);
    expect(searchAll('被删掉又撤回来', { kinds: ['term'], ownerId: U1 })).toHaveLength(1);
  });
});

describe('search/fts-index — 已下线的 note 类不再进结果', () => {
  // 刷题笔记 2026-09-25 整族下线：`search_index` 里 v37~v44 期间写入的 `kind='note'` 旧行
  // 不会自动消失（DROP 要等 v45），查询侧的 `kind IN (...)` 是它们唯一的过滤器。
  // ★ 这条锁的就是那道过滤器：一旦有人把 kinds 默认值改回"透传"，旧笔记行会带着
  //   读不到的源行浮出来（snippet 退化成索引里那份过期原文）。
  it('★ 手工塞一条 kind=note 的索引行 → 任何检索都读不到它', () => {
    const db = getDb();
    // owner 刻意写成 U1：否则挡住它的是归属过滤，这条锁就成了空锁。
    db.prepare(
      `INSERT INTO search_index (tokens, kind, ref_id, owner, title, snippet, updated_at)
       VALUES (?, 'note', 'legacy-note-row', ?, '虚拟语气的核心特征是什么', '陈旧笔记行', '')`,
    ).run(tokenizeForFts('虚拟语气的核心特征是什么').join(' '), U1);
    expect(searchAll('虚拟语气的核心特征', { ownerId: U1 }).map((h) => h.refId)).not.toContain('legacy-note-row');
    expect(searchAll('虚拟语气的核心特征', { kinds: [], ownerId: U1 })).toHaveLength(0);
    db.prepare(`DELETE FROM search_index WHERE kind = 'note'`).run();
  });
});

describe('search/fts-index — 消息写点全覆盖与索引范围', () => {
  it('insertUserMessage / insertAssistantMessage → 都可搜到，且带 parentId 供跳转', () => {
    mkSession('s-fts-a', U1);
    insertUserMessage('s-fts-a', '光合作用的暗反应阶段叫什么', []);
    insertAssistantMessage({ sessionId: 's-fts-a', content: '暗反应也叫卡尔文循环', tokens: 10 });
    const userHit = first(searchAll('暗反应阶段叫什么', { kinds: ['message'], ownerId: U1 }));
    const aiHit = first(searchAll('卡尔文循环', { kinds: ['message'], ownerId: U1 }));
    expect(userHit.parentId).toBe('s-fts-a');
    expect(aiHit.parentId).toBe('s-fts-a');
  });

  it('updateMessageContent（编辑重发）→ 新内容可搜、旧内容搜不到', () => {
    mkSession('s-fts-b', U1);
    const id = insertUserMessage('s-fts-b', '原始的提问文本', []);
    const rowid = (
      getDb().prepare('SELECT rowid AS rid FROM messages WHERE id = ?').get(id) as { rid: number }
    ).rid;
    updateMessageContent(rowid, '改写后的提问文本', 8);
    expect(searchAll('改写后的提问文本', { kinds: ['message'], ownerId: U1 })).toHaveLength(1);
    expect(searchAll('原始的提问文本', { kinds: ['message'], ownerId: U1 })).toHaveLength(0);
  });

  it('dropMessagesAfter（重新生成）→ 被删的产物立刻搜不到', () => {
    mkSession('s-fts-c', U1);
    const id = insertUserMessage('s-fts-c', '重新生成用的提问', []);
    insertAssistantMessage({ sessionId: 's-fts-c', content: '这一版回答会被丢弃', tokens: 5 });
    const rowid = (
      getDb().prepare('SELECT rowid AS rid FROM messages WHERE id = ?').get(id) as { rid: number }
    ).rid;
    dropMessagesAfter('s-fts-c', rowid);
    expect(searchAll('这一版回答会被丢弃', { kinds: ['message'], ownerId: U1 })).toHaveLength(0);
  });

  it('★ 索引范围排除：tool 行 / 流式空占位 / [QUIZ] [SCENARIO] 协议消息都不进索引', () => {
    mkSession('s-fts-d', U1);
    const db = getDb();
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m-tool', 's-fts-d', 'tool', '工具原始结果占位词甲')`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m-empty', 's-fts-d', 'assistant', '')`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m-quiz', 's-fts-d', 'assistant', '[QUIZ]{"title":"协议占位词乙"}[/QUIZ]')`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m-sce', 's-fts-d', 'assistant', '[SCENARIO]{"demoId":"协议占位词丙"}[/SCENARIO]')`).run();
    indexRow('message', 'm-tool');
    indexRow('message', 'm-empty');
    indexRow('message', 'm-quiz');
    indexRow('message', 'm-sce');
    for (const q of ['工具原始结果占位词甲', '协议占位词乙', '协议占位词丙']) {
      expect(searchAll(q, { kinds: ['message'], ownerId: U1 }), q).toHaveLength(0);
    }
  });

  it('★ 会话软删 → 其消息立刻搜不到（sessions 是软删，索引不会自己消失）', () => {
    mkSession('s-fts-e', U1);
    insertUserMessage('s-fts-e', '这条消息所在的会话会被删掉', []);
    expect(searchAll('这条消息所在的会话会被删掉', { kinds: ['message'], ownerId: U1 })).toHaveLength(1);
    dropSessionMessages('s-fts-e');
    expect(searchAll('这条消息所在的会话会被删掉', { kinds: ['message'], ownerId: U1 })).toHaveLength(0);
  });
});

describe('search/fts-index — 可见性（FTS-SPEC §4 矩阵）', () => {
  it('★ 认证态：只看得到自己的词条，别人的与无主的都看不到', () => {
    saveOneTerm('可见性词条丙', '甲用户写的', '测试', U1);
    saveOneTerm('可见性词条丁', '乙用户写的', '测试', U2);
    saveOneTerm('可见性词条戊', '无主行', '测试', null); // ownerForWrite(null) ⇒ ''
    expect(searchAll('甲用户写的', { kinds: ['term'], ownerId: U1 })).toHaveLength(1);
    expect(searchAll('乙用户写的', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
    // ★ 无主行「谁都不泄露」是 M2d 的既定口径，认证态同样看不到
    expect(searchAll('无主行', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
  });

  it('★ 未认证（本地单人）：term 只看无主行（挡住过渡期里别的用户写的数据）', () => {
    saveOneTerm('可见性词条己', '甲用户写的新数据', '测试', U1);
    saveOneTerm('可见性词条庚', '无主模式写的数据', '测试', null);
    expect(searchAll('无主模式写的数据', { kinds: ['term'], ownerId: null })).toHaveLength(1);
    expect(searchAll('甲用户写的新数据', { kinds: ['term'], ownerId: null })).toHaveLength(0);
  });

  it('★ 未认证：message **不过滤**（等价今天 sessions 列表的全量可见，本地单人行为不变）', () => {
    mkSession('s-fts-f', U1);
    insertUserMessage('s-fts-f', '归属在甲用户名下的历史消息', []);
    expect(searchAll('归属在甲用户名下的历史消息', { kinds: ['message'], ownerId: null })).toHaveLength(1);
  });
});

describe('search/fts-index — 全量重建', () => {
  it('★ rebuild 过滤已软删会话：重建**不会**把删掉会话的消息复活', () => {
    mkSession('s-fts-g', U1);
    insertUserMessage('s-fts-g', '重建不该复活的消息正文', []);
    getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = 's-fts-g'`).run();
    rebuildSearchIndex();
    expect(searchAll('重建不该复活的消息正文', { kinds: ['message'], ownerId: U1 })).toHaveLength(0);
  });

  it('rebuild 幂等：连跑两次行数一致，且能召回重建前就存在的词条', () => {
    const n1 = rebuildSearchIndex();
    const n2 = rebuildSearchIndex();
    expect(n2).toBe(n1);
    expect(countIndexRows()).toBe(n1);
    expect(searchAll('牛顿第二定律', { kinds: ['term'], ownerId: U1 }).length).toBeGreaterThan(0);
  });
});

describe('search/fts-index — 结果形状与已接受限制', () => {
  it('title 截断到 FTS_TITLE_CHARS，snippet 含查询词（前端靠 indexOf 高亮，不含就整条不亮）', () => {
    mkSession('s-fts-h', U1);
    const long = `${'铺'.repeat(FTS_TITLE_CHARS + 60)}命中关键词在这里`;
    insertUserMessage('s-fts-h', long, []);
    const hit = first(searchAll('命中关键词', { kinds: ['message'], ownerId: U1 }));
    expect(hit.title.length).toBeLessThanOrEqual(FTS_TITLE_CHARS);
    expect(hit.snippet).toContain('命中关键词');
  });

  it('★ 已接受限制（登记，不是 bug）：单个汉字查不到多字连续串——bigram 的原理性代价', () => {
    saveOneTerm('限制词条辛', '连续串测试内容', '测试', U1);
    // 双字词命中
    expect(searchAll('连续', { kinds: ['term'], ownerId: U1 }).length).toBeGreaterThan(0);
    // 单字「连」查不到：索引里存的是 bigram（"连续"），没有单字 "连" 这一项
    expect(searchAll('连', { kinds: ['term'], ownerId: U1 })).toHaveLength(0);
  });
});
