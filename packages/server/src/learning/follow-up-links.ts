/**
 * learning/follow-up-links —— 「向 AI 追问」的**星型连边**（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §3）。
 *
 * 一句话：把一个 fork 会话里沉淀的词条，**全部连到它被追问的那个源词条上**。
 *
 * ★ 为什么单独成文件（而不是塞进 `knowledge-graph.ts`）：那个文件已经是 348 行的「图原语」
 *   （节点/边的增删查 + 统计 + 同域推导），本文件是**一个具体的业务规则**
 *   （"追问会话 ⇒ 星型"）。按本仓接缝习惯，规则与装置分家：装置改版不动规则，规则改版不动装置。
 *   客观收益：`knowledge-graph.ts` 加完这 50 行会顶到 server `≤400` 红线。
 *
 * ★★ 三条判据（越界就错，都是契约 §3 记过账的）：
 *  1. **边 = 知识点关系，不是"谁追问了谁"**。所以只连 `kind='term'` 的节点，
 *     不建 `turn` 节点、不建任何表示"发生过一次追问"的边。追问是**用户的手势**，不是一种关系。
 *  2. **`origin` 必须 `'ai'`，不能是 `'user'`**。用户做的事是"我要深挖这个词条"（意图，可信）；
 *     而"源词条与这些新词条确实有关系"是**模型在回复里说的**（命题，未知）。
 *     边承载的是后者 ⇒ 记 `ai`。把"用户点了按钮"洗成 `user` 边，等于让模型顺口一提取就
 *     冒充用户确认过的知识点——正是 `knowledge-graph.ts` 宪章第 2 条要防的污染。
 *     用户要转正走既有能力：知识图上手工连一条边，或删掉这条。
 *  3. **幂等交给库约束**（`UNIQUE(from_node_id, to_node_id, kind)` + `INSERT OR IGNORE`），
 *     本层**不**先查一次"存在吗"——那会把唯一键口径抄成两份，将来改键必漏一处。
 *     代价：返回值只能是「本次**参与**连边的边数（含本来就有的）」，不是"新建数"。
 *     这个名字上的含糊是刻意的，别把它改成 `created`（那是撒谎）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { findTermByName } from './terms.js';
import { addEdge, ensureNode } from './knowledge-graph.js';

/**
 * 这个会话是「为了深挖哪个词条」才开出来的？不是 fork 会话 ⇒ `null`。
 *
 * ★ 读的是**库里的真相**而不是路由传下来的参数（契约 §5.4）：
 *   客户端伪造不出来；且用户在 fork 会话里接着聊出来的词条也不会悄悄丢边。
 *   成本是一次主键查询，可忽略。
 */
export function forkedTermOf(sessionId: string): string | null {
  const row = getDb().prepare('SELECT forked_term FROM sessions WHERE id = ?').get(sessionId) as
    | { forked_term: string | null }
    | undefined;
  return row?.forked_term ?? null;
}

/**
 * 把 `sessionId` 这个 fork 会话沉淀的词条，全部连到它的源词条上（星型）。
 *
 * 返回**本次参与连边的边数**（含原本就存在的，见文件头 ★3）；非 fork 会话、源词条查不到、
 * 或本会话还没沉淀任何词条时返回 0——**三种 0 都不报错**（都是正常态，不是失败）。
 *
 * ★ 为什么源词条查不到就**不连**（而不是退化成"没有中心的散点"）：
 *   源词条可能被 TERM-TIDY 合并掉、被用户删掉（`forked_term` 是抗删快照，只有名字）。
 *   此时星心已经不在图上，硬连会出现一张围绕幽灵中心的图 —— 不如如实不连（契约 §8 已记账）。
 * ★ 为什么不需要时间窗（对比 `emitTermNodes` 用的 `created_at >= 本步开始`）：
 *   那个是"**这一步**产出了什么"（一个 run 分多步，必须切时间）；这里是"**这个会话**产出了什么"
 *   ——会话本身就是那个边界，多切一刀反而会把用户在追问里接着聊出的词条漏掉。
 */
export function linkFollowUpEdges(sessionId: string, ownerId: string | null): number {
  const rootName = forkedTermOf(sessionId);
  if (!rootName) return 0; // 不是追问会话：本函数对普通会话是**空操作**

  const root = findTermByName(rootName, ownerId);
  if (!root) return 0; // 源词条已不在库里：不留幽灵星心（契约 §8）

  const owner = ownerForWrite(ownerId);
  const rootNode = ensureNode({ kind: 'term', refId: root.id, refText: root.term, ownerId });
  const rows = getDb()
    .prepare(
      `SELECT id, term FROM term_library WHERE source_session_id = ? AND owner_id = ? ORDER BY created_at, rowid`,
    )
    .all(sessionId, owner) as Array<{ id: string; term: string }>;

  let linked = 0;
  for (const t of rows) {
    const node = ensureNode({ kind: 'term', refId: t.id, refText: t.term, ownerId });
    // 自环（回复里又提到了源词条本身）由 addEdge 静默丢弃 —— 一个词条跟"自己相关"没有信息量
    const edge = addEdge({
      fromNodeId: rootNode.id,
      toNodeId: node.id,
      kind: 'relates',
      origin: 'ai',
      // weight 刻意用 addEdge 的默认 0.5：权重该反映**关系的可信度**，不是**动作的强度**
      // （对照：同域 derived 边是 0.3——规则推导比模型抽取更弱）
      evidence: `追问「${root.term}」`,
      ownerId,
    });
    if (edge) linked++;
  }
  return linked;
}
