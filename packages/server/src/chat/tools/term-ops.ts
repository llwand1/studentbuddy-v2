/**
 * chat/tools/term-ops —— 词条一族三工具（契约 TOOL-ECOSYSTEM-SPEC §5.1，P3 / 拍板⑥⑭）。
 *
 * `lookup_terms`（read，查永不问）/ `upsert_term`（write，by_size）/ `delete_terms`
 * （write，**必确认不受阈值影响**）接替退役的 `manage_terms`。三工具是词条写侧的唯一门面：
 * - `upsert_term` / `delete_terms` 走 §4.6 两阶段（只给 `planWrite`，`run` 不会被 registry 调用）；
 * - `delete_terms` 落库前逐条写快照（`storage/term-delete-log.ts`），词条页按批撤销；
 * - 名字找不到就**如实报**，不模糊匹配着删（findTermByName 的别名命中是既有同概念口径，非模糊兜底）。
 *
 * `learning/terms.ts` 零改动（契约判据）：本文件只 import，不给域层加工具专用口子。
 */
import { findTermByName, listTerms, removeTerm, saveOneTerm, updateTerm } from '../../learning/terms.js';
import { domainStats } from '../../learning/domains.js';
import { logTermDeletions, selectTermRowsForSnapshot } from '../../storage/term-delete-log.js';
import type { TermRow } from '../../learning/terms.js';
import { registerTool, zeroWritePlan } from './registry.js';
import type { ToolContext } from './registry.js';

/** 模型回灌内容的裁剪口径（词条列表可能上百条，全量回灌会吃掉窗口） */
const LOOKUP_MAX_ROWS = 30;
const LOOKUP_DEF_CHARS = 60;
/** delete_terms 单次上限（契约 §5.1：≤50 条；超限报错而不是悄悄截断——截了哪几条模型不知道） */
const DELETE_MAX_BATCH = 50;

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// ── lookup_terms ─────────────────────────────────────────
registerTool('lookup_terms', {
  definition: {
    type: 'function',
    function: {
      name: 'lookup_terms',
      description:
        '查询词条库（术语记忆库）：按领域或词条名前缀筛选，附带各领域条数统计。' +
        '用户问「我库里有哪些词条」「math 领域记了什么」「查一下 XX 词条」时调用。只读，不改任何东西。',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: '可选：只看某领域（如 math/cs/english/general）' },
          keyword: { type: 'string', description: '可选：词条名前缀（不是全文检索）' },
        },
        required: [],
      },
    },
  },
  kind: 'read',
  async run(args, ctx) {
    const domain = trimStr(args.domain) || undefined;
    const keyword = trimStr(args.keyword) || undefined;
    const rows = listTerms(domain, keyword, ctx.ownerId);
    const stats = domainStats(ctx.ownerId);
    const head = rows.slice(0, LOOKUP_MAX_ROWS).map((r) => {
      const def =
        r.definition.length > LOOKUP_DEF_CHARS ? `${r.definition.slice(0, LOOKUP_DEF_CHARS - 1)}…` : r.definition;
      const alias = r.aliases.length > 0 ? `（别名：${r.aliases.join('、')}）` : '';
      return `- ${r.term}${alias}［${r.domain}］：${def}`;
    });
    const domains = stats.domains.map((d) => `${d.domain} ${d.count}`).join('、') || '（空库）';
    const parts = [
      `词条库共 ${stats.total} 条${domain ? `（筛选领域 ${domain}）` : ''}${keyword ? `（前缀 ${keyword}）` : ''}，命中 ${rows.length} 条。`,
      head.length > 0 ? head.join('\n') : '（没有命中任何词条）',
      rows.length > head.length ? `…仅显示前 ${LOOKUP_MAX_ROWS} 条，其余 ${rows.length - head.length} 条可加筛选条件再查。` : '',
      `领域分布：${domains}`,
      '请用自然语言向用户汇报，不要原样输出本清单。',
    ];
    return { content: parts.filter(Boolean).join('\n') };
  },
});

// ── upsert_term ──────────────────────────────────────────
registerTool('upsert_term', {
  definition: {
    type: 'function',
    function: {
      name: 'upsert_term',
      description:
        '新增或修改一条词条（一次只动一条）：词条已存在（含别名命中）则更新释义等字段，不存在则新建。' +
        '用户说「这个词记一下」「把 XX 的释义改成…」时调用。删除请用 delete_terms，本工具不删。',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '词条名（必填）' },
          definition: { type: 'string', description: '释义（必填）' },
          domain: { type: 'string', description: '可选：领域（如 math/cs/english，新建缺省 general；更新时不传=不改）' },
          importance: { type: 'number', description: '可选：重要度 0-1（仅更新已有词条时生效；新建缺省 0.5）' },
        },
        required: ['term', 'definition'],
      },
    },
  },
  // kind write ⇒ 缺省 'by_size'；一次只动一条 ⇒ 常规阈值（≥1）下实际等价免确认，
  // 用户把阈值调到 0（条条必确认）时这里也会弹卡——所以仍必须走两阶段而不是裸 run。
  kind: 'write',
  async planWrite(args, ctx) {
    const term = trimStr(args.term);
    const definition = trimStr(args.definition);
    if (!term || !definition) return zeroWritePlan('upsert_term 需要 term（词条名）与 definition（释义），请带齐参数重新调用。');
    const hit = findTermByName(term, ctx.ownerId);
    const domain = trimStr(args.domain) || undefined;
    const importance = typeof args.importance === 'number' && Number.isFinite(args.importance) ? args.importance : undefined;

    if (hit) {
      if (importance === undefined && !domain && definition === hit.definition) {
        return zeroWritePlan(`词条「${hit.term}」的释义与现状一致，本次未写入（想改字段请给出不同内容）。`);
      }
      return {
        affected: 1,
        actionSummary: `更新词条「${hit.term}」`,
        items: [`「${hit.term}」释义改为：${definition.length > 40 ? `${definition.slice(0, 39)}…` : definition}`],
        apply: async () => {
          const patch: { definition: string; domain?: string; importance?: number } = { definition };
          if (domain) patch.domain = domain;
          if (importance !== undefined) patch.importance = importance;
          const row = updateTerm(hit.id, patch, ctx.ownerId);
          if (!row) {
            // §4.6-5 apply 前重校验：计划更新的对象没了（确认间隙被 UI 删了）→ 中止如实报，不擅自改成新建
            return {
              content: `词条「${hit.term}」在计划与执行之间已被删除，本次未写入。若仍要记录，请重新调 upsert_term 新建。`,
              meta: { affected: 0 },
            };
          }
          ctx.onStep('upsert_term', 'done', `词条「${row.term}」已更新`);
          return {
            content: `词条已更新：${row.term}（领域 ${row.domain}）。请用一句话向用户确认改了什么，不要输出本 JSON。`,
            meta: { affected: 1 },
          };
        },
      };
    }
    return {
      affected: 1,
      actionSummary: `新建词条「${term}」`,
      items: [`新建「${term}」：${definition.length > 40 ? `${definition.slice(0, 39)}…` : definition}`],
      apply: async () => {
        // saveOneTerm 本身是 upsert 语义：间隙里同名行出现会走它的更新分支，与用户意图一致
        const row = saveOneTerm(term, definition, domain, ctx.ownerId);
        ctx.onStep('upsert_term', 'done', `词条「${row.term}」已入库（${row.domain}）`);
        return {
          content: `词条已入库：${row.term}（领域 ${row.domain}）。请用一句话向用户确认，不要输出本 JSON。`,
          meta: { affected: 1 },
        };
      },
    };
  },
});

// ── delete_terms ─────────────────────────────────────────
interface DeletePlan {
  rows: TermRow[];
  missingNames: string[];
  missingIds: string[];
}

/** 按名/按 id 解析待删行（plan 与 apply 各跑一次——apply 那次就是 §4.6-5 的重校验） */
function resolveDeletions(args: Record<string, unknown>, ctx: ToolContext): DeletePlan {
  const names = Array.isArray(args.terms)
    ? [...new Set(args.terms.map((t) => trimStr(t)).filter(Boolean))]
    : [];
  const ids = Array.isArray(args.ids)
    ? [...new Set(args.ids.map((t) => trimStr(t)).filter(Boolean))]
    : [];
  const found = new Map<string, TermRow>();
  const missingNames: string[] = [];
  for (const name of names) {
    const hit = findTermByName(name, ctx.ownerId);
    if (hit) found.set(hit.id, hit);
    else missingNames.push(name);
  }
  const idRows = selectTermRowsForSnapshot(ids, ctx.ownerId);
  const hitIds = new Set(idRows.map((r) => r.id));
  for (const r of idRows) found.set(r.id, r);
  const missingIds = ids.filter((id) => !hitIds.has(id));
  return { rows: [...found.values()], missingNames, missingIds };
}

registerTool('delete_terms', {
  definition: {
    type: 'function',
    function: {
      name: 'delete_terms',
      description:
        '删除词条（一批一个确认，用户批准后才执行；删后可在词条页整批撤销）。' +
        '用户明确说「删掉 XX 词条」「把这几条清了」时调用。terms 给词条名、ids 给词条 id，单次合计 ≤50 条。' +
        '名字找不到的绝不模糊匹配着删——未找到的会如实报告给你。',
      parameters: {
        type: 'object',
        properties: {
          terms: { type: 'array', items: { type: 'string' }, description: '要删的词条名列表（与 ids 至少给一个）' },
          ids: { type: 'array', items: { type: 'string' }, description: '要删的词条 id 列表（lookup/此前工具拿到的）' },
        },
        required: [],
      },
    },
  },
  // §5.1：删除权限的必确认门面——不受阈值影响（阈值是「批量多大才问」，删除不问大小）。
  kind: 'write',
  needsConfirm: true,
  async planWrite(args, ctx) {
    const hasAny = (Array.isArray(args.terms) && args.terms.length > 0) || (Array.isArray(args.ids) && args.ids.length > 0);
    if (!hasAny) return zeroWritePlan('delete_terms 需要 terms（词条名列表）或 ids（词条 id 列表），至少给一个。');
    const { rows, missingNames, missingIds } = resolveDeletions(args, ctx);
    const requested = rows.length + missingNames.length + missingIds.length;
    if (requested > DELETE_MAX_BATCH) {
      return zeroWritePlan(`delete_terms 单次最多 ${DELETE_MAX_BATCH} 条（本次点名 ${requested} 条），请分批调用。`);
    }
    const missReport = [
      missingNames.length > 0 ? `词条库里没有：${missingNames.join('、')}` : '',
      missingIds.length > 0 ? `这些 id 不存在或不可删：${missingIds.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('；');
    if (rows.length === 0) {
      // 全没找到 ⇒ affected 0：不弹「批准一次零改动」的空卡，直接 apply 如实报（§4.6 落码注）
      return zeroWritePlan(`${missReport || '没有可删除的词条'}。本次未删除任何词条。`);
    }
    return {
      affected: rows.length,
      actionSummary: `删除 ${rows.length} 条词条（删后可在词条页整批撤销）`,
      items: rows.map((r) => `${r.term}［${r.domain}］`),
      apply: async () => {
        // §4.6-5 重校验：确认间隙里被 UI 改动（少行=行数不符）→ 整批中止，批 A 跑 A
        const fresh = selectTermRowsForSnapshot(rows.map((r) => r.id), ctx.ownerId);
        if (fresh.length !== rows.length) {
          return {
            content: `计划删除 ${rows.length} 条，但执行时只剩 ${fresh.length} 条（中途有变动），本次整批中止、一条未删。请重新发起。`,
            meta: { affected: 0 },
          };
        }
        for (const r of fresh) removeTerm(r.id, ctx.ownerId);
        logTermDeletions({ rows: fresh, ownerId: ctx.ownerId, actor: 'ai_tool', tool: 'delete_terms' });
        ctx.onStep('delete_terms', 'done', `已删除 ${fresh.length} 条`);
        const parts = [`已删除 ${fresh.length} 条：${fresh.map((r) => r.term).join('、')}`];
        if (missReport) parts.push(missReport);
        return {
          content: `${parts.join('；')}。请用自然语言向用户汇报（可提醒：词条页可整批撤销），不要输出本 JSON。`,
          meta: { affected: fresh.length },
        };
      },
    };
  },
});
