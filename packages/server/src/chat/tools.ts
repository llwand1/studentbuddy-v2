/**
 * chat/tools — 原生工具注册表（单轨 function-calling，G3）。
 * 每工具一函数；新增工具=在此注册，flow 循环零改动。
 */
import type { ToolDefinition } from '../llm/types.js';
import type { TidySummary } from '@sb/shared';
import type { GrillPhase } from '@sb/shared';
import { searchWeb, resultsToContext } from '../search/index.js';
import { tidyTerms, mergeTerms, renameDomain } from '../learning/tidy.js';
import { createDomain, removeDomain } from '../learning/domains.js';
import { saveOneTerm, updateTerm, removeTerm, findTermByName } from '../learning/terms.js';
import { CHOICE_TOOL, runChoiceTool } from './choice-tool.js';

export interface ToolContext {
  /** 工具步骤回调（step 事件上屏） */
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string) => void;
  /**
   * 会话级中止信号（v13 体验升级）：透传进工具内部 fetch，「停止生成」真掐断联网请求，
   * 不再只是把结果丢弃后干等超时。工具实现自行与本地超时合并（search 用 AbortSignal.any）。
   */
  signal?: AbortSignal;
  /**
   * 所属会话 id（2026-09-14，方案选择框）：`ask_choice` 要把提问绑到当前会话，答复才能续回这一轮。
   * 可选——不依赖会话的工具（搜索 / 词条）无需关心它，既有工具桩也不必改。
   */
  sessionId?: string;
  /**
   * grill-me 阶段（v18）：有值表示这次 `ask_choice` 是 grill-me 强绑产生的，
   * 会随提问一起下发，前端据此决定「选完是续本轮还是开新一轮」。普通触发不带。
   */
  grillPhase?: GrillPhase;
  /**
   * 归属用户 id（M2c，契约 `docs/TENANCY-SPEC.md` §8.1.4）：工具里发起的 LLM 调用记在谁头上。
   * 目前只有 `tidy_terms` 的 auto 分支会用（整理方案是一次模型调用）；`null` = 平台通道。
   * 可选——不碰模型的工具（搜索 / 词条增删）无需关心它，既有工具桩也不必改。
   */
  ownerId?: string | null;
}

export interface ToolResult {
  /** 回灌给模型的 tool 消息内容 */
  content: string;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const registry = new Map<string, RegisteredTool>();

registry.set('search_web', {
  definition: {
    type: 'function',
    function: {
      name: 'search_web',
      // description 是**写给模型的提示词**（2026-09-17 重写，bug-ledger B-006）：原先只有一句
      // 名词短语，模型读不出「这是我随时能调、而且该主动调的能力」。改为正面陈述 + 触发场景 + 示例
      // （同 `chat/choice-tool.ts` 的写法：正面为主，否定条款只留必要的）。
      description:
        '联网搜索。你**具备**这个能力，可随时调用。适用：学习者说"搜一下/联网查/查最新/百度一下"、' +
        '要核实不熟悉的人名/品牌/名词/事件、时效性问题（最新进展、今天的新闻、实时数据）、找资料找题。' +
        '示例：学习者说「牛来是什么」→ 直接调 search_web({query:"牛来"})。' +
        '他给的词再模糊也先用它搜一次，不要反问他搜什么。返回带来源的搜索结果；确实无结果时如实说明"这次没搜到"。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词（中文即可）' } },
        required: ['query'],
      },
    },
  },
  async run(args, ctx) {
    const query = String(args.query ?? '').trim().slice(0, 100);
    if (!query) {
      ctx.onStep('search_web', 'error', '搜索词为空');
      return { content: '搜索词为空，请带 query 重新调用 search_web。' };
    }
    ctx.onStep('search_web', 'running', query);
    // ★ M2d：搜索 key 现在**每用户一份**（v30 归主）⇒ 必须带 `ctx.ownerId`，
    //   漏传的后果是「读不到自己配的 key ⇒ 静默退回 Bing 免费通道」（功能还在、质量降级、不报错）。
    const { results, providers, failed } = await searchWeb(query, ctx.ownerId ?? null, { signal: ctx.signal });
    if (results.length === 0) {
      // 回灌口径（2026-09-17 重写，bug-ledger B-006）：此前把「未配置搜索 key（免 key 兜底）/
      // 本网络可能不可达」这类**内部配置细节**直接甩给模型，模型转述出来就成了"我没有联网功能"
      // ——2026-09-09 那轮「我无法获取今日新闻，因为…没有联网功能」正是这段话的产物；
      // 末尾那句「或基于已有知识回答」又给了它一个放弃的台阶。
      // 故改为：① 不暴露配置细节；② 明确「你有这能力，只是这次没命中」；③ 不给放弃的台阶。
      const guide =
        '本次联网检索没有返回结果。你**具备**联网检索能力，只是这一次没命中（可换更具体的词再试一次）；' +
        '仍无结果就如实告诉学习者"这次没搜到"，但不要说自己没有联网能力。';
      ctx.onStep('search_web', 'error', failed.join('; ') || '无结果');
      return { content: `${guide} [检索通道返回：${failed.join('; ') || '无结果'}]` };
    }
    const from = providers.filter((p) => p !== 'cache');
    ctx.onStep('search_web', 'done', `${results.length} 条结果${from.length > 0 ? `（来源 ${from.join('、')}）` : '（缓存）'}`);
    return { content: resultsToContext(results) };
  },
});

/** 词条整理结果回灌：给模型自然语言汇报的口径，不让它原样甩 JSON 给用户 */
function tidyResultContent(summary: TidySummary): string {
  return `词条库整理结果（请用简洁的自然语言向用户汇报要点，不要原样输出本 JSON）：${JSON.stringify(summary)}`;
}

/**
 * 领域新建/删除的工具侧包装（v19：领域与词条 CRUD 对等）。
 * 把域层异常转成 `TidySummary.error`——工具层的报错口径统一走 `tidyResultContent`，
 * 不让 `DomainError`（带 HTTP status，是给路由用的）直接冒到工具层。
 */
function domainAdd(name: string, note: string): TidySummary {
  try {
    const { row, created } = createDomain(name, note.trim());
    return { result: 'ok', message: created ? `已新建领域「${row.name}」` : `领域「${row.name}」已存在，未重复创建` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '新建领域失败' };
  }
}

function domainRemove(name: string): TidySummary {
  try {
    const r = removeDomain(name);
    return { result: 'ok', message: `已删除领域「${r.name}」，${r.moved} 条词条转入「${r.target}」（词条一条未删）` };
  } catch (err) {
    return { result: 'error', message: err instanceof Error ? err.message : '删除领域失败' };
  }
}

registry.set('tidy_terms', {
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
      summary = mergeTerms(terms);
    } else if (action === 'rename_domain') {
      const from = String(args.from ?? '').trim();
      const to = String(args.to ?? '').trim();
      if (!from || !to) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'rename_domain 需要 from（旧领域名）与 to（新领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `领域改名 ${from} → ${to}`);
      summary = renameDomain(from, to);
    } else if (action === 'domain_add') {
      const name = String(args.domain ?? '').trim();
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'domain_add 需要 domain（新领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `新建领域 ${name}`);
      summary = domainAdd(name, String(args.note ?? ''));
    } else if (action === 'domain_remove') {
      const name = String(args.domain ?? '').trim();
      if (!name) {
        ctx.onStep('tidy_terms', 'error', '缺少领域名');
        return { content: 'domain_remove 需要 domain（要删除的领域名），请重新调用 tidy_terms。' };
      }
      ctx.onStep('tidy_terms', 'running', `删除领域 ${name}`);
      summary = domainRemove(name);
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

registry.set('manage_terms', {
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
      const row = saveOneTerm(term, definition, domain);
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
      const hit = findTermByName(term);
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
      const row = updateTerm(hit.id, patch);
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
        const hit = findTermByName(name);
        if (hit) {
          removeTerm(hit.id);
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

// 方案选择框（2026-09-14 契约 docs/ASK-CHOICE-SPEC.md）：AI 主动提问 → 学习者点选 → 同轮继续。
// 定义与执行在 chat/choice-tool.ts，本文件只做注册——工具清单的唯一入口仍在这里，不开第二份。
registry.set('ask_choice', { definition: CHOICE_TOOL, run: runChoiceTool });

export function toolDefinitions(): ToolDefinition[] {
  return [...registry.values()].map((t) => t.definition);
}

export function toolNames(): string[] {
  return [...registry.keys()];
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    ctx.onStep(name, 'error', '未知工具');
    return { content: `未知工具：${name}` };
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    ctx.onStep(name, 'error', '参数 JSON 解析失败');
    return { content: '工具参数 JSON 解析失败' };
  }
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    ctx.onStep(name, 'error', err instanceof Error ? err.message : String(err));
    return { content: `工具执行失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
