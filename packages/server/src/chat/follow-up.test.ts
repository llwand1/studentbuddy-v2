/**
 * chat/follow-up 单测（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §4 / §5.2 / §5.3）。
 *
 * 钉的是**与模型的约定**里最容易悄悄搞错的两处：
 *   ① 摘要三档的**优先顺序**（有真摘要就绝不去拼摘录——那是白扔一次已经算过的结果）；
 *   ② 第 ② 档必须在正文里**自称"摘录（未压缩）"**。写成"摘要"就等于让模型以为
 *      它看到的是完整上下文，然后对"你之前说过什么"做过度推断，而我们无从纠正。
 *
 * 另钉建会话的两条硬性（都踩过才会懂）：标题**不能是**默认值「新对话」（会被首问正文覆盖），
 * 首问**不在这里落库**（要交给 handleMessage 的正规链路，否则出现影子消息）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { insertSession } from '../auth/ownership.js';
import type { TermRow } from '../learning/terms.js';
import {
  FOLLOW_UP_SUMMARY_MAX_CHARS,
  buildFollowUpContext,
  composeFollowUpPrompt,
  createFollowUpSession,
} from './follow-up.js';

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fulup-'));
  openIsolated(dir);
  seq = 0;
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 落一条消息（rowid 决定同秒内的先后，与 loadHistory 的排序口径一致） */
function say(sessionId: string, role: 'user' | 'assistant' | 'tool', content: string): void {
  seq += 1;
  getDb()
    .prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`)
    .run(`m-${seq}`, sessionId, role, content);
}

/** 模拟「本会话已经被压缩过」——真摘要在 compact.ts 里写，这里只摆出结果 */
function setSummary(sessionId: string, text: string): void {
  getDb()
    .prepare(`UPDATE sessions SET summary = ?, summary_upto_rowid = 10 WHERE id = ?`)
    .run(text, sessionId);
}

function termIn(id: string, text: string, definition: string, domain = 'cs'): void {
  getDb()
    .prepare(`INSERT INTO term_library (id, term, definition, domain) VALUES (?, ?, ?, ?)`)
    .run(id, text, definition, domain);
}

/** 造一条 `TermRow`（`composeFollowUpPrompt` 只读 term/definition/domain，其余给合规默认值） */
function termRow(over: Pick<TermRow, 'term' | 'definition' | 'domain'>): TermRow {
  return {
    owner_id: '',
    id: 't-row',
    aliases: '[]',
    source_session_id: null,
    importance: 0.5,
    usage_count: 0,
    last_used_at: null,
    created_at: '2026-09-20 00:00:00',
    updated_at: '2026-09-20 00:00:00',
    review_stage: 0,
    last_reviewed_at: null,
    review_enabled: null,
    ...over,
  };
}

describe('buildFollowUpContext — 三档优先顺序', () => {
  it('★ 有真摘要（compact）⇒ 用它，且不去拼摘录（那是白扔一次已经算过的结果）', () => {
    insertSession('s1', null);
    setSummary('s1', '之前聊了闭包与词法作用域，用户已经理解捕获变量。');
    say('s1', 'user', '刚说到哪儿了？');
    const ctx = buildFollowUpContext('s1');
    expect(ctx.source).toBe('compact');
    expect(ctx.summary).toContain('词法作用域');
    expect(ctx.summary).not.toContain('用户：'); // 摘录的标记，出现了就说明走错档
  });

  it('没摘要、有消息 ⇒ 退到摘录（recent），逐条带角色前缀', () => {
    insertSession('s2', null);
    say('s2', 'user', '闭包是什么？');
    say('s2', 'assistant', '闭包是函数加它定义时的词法作用域。');
    const ctx = buildFollowUpContext('s2');
    expect(ctx.source).toBe('recent');
    expect(ctx.summary).toContain('用户：闭包是什么？');
    expect(ctx.summary).toContain('助手：闭包是函数加它定义时的词法作用域。');
  });

  it('★ 摘录排除 tool 消息（工具回灌原文对"刚才在聊什么"零信息量，且体积最大）', () => {
    insertSession('s3', null);
    say('s3', 'user', '帮我搜一下');
    say('s3', 'tool', '{"huge":"工具回灌原文"}');
    say('s3', 'assistant', '搜到了。');
    const ctx = buildFollowUpContext('s3');
    expect(ctx.source).toBe('recent');
    expect(ctx.summary).not.toContain('工具回灌原文');
  });

  it('摘录只取最近 8 条（更早的不带——带过去只会挤掉用户真正的问题）', () => {
    insertSession('s4', null);
    for (let i = 1; i <= 12; i++) say('s4', 'user', `第${i}句`);
    const ctx = buildFollowUpContext('s4');
    expect(ctx.summary).toContain('第12句');
    expect(ctx.summary).not.toContain('第1句'); // 注意：也不该出现「第10句」之外的更早项
    expect(ctx.summary.split('\n')).toHaveLength(8);
  });

  it('摘要为空串 / 只有空白 ⇒ 不算命中第 ① 档', () => {
    insertSession('s5', null);
    setSummary('s5', '   \n  ');
    expect(buildFollowUpContext('s5').source).toBe('none');
  });

  it('一条消息都没有 ⇒ none + 空串（如实留空，不编造）', () => {
    insertSession('s6', null);
    const ctx = buildFollowUpContext('s6');
    expect(ctx.source).toBe('none');
    expect(ctx.summary).toBe('');
  });

  it('摘要超长 ⇒ 截断到上限', () => {
    insertSession('s7', null);
    setSummary('s7', 'a'.repeat(FOLLOW_UP_SUMMARY_MAX_CHARS + 500));
    expect(buildFollowUpContext('s7').summary).toHaveLength(FOLLOW_UP_SUMMARY_MAX_CHARS + 1); // +1 = 省略号
  });
});

describe('composeFollowUpPrompt — 首问正文', () => {
  const base = { term: '闭包', item: null as TermRow | null, question: '它和柯里化什么关系？' };

  it('★ compact 档：块标题写「原对话摘要」', () => {
    const p = composeFollowUpPrompt({
      ...base,
      context: { summary: '摘要正文', source: 'compact' },
    });
    expect(p).toContain('【原对话摘要】');
    expect(p).toContain('摘要正文');
    expect(p).toContain('闭包');
    expect(p).toContain('它和柯里化什么关系？');
  });

  it('★ recent 档：块标题必须自称「摘录（未压缩）」——写成"摘要"就是撒谎', () => {
    const p = composeFollowUpPrompt({
      ...base,
      context: { summary: '用户：闭包?', source: 'recent' },
    });
    expect(p).toContain('【原对话摘录（未压缩）】');
    expect(p).not.toContain('【原对话摘要】');
  });

  it('none 档：整块省略，且不留「（无摘要）」这种占位噪声', () => {
    const p = composeFollowUpPrompt({ ...base, context: { summary: '', source: 'none' } });
    expect(p).not.toContain('原对话');
    expect(p).not.toContain('无摘要');
    expect(p).toContain('闭包');
    expect(p).toContain('它和柯里化什么关系？');
  });

  it('词条库有这一行 ⇒ 带上领域与释义（模型少猜一层）', () => {
    const p = composeFollowUpPrompt({
      ...base,
      item: termRow({ term: '闭包', definition: '函数 + 词法作用域', domain: 'cs' }),
      context: { summary: '', source: 'none' },
    });
    expect(p).toContain('cs');
    expect(p).toContain('函数 + 词法作用域');
  });

  it('词条在库里但释义是空的 ⇒ 如实标注，不产出「它的释义是：」这种半句话', () => {
    const p = composeFollowUpPrompt({
      ...base,
      item: termRow({ term: '闭包', definition: '', domain: 'cs' }),
      context: { summary: '', source: 'none' },
    });
    expect(p).toContain('尚未填写释义');
  });
});

describe('createFollowUpSession — 建 fork 会话', () => {
  it('★ 落库三件事都对：标题带前缀、forked_from_id、forked_term（抗删快照＝词条名）', () => {
    insertSession('s-parent', null, '原对话');
    const { result } = createFollowUpSession({
      parentSessionId: 's-parent',
      term: '  闭包  ', // 前后空白：应在标题与落库里都被 trim
      ownerId: null,
    });
    const row = getDb()
      .prepare('SELECT title, forked_from_id, forked_term FROM sessions WHERE id = ?')
      .get(result.sessionId) as { title: string; forked_from_id: string; forked_term: string };
    expect(row.title).toBe('追问：闭包');
    expect(row.forked_from_id).toBe('s-parent');
    expect(row.forked_term).toBe('闭包');
    expect(result).toMatchObject({ forkedFromId: 's-parent', term: '闭包', title: '追问：闭包' });
  });

  it('★ 标题不是默认「新对话」——否则会被 flow 的「首句当标题」逻辑用整段 prompt 覆盖', () => {
    insertSession('s-parent', null);
    const { result } = createFollowUpSession({ parentSessionId: 's-parent', term: '闭包', ownerId: null });
    expect(result.title).not.toBe('新对话');
  });

  it('★ 首问**不在这里落库**：messages 表保持为空（交给 handleMessage 的正规链路）', () => {
    insertSession('s-parent', null);
    const { prompt } = createFollowUpSession({ parentSessionId: 's-parent', term: '闭包', ownerId: null });
    expect(prompt.length).toBeGreaterThan(0);
    const n = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it('用户填了问题 ⇒ 用用户的；没填 ⇒ 用默认问法（不是留空）', () => {
    insertSession('s-parent', null);
    const withQ = createFollowUpSession({
      parentSessionId: 's-parent',
      term: '闭包',
      question: '它和柯里化什么关系？',
      ownerId: null,
    });
    expect(withQ.prompt).toContain('它和柯里化什么关系？');

    const noQ = createFollowUpSession({ parentSessionId: 's-parent', term: '闭包', ownerId: null });
    expect(noQ.prompt).toContain('讲透');
    expect(noQ.prompt).toContain('闭包');
  });

  it('摘要档位如实回报给前端（用户有权知道这次带过去了什么）', () => {
    insertSession('s-parent', null);
    say('s-parent', 'user', '闭包是什么？');
    const { result } = createFollowUpSession({ parentSessionId: 's-parent', term: '闭包', ownerId: null });
    expect(result.summarySource).toBe('recent');
  });

  it('源词条在库里 ⇒ 首问带上它的释义；不在库里 ⇒ 照样能建（不因词条缺失而失败）', () => {
    insertSession('s-parent', null);
    termIn('t1', '闭包', '函数 + 词法作用域');
    const hit = createFollowUpSession({ parentSessionId: 's-parent', term: '闭包', ownerId: null });
    expect(hit.prompt).toContain('函数 + 词法作用域');
    const miss = createFollowUpSession({ parentSessionId: 's-parent', term: '查无此词', ownerId: null });
    expect(miss.prompt).toContain('查无此词');
    expect(miss.prompt).not.toContain('尚未填写释义');
  });
});
