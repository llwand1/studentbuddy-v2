/**
 * agent-bench/lib/tools-mirror —— 生产 12 工具的**镜像定义**（给评测跑分器下发用）。
 *
 * ★ 为什么是镜像而不是直接 import：现役定义在 `packages/server/src/chat/tools/*.ts`（TS + 注册表
 *   带 DB 上下文），零依赖 .mjs 跑分器引不动。镜像的腐烂风险用 `assertMirrorsProduction()` 顶住：
 *   selftest 时逐字核「工具名集合」与「每个工具的 required 列表」都能在生产源码里找到，
 *   漂移即红（同 model-bench `lib/solver.mjs` 的 assertMirrorsProduction 手法）。
 * ★ description **逐字取自生产源码**（description 是写给模型的提示词，改一个字就是换了道题）；
 *   模板插值（TOPIC_MAX / PK_INVITE_REASON_MAX / MAX_QUIZ_TOTAL）按 shared 常量的当前值展开。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 与 shared 常量对齐（assertMirrorsProduction 会核）：MAX_QUIZ_TOTAL=20, TOPIC_MAX=20, PK_INVITE_REASON_MAX=80 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        '联网搜索。你**具备**这个能力，可随时调用。适用：学习者说"搜一下/联网查/查最新/百度一下"、要核实不熟悉的人名/品牌/名词/事件、时效性问题（最新进展、今天的新闻、实时数据）、找资料找题。示例：学习者说「牛来是什么」→ 直接调 search_web({query:"牛来"})。他给的词再模糊也先用它搜一次，不要反问他搜什么。返回带来源的搜索结果；确实无结果时如实说明"这次没搜到"。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词（中文即可）' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        '读取指定网址的正文。你**具备**这个能力，可随时调用。适用：搜索结果的摘要不够、需要看完整内容时；学习者直接给了网址说"看看这个/这个链接讲了什么"时；要核实某页面的具体说法时。示例：搜索结果里有条百科链接但摘要太短 → 直接调 fetch_page({url:"https://…"})。返回该页正文纯文本；读不到时如实说明原因，**不要编造页面内容**。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要读取的完整网址（http/https）' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_image',
      description:
        '把网页上的图片搬到回答里，让学习者直接看到图。你**具备**这个能力，可随时调用。适用：学习者给了图片的网址、说"看看这张图/把这张图发我/这链接里的图是什么"、或你想让他**直接看到**某张图而不是只听文字描述时。调用后返回一个图片地址，**你要把它用 Markdown 图片语法写进正文**（`![说明](地址)`）。取不到、不是图片或图太大时如实说明原因，**不要编造图里画的是什么**。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '图片的完整网址（http/https）' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_images',
      description:
        '从网上找真实的图片（照片、示意图、地图、名画、标本……）放进回答，让学习者直接看到。你**具备**这个能力。适用：讲到具体的事物、结构、地点、历史文物、艺术作品，一张图胜过一段描述时；学习者说「给我看看/有图吗/长什么样」时。每张图都会先经过看图核验，确认真的是这个东西才会返回。query 写**具体的名词**（英文检索词命中率更高，例如 "animal mitochondrion diagram"、"Terracotta Army"）；subject 用中文写这张图应当展示什么（例如「线粒体的结构」）。返回的 Markdown 要**原样**放进正文（图片那行和署名那行都要）。找不到就如实说，不要编造图片地址或图里的内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '图片检索词：具体名词，英文优先' },
          subject: { type: 'string', description: '这张图应当展示什么（中文，一句话）' },
          count: { type: 'integer', description: '要几张（1–3，默认 1）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_terms',
      description:
        '查询词条库（术语记忆库）：按领域或词条名前缀筛选，附带各领域条数统计。用户问「我库里有哪些词条」「math 领域记了什么」「查一下 XX 词条」时调用。只读，不改任何东西。',
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
  {
    type: 'function',
    function: {
      name: 'upsert_term',
      description:
        '新增或修改一条词条（一次只动一条）：词条已存在（含别名命中）则更新释义等字段，不存在则新建。用户说「这个词记一下」「把 XX 的释义改成…」时调用。删除请用 delete_terms，本工具不删。',
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
  {
    type: 'function',
    function: {
      name: 'delete_terms',
      description:
        '删除词条（一批一个确认，用户批准后才执行；删后可在词条页整批撤销）。用户明确说「删掉 XX 词条」「把这几条清了」时调用。terms 给词条名、ids 给词条 id，单次合计 ≤50 条。名字找不到的绝不模糊匹配着删——未找到的会如实报告给你。',
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
  {
    type: 'function',
    function: {
      name: 'tidy_terms',
      description:
        '维护词条库（术语记忆库）。用户提到整理/清理词条库、词条太多太乱、合并同义词、领域归组/归类、给领域改名、新建或删除领域时调用。整理只合并不删除概念；删除领域也不删词条（词条转入 general）。影响条数超过确认阈值会先弹确认卡，被拒绝或超时就不要重试。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['auto', 'merge', 'rename_domain', 'domain_add', 'domain_remove'],
            description:
              'auto=全量整理（AI 判断同义词合并与领域归一）；merge=把用户点名的几个词条合并成一条；rename_domain=领域改名；domain_add=新建领域（可零词条，先建好领域再放词）；domain_remove=删除领域（**词条转入 general，不删词条**）',
          },
          terms: { type: 'array', items: { type: 'string' }, description: 'merge 时必填：要合并的词条名列表，第一个为主词条' },
          from: { type: 'string', description: 'rename_domain 时必填：旧领域名' },
          to: { type: 'string', description: 'rename_domain 时必填：新领域名' },
          domain: { type: 'string', description: 'domain_add / domain_remove 时必填：领域名' },
          note: { type: 'string', description: 'domain_add 可选：领域说明（一句话，也可留空）' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_quiz',
      description:
        '给学习者**出真题**：生成一组可点选作答、自动判分的练习题，题卡直接出现在对话里。适用：学习者要「出题／考我／来几道练习题／做测试／巩固一下／来套题」，或你判断该让他练一轮时。★ **要出题就必须调本工具**——在正文里用文字写题目（哪怕写成 1.2.3. 的练习样子）等于没出：没有题卡、他点选不了、也不会自动判分对错，而这些都是本产品出题的意义所在。参数：`topic` 说清出什么主题的题；`count` 只在学习者点名题量时给（省略＝用他在设置页配的题型配比）；`material` 可选，把你刚讲过、要针对它出题的要点原文放进来（省略时用本会话载入的资料，都没有就按主题出）；`search` 要时效性题目时才开。返回题干清单与统计（**不含答案**），题面不要再抄一遍。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '出题主题（如「高一数学 正弦定理」「词根 spect 的衍生词」）' },
          count: { type: 'integer', minimum: 1, maximum: 20, description: '本次题数；省略＝用设置里的配比' },
          material: { type: 'string', description: '可选：出题依据的材料原文（你刚讲过的要点、公式、课文片段）' },
          search: { type: 'boolean', description: '可选：本次是否联网检索真题材料，默认关' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '生成一张学习用的示意图，让学习者直接看到图。你**具备**这个能力，可随时调用。适用：概念示意、结构/流程/原理图解、学习者说"画个图/画给我看/示意图"，或你判断一张图比一段文字讲得更清楚时。prompt 要具体（画什么、怎么摆、标什么字）；调用后返回一个图片地址，**你要把它用 Markdown 图片语法写进正文**（`![说明](地址)`）。生成要等几秒钟；额度用完或失败时如实说明原因，**不要编造图里画的是什么**。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画什么，越具体越好（主体、布局、要标注的文字）' },
          size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], description: '可选，图的尺寸；不传用方形' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_choice',
      description:
        '提出方案让学习者选择，并**等待**他的选择——界面会弹出选择框，他点哪个你就拿到哪个，据此在同一轮继续。适用：方案对比、二选一、讲多深/按什么顺序、学习计划这类「存在多条合理路线、选错会浪费他时间」的岔路。要求：2~4 个选项，每个配一句取舍说明。不适用的情况：只是要你讲解某个概念、答案唯一确定——这些直接在回复里处理。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要学习者选择的问题（一句话说清分歧点）' },
          options: {
            type: 'array',
            description: '2~4 个候选方案，每个含一句话取舍说明',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '方案名（简短，一眼能分辨）' },
                description: { type: 'string', description: '一句话说明这个方案的取舍' },
              },
              required: ['label'],
            },
          },
          allowCustom: { type: 'boolean', description: '是否允许「以上都不是，我自己写」的自由输入出口（默认允许）' },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_pk_battle',
      description:
        '邀请学习者打一局 **AI 出题对战（PK）**：界面上会浮出一张可点「接受 / 拒绝」的卡片，主题就是他刚学的内容，接受后进入 8 分钟人机对战（双方互出题、AI 也会答题）。**本工具不等待他的决定**，调完请正常收尾本轮。该用的时机：你把**一段成体系的内容讲完**了（一个概念讲透、一组公式推导完、一篇课文过完），此刻检验他是否真会用的最好方式就是打一局。不该用的时机：他还在问基础概念、正在纠错、情绪明显不想练，或者本轮只是闲聊——那时发邀请是把「打断」当成「主动」。★ 若返回「本次没发出去」（他手上还挂着没答复的卡／刚发过／今天发够了），**这就是终点信号：不要重试、不要换个说法再发**，直接继续讲课。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '对战主题（≤20 字，取自当前对话，例如「高一数学 正弦定理」）' },
          reason: { type: 'string', description: '给学习者看的一句话：为什么现在值得打一局（≤80 字）' },
        },
        required: ['topic', 'reason'],
      },
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.function.name);

export function toolByName(name) {
  return TOOLS.find((t) => t.function.name === name) ?? null;
}

/**
 * 镜像与生产一致性断言（selftest 跑）：
 *  ① 工具名集合 ＝ 生产注册表实际注册的集合（解析 registerTool 调用，含常量名两处特例）；
 *  ② 每个镜像工具的 required 列表能在生产源码里逐字找到（防「生产改了必填、镜像还在放行」）。
 * 解析靠正则不靠编译——够用且零依赖；正则失手会体现为断言红，不会静默放过。
 */
export function assertMirrorsProduction(repoRoot) {
  const dir = join(repoRoot, 'packages/server/src/chat/tools');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
  files.push(join(repoRoot, 'packages/server/src/chat/choice-tool.ts'));
  let all = '';
  const registered = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    all += src;
    for (const m of src.matchAll(/registerTool\('([a-z_]+)'/g)) registered.add(m[1]);
    // 两处经由常量注册：generate-image.ts 的 IMAGE_TOOL_NAME、offer-pk-battle.ts 的 TOOL
    if (/registerTool\(IMAGE_TOOL_NAME/.test(src)) registered.add('generate_image');
    if (/registerTool\(TOOL,/.test(src) && /const TOOL = 'offer_pk_battle'/.test(src)) registered.add('offer_pk_battle');
  }
  const mirror = new Set(TOOL_NAMES);
  const missing = [...registered].filter((n) => !mirror.has(n));
  const extra = [...mirror].filter((n) => !registered.has(n));
  if (missing.length || extra.length) {
    throw new Error(`工具镜像漂移：生产有而镜像缺 [${missing}]；镜像有而生产无 [${extra}]`);
  }
  for (const t of TOOLS) {
    const req = t.function.parameters.required;
    const needle = req.length ? `required: [${req.map((r) => `'${r}'`).join(', ')}]` : 'required: []';
    if (!all.includes(needle)) {
      throw new Error(`工具镜像漂移：${t.function.name} 的 ${needle} 在生产源码里找不到（生产改了必填列表？）`);
    }
  }
  return { tools: TOOL_NAMES.length };
}
