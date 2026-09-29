/**
 * learning/npc-agent-tools — 伙伴智能体的工具箱（AI 深度 Step 4：NPC agent）。
 *
 * ★ 从「会聊天的 NPC」到「会看你学习情况再开口的 NPC」：原来伙伴只有一件工具（送新词），
 *   而且提示词明令「不要编造进度」——因为他根本看不到进度。现在他能**查**：
 *   · `recall_learner_state`：这块地所属领域里你快忘的词条（FSRS 可提取度）+ 还没纠正的误区（AI 阅卷诊断）；
 *   · `related_terms`：脚下这个词条在关系图里连着谁（前置／易混淆……，Step 3 的 `term_edge`）；
 *   · `offer_new_term`：原有的交换（无参数，领域由服务端定）。
 *   于是「不要编造」变成「先查再说、只说查到的」——事实来自服务端，口吻来自模型。
 * ★ 工具都**无参数或只读**：模型只决定「要不要查」，查什么（哪个领域、哪块地）由服务端按他脚下那格定。
 *   让模型填领域/词条 id，它会编一个库里没有的。
 * ★ 每个工具结果都**截短、去 id**：喂回模型的是人话事实，不是库行。
 */
import type { ToolDefinition } from '../llm/types.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { openMisconceptions, weakTerms } from './learner-model.js';
import { termRelations } from './term-graph.js';
import { npcTradeInDomain } from './npc.js';
import type { ChestDraw } from './chest.js';

const noParams = { type: 'object', properties: {}, required: [] } as const;

export const NPC_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'recall_learner_state',
      description:
        '查看用户在你这块地所属领域里：哪些词条快忘了、有哪些还没纠正的误区。' +
        '用户问「我哪里不熟/该复习什么/我是不是搞错了什么」，或你想按他的薄弱处出个小问题时调用。只说查到的，查不到就说没有。',
      parameters: noParams,
    },
  },
  {
    type: 'function',
    function: {
      name: 'related_terms',
      description: '查看你脚下这个词条和哪些词条有关（需要先懂什么、容易和什么混淆）。用户问「这个和什么有关/先学什么/和 X 有啥区别」时调用。',
      parameters: noParams,
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_new_term',
      description:
        '当用户想学点新的、或明确要你"换一条新词/教我点没见过的"时调用它。' +
        '你会得到一条这块地所属领域里、用户还没见过的新词条，然后用你自己的话把它介绍给他。' +
        '用户只是随口闲聊、或在问你已有词条的问题时，**不要**调它。',
      parameters: noParams,
    },
  },
];

export type NpcToolName = 'recall_learner_state' | 'related_terms' | 'offer_new_term';

/** 给前端看的「他刚才做了什么」：只有标签，不带数据（数据在他的回复里） */
export interface NpcAgentAction {
  tool: NpcToolName;
  label: string;
}

export interface NpcToolContext {
  ownerId: string | null;
  npcId: string;
  /** 他脚下那格（为空 ⇒ 用他的家） */
  term: string;
  domain: string;
}

export interface NpcToolOutcome {
  /** 喂回模型的事实（人话） */
  result: string;
  action: NpcAgentAction;
  draw?: ChestDraw | null;
  tradeNote?: string | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function domainOf(ownerId: string | null, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .prepare(`SELECT id, domain FROM term_library WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(ownerForWrite(ownerId), ...ids) as Array<{ id: string; domain: string }>;
  return new Map(rows.map((r) => [r.id, r.domain]));
}

export function recallLearnerState(ctx: NpcToolContext, now = new Date()): string {
  const weak = weakTerms(ctx.ownerId, now, 50);
  const mis = openMisconceptions(ctx.ownerId, 50);
  const dom = domainOf(ctx.ownerId, [...weak.map((w) => w.id), ...mis.flatMap((m) => (m.termId ? [m.termId] : []))]);
  const localWeak = weak.filter((w) => dom.get(w.id) === ctx.domain).slice(0, 3);
  const localMis = mis.filter((m) => (m.termId ? dom.get(m.termId) === ctx.domain : m.topic.includes(ctx.domain))).slice(0, 2);
  const lines: string[] = [];
  lines.push(
    localWeak.length
      ? `「${ctx.domain}」里快忘的词条：${localWeak.map((w) => `${w.term}（还记得约 ${pct(w.retention)}）`).join('、')}。`
      : `「${ctx.domain}」里目前没有快忘的词条。`,
  );
  lines.push(
    localMis.length
      ? `还没纠正的误区：${localMis.map((m) => `${m.note}（出现过 ${m.count} 次）`).join('；')}。`
      : '这个领域没有记录在案的误区。',
  );
  const elsewhere = weak.length - localWeak.length;
  if (elsewhere > 0) lines.push(`（别的领域还有 ${elsewhere} 个快忘的，那不归你管，最多提一句。）`);
  return lines.join('\n');
}

export function relatedTermsOf(ctx: NpcToolContext): string {
  const row = getDb()
    .prepare('SELECT id FROM term_library WHERE owner_id = ? AND term = ? LIMIT 1')
    .get(ownerForWrite(ctx.ownerId), ctx.term) as { id: string } | undefined;
  const rel = row ? termRelations(ctx.ownerId, row.id).slice(0, 6) : [];
  if (rel.length === 0) return `「${ctx.term}」在关系图里还没连上别的词条。`;
  return `「${ctx.term}」的关系：${rel.map((r) => `${r.label}「${r.term}」${r.note ? `（${r.note.slice(0, 40)}）` : ''}`).join('；')}。`;
}

export function runNpcTool(name: string, ctx: NpcToolContext): NpcToolOutcome | null {
  if (name === 'recall_learner_state') {
    return { result: recallLearnerState(ctx), action: { tool: name, label: '看了看你的记忆' } };
  }
  if (name === 'related_terms') {
    return { result: relatedTermsOf(ctx), action: { tool: name, label: `查了「${ctx.term}」的关系` } };
  }
  if (name === 'offer_new_term') {
    const r = npcTradeInDomain(ctx.ownerId, ctx.npcId, ctx.domain);
    return r.ok
      ? {
          result:
            `换到了：「${r.draw.term}」（${r.draw.domain}）——释义：${r.draw.definition}。` +
            `用你自己的口气把它介绍给他，两三句，别念释义原文。今天还能换 ${r.tradesLeft} 次。`,
          action: { tool: name, label: '掏出一条新词' },
          draw: r.draw,
        }
      : {
          result: `没换成。原因：${r.error} 用你自己的口气把这个原因告诉他，一句就够，别安慰过头。`,
          action: { tool: name, label: '想换新词但没换成' },
          tradeNote: r.error,
        };
  }
  return null;
}
