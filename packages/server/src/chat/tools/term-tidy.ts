/**
 * chat/tools/term-tidy —— `tidy_terms`（从 chat/tools.ts 原样搬入 S1 拆目录，逻辑零改动）。
 * 词条库「整理」语义：合并不删除；领域 CRUD 与词条 CRUD 对等（v19）。
 */
import type { TidySummary } from '@sb/shared';
import { TOOL_LLM_INNER_TIMEOUT_MS } from '@sb/shared';
import { tidyTerms, mergeTerms, renameDomain } from '../../learning/tidy.js';
import { createDomain, removeDomain } from '../../learning/domains.js';
import { registerTool } from './registry.js';

/** 词条整理结果回灌：给模型自然语言汇报的口径，不让它原样甩 JSON 给用户 */
function tidyResultContent(summary: TidySummary): string {
  return `词条库整理结果（请用简洁的自然语言向用户汇报要点，不要原样输出本 JSON）：${JSON.stringify(summary)}`;
}

/**
 * 领域新建/删除的工具侧包装（v19：领域与词条 CRUD 对等）。
 * 把域层异常转成 `TidySummary.error`——工具层的报错口径统一走 `tidyResultContent`，
 * 不让 `DomainError`（带 HTTP status，是给路由用的）直接冒到工具层。
 */
function domainAdd(name: string, note: string, ownerId: string | null): TidySummary {
  try {
    const { row, created } = createDomain(name, note.trim(), ownerId);
    return { result: 'ok', message: created ? `已新建领域「${row.name}」` : `领域「${row.name}」已存在，未重复创建` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '新建领域失败' };
  }
}

function domainRemove(name: string, ownerId: string | null): TidySummary {
  try {
    const r = removeDomain(name, ownerId);
    return { result: 'ok', message: `已删除领域「${r.name}」，${r.moved} 条词条转入「${r.target}」（词条一条未删）` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '删除领域失败' };
  }
}

registerTool('tidy_terms', {
  definition: {
    type: 'function',
    function: {
      name: 'tidy_terms',
      description:
        '维护词条库（术语记忆库）。用户提到整理/清理词条库、词条太多太乱、合并同义词、领域归组/归类、' +
        '给领域改名、新建或删除领域时调用。整理只合并不删除概念；删除领域也不删词条（词条转入 general）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['auto', 'merge', 'rename_domain', 'domain_add', 'domain_remove'],
            description:
              'auto=全量整理（AI 判断同义词合并与领域归一）；merge=把用户点名的几个词条合并成一条；' +
              'rename_domain=领域改名；domain_add=新建领域（可零词条，先建好领域再放词）；' +
              'domain_remove=删除领域（**词条转入 general，不删词条**）',
          },
          terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'merge 时必填：要合并的词条名列表，第一个为主词条',
          },
          from: { type: 'string', description: 'rename_domain 时必填：旧领域名' },
          to: { type: 'string', description: 'rename_domain 时必填：新领域名' },
          domain: { type: 'string', description: 'domain_add / domain_remove 时必填：领域名' },
          note: { type: 'string', description: 'domain_add 可选：领域说明（一句话，也可留空）' },
        },
        required: ['action'],
      },
    },
  },
  // §4.2 元数据：写库（合并/改名/领域增删都是归属写操作）⇒ write；auto 分支**内部再调模型**，
  // write 档 30s 不够，故逐工具显式超时（v1.3 拍板⑪：调个别工具，不动档位基线）。
  // 非幂等：二次 auto 整理可能把已合并的再合并/报错，不满足重试资格。
  kind: 'write',
  timeoutMs: TOOL_LLM_INNER_TIMEOUT_MS,
  async run(args, ctx) {
    const action = String(args.action ?? '').trim();
    let summary: TidySummary;
    if (action === 'auto') {
      ctx.onStep('tidy_terms', 'running', '正在整理词条库');
      summary = await tidyTerms(ctx.ownerId);
    } else if (action === 'merge') {
      const terms = (Array.isArray(args.terms) ? args.terms : []).map((t) => String(t)).filter(Boolean).slice(0, 20);
      if (terms.length < 2) {
        ctx.onStep('tidy_terms', 'error', 'terms 至少两个词条名');
        return { content: 'merge 需要在 terms 里给至少两个词条名（第一个为主词条），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `合并 ${terms.length} 个词条`);
      summary = mergeTerms(terms, ctx.ownerId);
    } else if (action === 'rename_domain') {
      const from = String(args.from ?? '').trim();
      const to = String(args.to ?? '').trim();
      if (!from || !to) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'rename_domain 需要 from（旧领域名）与 to（新领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `领域改名 ${from} → ${to}`);
      summary = renameDomain(from, to, ctx.ownerId);
    } else if (action === 'domain_add') {
      const name = String(args.domain ?? '').trim();
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'domain_add 需要 domain（新领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `新建领域 ${name}`);
      summary = domainAdd(name, String(args.note ?? ''), ctx.ownerId);
    } else if (action === 'domain_remove') {
      const name = String(args.domain ?? '').trim();
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'domain_remove 需要 domain（要删除的领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `删除领域 ${name}`);
      summary = domainRemove(name, ctx.ownerId);
    } else {
      ctx.onStep('tidy_terms', 'error', '未知 action');
      return {
        content: 'tidy_terms 的 action 只能是 auto / merge / rename_domain / domain_add / domain_remove，请重新调用。',
      };
    }
    const done =
      summary.message ??
      (summary.before !== undefined && summary.after !== undefined ? `词条 ${summary.before} → ${summary.after} 条` : '完成');
    ctx.onStep('tidy_terms', summary.result === 'error' ? 'error' : 'done', done);
    return { content: tidyResultContent(summary) };
  },
});
