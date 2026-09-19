/**
 * chat/tools/term-manage —— `manage_terms`（从 chat/tools.ts 原样搬入 S1 拆目录，逻辑零改动）。
 * 词条 CRUD 对（add/update/delete），与 tidy_terms（批量整理）互补：按词条名定位，模型不接触 id。
 */
import { saveOneTerm, updateTerm, removeTerm, findTermByName } from '../../learning/terms.js';
import { registerTool } from './registry.js';

registerTool('manage_terms', {
  definition: {
    type: 'function',
    function: {
      name: 'manage_terms',
      description:
        '直接改写词条库（术语记忆库）：添加新词条、修改已有词条的释义/领域/重要度、删除词条。' +
        '用户让你「记一下 XX」「把 XX 加进词条库」「改一下 XX 的释义」「删掉 XX 词条」时调用。' +
        '同名合并/领域归组等整理操作请用 tidy_terms；按词条名定位，不需要 id。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'update', 'delete'],
            description: 'add=添加（或覆盖已有同名词条的释义）；update=修改已有词条；delete=删除词条',
          },
          term: {
            type: 'string',
            description: '词条名。add/update 必填；delete 给单个词条名时可用',
          },
          terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'delete 可用：一次删除多个词条名（最多 20 个）',
          },
          definition: { type: 'string', description: 'add 必填 / update 可选：释义' },
          domain: { type: 'string', description: 'add/update 可选：领域（如 math/cs/english，默认 general）' },
          importance: { type: 'number', description: 'update 可选：重要度 0-1（0.5 默认，越核心越高）' },
        },
        required: ['action'],
      },
    },
  },
  // §4.2 元数据：归属写操作。delete 分支是 P3 确认门（needsConfirm='by_size'→按批快照）的第一个客户，
  // P2 只标 kind 不拦截。
  kind: 'write',
  async run(args, ctx) {
    const action = String(args.action ?? '').trim();
    // ── add：saveOneTerm 已含防再分裂（同词同域/别名命中则改走更新释义）──
    if (action === 'add') {
      const term = String(args.term ?? '').trim();
      const definition = String(args.definition ?? '').trim();
      if (!term || !definition) {
        ctx.onStep('manage_terms', 'error', 'add 需要 term 与 definition');
        return { content: 'add 需要 term（词条名）与 definition（释义），请带齐参数重新调用 manage_terms。' };
      }
      const domain = String(args.domain ?? '').trim() || undefined;
      const row = saveOneTerm(term, definition, domain, ctx.ownerId);
      ctx.onStep('manage_terms', 'done', `词条「${row.term}」已入库（${row.domain}）`);
      return {
        content: `词条已入库：${row.term}（领域 ${row.domain}）。请用一句话向用户确认，不要输出本 JSON。`,
      };
    }
    // ── update：按名定位 → updateTerm（id 由服务端解析，模型不接触 id）──
    if (action === 'update') {
      const term = String(args.term ?? '').trim();
      if (!term) {
        ctx.onStep('manage_terms', 'error', 'update 需要 term');
        return { content: 'update 需要 term（要修改的词条名），请重新调用 manage_terms。' };
      }
      const hit = findTermByName(term, ctx.ownerId);
      if (!hit) {
        ctx.onStep('manage_terms', 'error', `词条「${term}」不存在`);
        return {
          content: `词条库里没找到「${term}」（别名也不命中）。可以先调 manage_terms(action=add) 新建，或向用户确认名称。`,
        };
      }
      const patch: { definition?: string; domain?: string; importance?: number } = {};
      if (typeof args.definition === 'string' && args.definition.trim()) patch.definition = args.definition.trim();
      if (typeof args.domain === 'string' && args.domain.trim()) patch.domain = args.domain.trim();
      if (typeof args.importance === 'number' && Number.isFinite(args.importance)) patch.importance = args.importance;
      if (Object.keys(patch).length === 0) {
        ctx.onStep('manage_terms', 'error', 'update 缺少要改的字段');
        return { content: 'update 至少要给 definition / domain / importance 之一，请重新调用 manage_terms。' };
      }
      const row = updateTerm(hit.id, patch, ctx.ownerId);
      ctx.onStep('manage_terms', 'done', `词条「${row?.term ?? term}」已更新`);
      return {
        content: `词条已更新：${row?.term ?? term}（领域 ${row?.domain ?? '?'}）。请用一句话向用户确认改了什么，不要输出本 JSON。`,
      };
    }
    // ── delete：term 或 terms（批量 ≤20），逐条按名定位后删 ──
    if (action === 'delete') {
      const names = Array.isArray(args.terms)
        ? args.terms.map((t) => String(t)).filter(Boolean)
        : [String(args.term ?? '').trim()];
      const list = [...new Set(names)].filter(Boolean).slice(0, 20);
      if (list.length === 0) {
        ctx.onStep('manage_terms', 'error', 'delete 需要 term 或 terms');
        return { content: 'delete 需要 term（单个词条名）或 terms（词条名列表），请重新调用 manage_terms。' };
      }
      const removed: string[] = [];
      const missing: string[] = [];
      for (const name of list) {
        const hit = findTermByName(name, ctx.ownerId);
        if (hit) {
          removeTerm(hit.id, ctx.ownerId);
          removed.push(hit.term);
        } else {
          missing.push(name);
        }
      }
      ctx.onStep(
        'manage_terms',
        removed.length > 0 ? 'done' : 'error',
        `删除 ${removed.length} 条${missing.length > 0 ? `，未找到 ${missing.length} 条` : ''}`,
      );
      const parts = [`已删除 ${removed.length} 条${removed.length > 0 ? `：${removed.join('、')}` : ''}`];
      if (missing.length > 0) parts.push(`词条库里没有：${missing.join('、')}`);
      return { content: `${parts.join('；')}。请用自然语言向用户汇报，不要输出本 JSON。` };
    }
    ctx.onStep('manage_terms', 'error', '未知 action');
    return { content: 'manage_terms 的 action 只能是 add / update / delete，请重新调用。' };
  },
});
