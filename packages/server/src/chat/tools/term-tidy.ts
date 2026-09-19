/**
 * chat/tools/term-tidy —— `tidy_terms`（S1 从 chat/tools.ts 原样搬入；P3 起走 §4.6 两阶段）。
 * 词条库「整理」语义：合并不删除；领域 CRUD 与词条 CRUD 对等（v19）。
 *
 * P3 改造（契约 §5.1「现役改造」行 + TERM-TIDY-SPEC v1.1 注记）：
 * - `auto` 由「拿方案直接改库」改走 plan（出方案只算不改）→ >阈值 弹卡 → apply；
 *   ≤阈值 路径与 merge/rename 的回灌文案、step 口径**逐字保留**（新旧双跑快照锁）；
 * - `affected` 算法与快照差集记在 `term-tidy-support.ts`（400 行红线拆件，纯策略可单测）；
 * - apply 前**重校验**（§4.6-5）：同算法在新鲜行集上重算，计数不符即整批中止如实报——
 *   「批 A 跑 A」，确认间隙被 UI 改过就让模型重新发起，不执行半个方案；
 * - 合并/改名物理删除被并行的场景，执行后按 before/after 行差集写删除快照（§4.5，
 *   tool 标 `tidy_terms:auto`/`tidy_terms:merge`/`tidy_terms:rename_domain`），
 *   词条页「撤销这 N 条」同样覆盖 tidy 的删除。
 *
 * ★ 拆件后本文件只剩「注册定义 + 五个 action 的 plan/apply 编排」——每个 apply 都遵守
 *   同一条序列：重校验 → 域层执行 → 差集快照 → tidyTail 收尾（口径只有一份，不各写各的）。
 */
import { applyTidy, mergeTerms, normalizeTidyPlan, renameDomain } from '../../learning/tidy.js';
import { TOOL_LLM_INNER_TIMEOUT_MS } from '@sb/shared';
import { registerTool } from './registry.js';
import {
  abortStalePlan,
  domainAdd,
  domainRemove,
  logTidyDeletions,
  mergeRowsFound,
  normName,
  ownerRows,
  planTidyWithRetry,
  registeredDomains,
  tidyAffectedOf,
  tidyPlanItems,
  tidyResultContent,
  tidyTail,
} from './term-tidy-support.js';

registerTool('tidy_terms', {
  definition: {
    type: 'function',
    function: {
      name: 'tidy_terms',
      description:
        '维护词条库（术语记忆库）。用户提到整理/清理词条库、词条太多太乱、合并同义词、领域归组/归类、' +
        '给领域改名、新建或删除领域时调用。整理只合并不删除概念；删除领域也不删词条（词条转入 general）。' +
        '影响条数超过确认阈值会先弹确认卡，被拒绝或超时就不要重试。',
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
  // §4.2 元数据：写库 ⇒ write；auto 的**方案产出**在 planWrite 阶段内部调模型，
  // write 档 30s 不够，逐工具显式超时保留（v1.3 拍板⑪）。P3 起 planWrite 在场
  // 还会再加 CONFIRM_TIMEOUT_MS 余量（tool-timeout.ts）：先等模型出方案、再等人批准。
  kind: 'write',
  timeoutMs: TOOL_LLM_INNER_TIMEOUT_MS,
  async planWrite(args, ctx) {
    const action = normName(args.action);

    if (action === 'auto') {
      ctx.onStep('tidy_terms', 'running', '正在整理词条库');
      const { plan, err } = await planTidyWithRetry(ctx.ownerId);
      if (!plan) {
        // 出方案失败＝零改动，apply 里保持老 tidyTerms 的报错文案（ADR-4 如实报）
        const content = tidyResultContent({
          result: 'error',
          message: `整理引擎调用失败（已自动重试仍失败）：${err || '模型未返回有效方案'}，请稍后再试`,
        });
        return {
          affected: 0,
          actionSummary: '整理引擎未产出方案',
          items: [],
          apply: async () => ({ content, meta: { affected: 0 } }),
        };
      }
      const rows = ownerRows(ctx.ownerId);
      const affected = tidyAffectedOf(plan, rows);
      if (affected === 0) {
        // 空方案：老路径也是 applyTidy 的 noop 收尾（before/after 同数），等价转交
        return {
          affected: 0,
          actionSummary: '词条库现状良好，无需整理',
          items: [],
          apply: async () => tidyTail(ctx, applyTidy(plan, ctx.ownerId), 0),
        };
      }
      return {
        affected,
        actionSummary: `按 AI 方案整理词条库（合并簇 + 领域归一，共影响 ${affected} 条）`,
        items: tidyPlanItems(plan, rows),
        apply: async () => {
          const fresh = ownerRows(ctx.ownerId);
          const re = normalizeTidyPlan(plan, fresh);
          const now = tidyAffectedOf(re, fresh);
          if (now !== affected) return abortStalePlan(ctx, affected, now);
          const summary = applyTidy(re, ctx.ownerId);
          logTidyDeletions('tidy_terms:auto', fresh, ctx.ownerId);
          return tidyTail(ctx, summary, now);
        },
      };
    }

    if (action === 'merge') {
      const terms = (Array.isArray(args.terms) ? args.terms : []).map((t) => String(t)).filter(Boolean).slice(0, 20);
      if (terms.length < 2) {
        ctx.onStep('tidy_terms', 'error', 'terms 至少两个词条名');
        return {
          affected: 0,
          actionSummary: '参数不足',
          items: [],
          apply: async () => ({
            content: 'merge 需要在 terms 里给至少两个词条名（第一个为主词条），请重新调用 tidy_terms。',
            meta: { affected: 0 },
          }),
        };
      }
      ctx.onStep('tidy_terms', 'running', `合并 ${terms.length} 个词条`);
      const rows = ownerRows(ctx.ownerId);
      const { found, missing } = mergeRowsFound(terms, rows);
      if (missing.length > 0 || found.length < 2) {
        // 名不齐/已是同一条：老路径由 mergeTerms 自己报 error/noop，等价转交（不写库）
        return {
          affected: 0,
          actionSummary: '合并对象不齐',
          items: [],
          apply: async () => tidyTail(ctx, mergeTerms(terms, ctx.ownerId), 0),
        };
      }
      return {
        affected: found.length,
        actionSummary: `合并 ${found.length} 条词条为「${found[0]?.term ?? terms[0]}」`,
        items: found.map((r) => `${r.term}［${r.domain}］`),
        apply: async () => {
          const fresh = ownerRows(ctx.ownerId);
          const now = mergeRowsFound(terms, fresh);
          if (now.missing.length > 0 || now.found.length !== found.length) {
            return abortStalePlan(ctx, found.length, now.found.length);
          }
          const summary = mergeTerms(terms, ctx.ownerId);
          logTidyDeletions('tidy_terms:merge', fresh, ctx.ownerId);
          return tidyTail(ctx, summary, summary.result === 'ok' ? found.length : 0);
        },
      };
    }

    if (action === 'rename_domain') {
      const from = normName(args.from);
      const to = normName(args.to);
      if (!from || !to) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return {
          affected: 0,
          actionSummary: '参数不足',
          items: [],
          apply: async () => ({
            content: 'rename_domain 需要 from（旧领域名）与 to（新领域名），请重新调用 tidy_terms。',
            meta: { affected: 0 },
          }),
        };
      }
      ctx.onStep('tidy_terms', 'running', `领域改名 ${from} → ${to}`);
      const f = from.trim().toLowerCase(); // 与 renameDomain 内部同口径
      const t = to.trim().toLowerCase().slice(0, 30);
      const moved = ownerRows(ctx.ownerId).filter((r) => r.domain === f).length;
      return {
        affected: moved,
        actionSummary: `领域「${f}」改名为「${t}」（${moved} 条词条随行）`,
        items: [`领域改名 ${f} → ${t}：${moved} 条词条`],
        apply: async () => {
          const fresh = ownerRows(ctx.ownerId);
          const nowMoved = fresh.filter((r) => r.domain === f).length;
          if (nowMoved !== moved) return abortStalePlan(ctx, moved, nowMoved);
          const summary = renameDomain(from, to, ctx.ownerId);
          if (summary.result === 'ok') logTidyDeletions('tidy_terms:rename_domain', fresh, ctx.ownerId);
          return tidyTail(ctx, summary, summary.result === 'ok' ? moved : 0);
        },
      };
    }

    if (action === 'domain_add') {
      const name = normName(args.domain);
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return {
          affected: 0,
          actionSummary: '参数不足',
          items: [],
          apply: async () => ({
            content: 'domain_add 需要 domain（新领域名），请重新调用 tidy_terms。',
            meta: { affected: 0 },
          }),
        };
      }
      ctx.onStep('tidy_terms', 'running', `新建领域 ${name}`);
      const exists = registeredDomains(ctx.ownerId).has(name.trim().toLowerCase());
      return {
        affected: exists ? 0 : 1,
        actionSummary: exists ? `领域「${name}」已存在（核对后零改动）` : `新建领域「${name}」`,
        items: [`${exists ? '已存在' : '新建'}领域 ${name}`],
        apply: async () => {
          const summary = domainAdd(name, normName(args.note), ctx.ownerId);
          return tidyTail(ctx, summary, summary.result === 'ok' && !exists ? 1 : 0);
        },
      };
    }

    if (action === 'domain_remove') {
      const name = normName(args.domain);
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return {
          affected: 0,
          actionSummary: '参数不足',
          items: [],
          apply: async () => ({
            content: 'domain_remove 需要 domain（要删除的领域名），请重新调用 tidy_terms。',
            meta: { affected: 0 },
          }),
        };
      }
      ctx.onStep('tidy_terms', 'running', `删除领域 ${name}`);
      const d = name.trim().toLowerCase();
      const rows = ownerRows(ctx.ownerId);
      const moved = rows.filter((r) => r.domain === d).length;
      const known = registeredDomains(ctx.ownerId).has(d);
      return {
        affected: known ? (moved > 0 ? moved : 1) : 0,
        actionSummary: known ? `删除领域「${d}」（${moved} 条词条转入 general，词条不删）` : `领域「${d}」不存在`,
        items: [known ? `删除领域 ${d}：${moved} 条词条转 general` : `领域 ${d} 不在册`],
        apply: async () => {
          const nowMoved = ownerRows(ctx.ownerId).filter((r) => r.domain === d).length;
          if (nowMoved !== moved) return abortStalePlan(ctx, known ? moved : 0, nowMoved);
          const summary = domainRemove(name, ctx.ownerId);
          return tidyTail(ctx, summary, summary.result === 'ok' ? (moved > 0 ? moved : 1) : 0);
        },
      };
    }

    ctx.onStep('tidy_terms', 'error', '未知 action');
    return {
      affected: 0,
      actionSummary: '参数不合法',
      items: [],
      apply: async () => ({
        content: 'tidy_terms 的 action 只能是 auto / merge / rename_domain / domain_add / domain_remove，请重新调用。',
        meta: { affected: 0 },
      }),
    };
  },
});
