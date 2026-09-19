/**
 * chat/tools/web-search —— `search_web`（从 chat/tools.ts 原样搬入 S1 拆目录，逻辑零改动）。
 *
 * description 的写法教训（bug-ledger B-006）留在定义注释里，别在后续改写时丢掉。
 */
import { searchWeb, resultsToContext } from '../../search/index.js';
import { registerTool } from './registry.js';

registerTool('search_web', {
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
  // §4.2 元数据：network 档 60s（免 key 兜底已知可挂 ~20s）；只读检索同参重放无副作用 ⇒
  // idempotent 成立，够 §4.3-5「network + idempotent 才重试 1 次」的资格。
  kind: 'network',
  idempotent: true,
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
