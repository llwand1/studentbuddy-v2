/**
 * chat/tools/web-search —— `search_web`（从 chat/tools.ts 原样搬入，逻辑零改动）。
 *
 * description 的写法教训留在定义注释里，别在后续改写时丢掉。
 */
import { resultsToContext } from '../../search/index.js';
import { searchExamWeb } from '../../search/exam-search.js';
import { loadExamContext } from '../../learning/exam-mode.js';
import { registerTool } from './registry.js';

registerTool('search_web', {
  definition: {
    type: 'function',
    function: {
      name: 'search_web',
      // description 是**写给模型的提示词**（2026-09-17 重写）：原先只有一句
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
    // ★ 搜索 key 现在**每用户一份**（v30 归主）⇒ 必须带 `ctx.ownerId`，
    //   漏传的后果是「读不到自己配的 key ⇒ 静默退回 Bing 免费通道」（功能还在、质量降级、不报错）。
    // 应试模式（EXAM-1004）：聊天里搜到的东西用户也看得见，所以这条链路同样过白名单——
    // 只闸出题不闸聊天，就会出现「题卡干净、回答里引着范围外的站」，那是假承诺。
    const exam = loadExamContext(ctx.ownerId ?? null);
    if (exam.on && exam.hosts.length === 0) {
      ctx.onStep('search_web', 'error', '应试范围为空');
      return {
        content:
          `学习者开启了**应试模式**，但还没有选择考试范围，因此本轮不允许联网检索。` +
          `请如实告诉学习者「先在设置里选择应试范围」，本轮只基于已有资料与常识作答；不要声称没有联网能力。`,
      };
    }
    const { results, providers, failed, dropped, unavailable } = await searchExamWeb(
      query,
      ctx.ownerId ?? null,
      exam,
      { signal: ctx.signal },
    );
    if (results.length === 0) {
      if (exam.on) {
        if (unavailable ?? (providers.length === 0 && failed.length > 0)) {
          ctx.onStep('search_web', 'error', '本次检索通道暂不可用');
          return { content: '本次范围内检索通道暂不可用。请如实说明本次未取到资料，稍后重试；不要说范围内没有资料，也不要编造来源网址。' };
        }
        // 范围内的零结果≠通用零结果：行动是「扩范围」或「换词」，不是「重试」。
        // 不分开就会重演 2026-09-17 那次的口径事故——模型把内部限制转述成「我没有联网功能」。
        ctx.onStep('search_web', 'done', `范围内无结果（范围：${exam.summary}）`);
        return {
          content:
            `在学习者设定的应试范围内（${exam.summary || '未选范围'}），本次检索预算内没有找到可用参考资料。` +
            '已尝试通用检索及所选站点的补充检索；本轮不要仅换措辞重复搜索，' +
            '请如实告诉学习者「所选范围内没找到」，可建议调整范围或提供具体资料。' +
            '不要说自己没有联网能力，不要编造、引用或推荐未经检索的网址。',
        };
      }
      // 回灌口径（2026-09-17 重写）：此前把「未配置搜索 key（免 key 兜底）/
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
    ctx.onStep(
      'search_web',
      'done',
      `${results.length} 条结果${from.length > 0 ? `（来源 ${from.join('、')}）` : '（缓存）'}${
        exam.on ? `｜已按应试范围过滤，剔除范围外 ${dropped} 条` : ''
      }`,
    );
    // 资料溯源：结果上架并拿全轮编号——回灌给模型的 [n] 与右侧面板的 n 必须是同一个数
    const numbers = ctx.sources?.found(query, results);
    return {
      content:
        (exam.on ? `以下结果都在学习者设定的应试范围内（${exam.summary}），范围外的站点本轮不予呈现：\n\n` : '') +
        resultsToContext(results, numbers),
    };
  },
});
