/**
 * learning/follow-up-links 单测（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §3）。
 *
 * 钉的是**这张星型图的形状与出处**，不是"能跑通"：
 *   ① 普通会话是**空操作**（这个函数挂在每一轮回复的收尾上，绝不能误伤主业）；
 *   ② 边的方向是 源词条 → 回复词条，`origin='ai'`（**不是 `'user'`**）、kind='relates'、
 *      weight 用默认 0.5（契约 §3.2：权重反映关系可信度，不反映"用户点了按钮"这个动作的强度）；
 *   ③ 幂等由库约束兜（连跑两次边数不变）；
 *   ④ 源词条已不在库里 ⇒ **不建边**（不留幽灵星心，契约 §8）；
 *   ⑤ 回复里又提到源词条本身 ⇒ 自环被丢（"跟自己相关"零信息量）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { forkedTermOf, linkFollowUpEdges } from './follow-up-links.js';
import { listNodes } from './knowledge-graph.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fulink-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface EdgeRow {
  from_node_id: string;
  to_node_id: string;
  kind: string;
  origin: string;
  weight: number;
  evidence: string | null;
}

/** 落一个词条。`src` 指向"它是在哪个会话里被抽出来的"——追问星型正是靠这一列找回复词条 */
function term(id: string, text: string, src: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO term_library (id, term, definition, domain, source_session_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, text, `${text} 的释义`, 'cs', src);
}

/** 落一个会话。`forkedTerm` 非空 = 它是「为了深挖这个词条」开的追问会话 */
function session(id: string, forkedTerm: string | null, forkedFrom: string | null = null): void {
  getDb()
    .prepare(`INSERT INTO sessions (id, user_id, forked_from_id, forked_term) VALUES (?, '', ?, ?)`)
    .run(id, forkedFrom, forkedTerm);
}

const edges = (): EdgeRow[] => getDb().prepare('SELECT * FROM knowledge_edge').all() as EdgeRow[];

describe('forkedTermOf', () => {
  it('普通会话 ⇒ null；追问会话 ⇒ 根词条名', () => {
    session('s-plain', null);
    session('s-fork', '闭包', 's-plain');
    expect(forkedTermOf('s-plain')).toBeNull();
    expect(forkedTermOf('s-fork')).toBe('闭包');
  });

  it('不存在的会话 ⇒ null（不抛：调用点在每一轮回复的收尾上）', () => {
    expect(forkedTermOf('s-nope')).toBeNull();
  });
});

describe('linkFollowUpEdges — 普通会话是空操作', () => {
  it('★ 非追问会话：返回 0，且**一个节点、一条边都不建**', () => {
    term('t-a', '闭包', 's-plain');
    term('t-b', '柯里化', 's-plain');
    session('s-plain', null);
    expect(linkFollowUpEdges('s-plain', null)).toBe(0);
    expect(listNodes(null)).toHaveLength(0);
    expect(edges()).toHaveLength(0);
  });
});

describe('linkFollowUpEdges — 星型：源词条 → 回复里的每个词条', () => {
  beforeEach(() => {
    term('t-root', '闭包', 's-parent');
    term('t-1', '词法作用域', 's-fork');
    term('t-2', '柯里化', 's-fork');
    term('t-other', '无关词条', 's-elsewhere'); // 别的会话抽到的，不该被连
    session('s-parent', null);
    session('s-fork', '闭包', 's-parent');
  });

  it('★ 回复里的每个词条各连一条边，出处与权重都对', () => {
    expect(linkFollowUpEdges('s-fork', null)).toBe(2);
    const rows = edges();
    expect(rows).toHaveLength(2);
    for (const e of rows) {
      expect(e.kind).toBe('relates');
      // ★ 核心判据：用户发起的是"追问"这个动作，而"两者有关系"是模型说的 ⇒ 记 ai
      expect(e.origin).toBe('ai');
      expect(e.weight).toBe(0.5);
      expect(e.evidence).toBe('追问「闭包」');
    }
  });

  it('★ 方向是 源 → 新（给出"这次追问长出来的"出处），且别的会话的词条不被牵连', () => {
    linkFollowUpEdges('s-fork', null);
    const rootNode = listNodes(null, 'term').find((n) => n.refText === '闭包');
    if (!rootNode) throw new Error('找不到源词条节点');
    for (const e of edges()) expect(e.from_node_id).toBe(rootNode.id);
    const targets = edges().map((e) => e.to_node_id);
    const stray = listNodes(null, 'term').find((n) => n.refText === '无关词条');
    expect(targets).not.toContain(stray?.id);
  });

  it('★ 幂等：连跑两次，边数与节点数都不变（幂等交给库约束，不靠调用方记得只调一次）', () => {
    linkFollowUpEdges('s-fork', null);
    const before = edges().length;
    const nodesBefore = listNodes(null).length;
    expect(linkFollowUpEdges('s-fork', null)).toBe(2); // 返回值是"参与连边数"，含已存在的
    expect(edges()).toHaveLength(before);
    expect(listNodes(null)).toHaveLength(nodesBefore);
  });

  it('★ 回复里又提到源词条本身 ⇒ 不产生自环（"跟自己相关"零信息量）', () => {
    // 真实路径：源词条当初是手工加进词条库的（source_session_id 为 NULL），
    // 追问的回复里模型又抽到了它一次 ⇒ saveTerms 的 COALESCE 把 source_session_id 补成了本会话。
    // 于是"本会话沉淀的词条"里包含了源词条自己 —— 必须被丢成自环，而不是造一条 A→A 的边。
    getDb().prepare(`UPDATE term_library SET source_session_id = ? WHERE id = ?`).run('s-fork', 't-root');
    linkFollowUpEdges('s-fork', null);
    expect(edges().length).toBeGreaterThan(0); // 别的词条的边照常建（不是整个函数罢工）
    for (const e of edges()) expect(e.from_node_id).not.toBe(e.to_node_id);
  });

  it('会话里还没沉淀任何词条 ⇒ 0（第一次回复还没抽完词，这是正常态不是失败）', () => {
    session('s-empty-fork', '闭包', 's-parent');
    expect(linkFollowUpEdges('s-empty-fork', null)).toBe(0);
  });
});

describe('linkFollowUpEdges — 源词条不在库里', () => {
  it('★ 词条已被删/被合并 ⇒ 返回 0 且不建边（不留一个围绕幽灵星心的图）', () => {
    term('t-1', '词法作用域', 's-fork');
    session('s-parent', null);
    session('s-fork', '早已被删掉的词条', 's-parent');
    expect(linkFollowUpEdges('s-fork', null)).toBe(0);
    expect(edges()).toHaveLength(0);
  });

  it('同名但属于别人（owner 隔离）⇒ 也当"不在库里"处理', () => {
    getDb()
      .prepare(`INSERT INTO term_library (owner_id, id, term, definition, domain, source_session_id) VALUES ('', ?, ?, ?, ?, ?)`)
      .run('t-other-user', '闭包', '别人的释义', 'cs', 's-parent');
    term('t-1', '词法作用域', 's-fork');
    session('s-fork', '闭包', 's-parent');
    // 未登录（ownerId=null）→ ownerForWrite 得到 ''，正好命中上面那行；换个真实 owner 则命中不到
    expect(linkFollowUpEdges('s-fork', 'user-b')).toBe(0);
    expect(edges()).toHaveLength(0);
  });
});
