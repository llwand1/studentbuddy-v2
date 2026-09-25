/**
 * app/landing-data — 落地页**静态文案数据的唯一事实源**（2026-09-22 落地页重排批新建；
 * 同日中英切换批：全部字段转 `Bi = {zh,en}`，见 `landing-lang.tsx` 头注的成对理由）。
 *
 * ★ 为什么抽出来：老板 2026-09-22 点单「hero 排版有问题、雷点是先讲功能不讲产品」，
 *   落地页要按 T3「演示开道」版式重排，并在 hero 之后补一整段**产品整体介绍**。
 *   而 `Landing.tsx` 开工时已 294 行，`.tsx ≤300 行` 是 CI 硬红线（AGENTS.md「工程红线」）
 *   ⇒ 不抽，新内容**放不下**。但这只是抽文件的次要理由。
 *
 * ★ 主要理由是「**文案常量与渲染分层**」：本机那一整段自我介绍从前写在组件体里，
 *   于是「五环 / 九宫格 / 工程 / 隐私」这些列表既是数据也是组件的一部分，
 *   任何一处调序都要在 294 行里翻找。抽出来之后，**改文案改这里、改排版改组件**，
 *   两边互不干扰——这与本仓 `shared/` 契约先行的口径是同一件事，只是发生在前端展示层。
 *
 * ★ `icon` 一律只存**字符串 key**，不存组件本身：组件要从 `components/icons.tsx`（`.tsx`）
 *    import，本文件是 `.ts`，import 进来就把一个纯数据文件变成渲染依赖了——
 *   那样 AST/lint 上没错，但「数据可单测」这个性质会被悄悄用掉（同理 packs/eslint 的 gates）。
 *   key → 组件的映射单调地放在各消费组件里（`LandingFeatures` / `LandingIntro`）。
 *
 * ★ 每条 `desc` 都必须**对应得上代码里的真实行为**，不能是产品想象——
 *   本页此前已把「落地页写了其实没实现的功能」这个坑踩过一遍「落地页写的功能其实没实现」的坑
 *   （`README`徽章由 `tools/metrics.mjs` 守着就是这个缘故）。逐条依据见各常量上方注释。
 *   ★ 英文侧同理：**不许为了译顺而写进中文侧没有的承诺**，en 是 zh 的翻译不是第二份文案。
 */
import type { ComponentType } from 'react';
import type { Bi } from './landing-lang';

/** 落地页可选的 line-icon（与 `components/icons.tsx` 的导出一一对应，缺一个就编译不过） */
export type LandingIconKey = 'chat' | 'quiz' | 'stats' | 'cards' | 'check' | 'flow' | 'graph' | 'vs' | 'search' | 'doc';

/** key → 组件 的映射形状（消费点各自给出具体映射表，这里只定形状） */
export type LandingIconMap = Record<LandingIconKey, ComponentType<{ size?: number }>>;

/**
 * ★★ 功能区的**一步步动线**（2026-09-22 老板二次点单：「接下来的功能一步步讲」）。
 *
 * ★ 为什么把「五环」和「九宫格」合成这一张表：原先是**两套并列的东西**——
 *   五环讲链路、九宫格讲入口，读者看完只知道"有 5 个环、还有 9 个功能"，
 *   但**不知道 9 个功能各自在第几环上**。合成之后，每个功能都挂在自己那一步底下，
 *   "一步步讲"才真的成立：读者读到第 2 步，就知道第 2 步里有哪两个入口。
 *   ★ 这一步也顺手消掉一处隐患：两张表各维护一份文案，改一个功能要改两处，
 *     迟早有一处漏改——本仓 `RefList`/`ReviewPanel` 的先例就是这么漂出两种行为的。
 *
 * ★ `no` 存字符串而不是在组件里 `i + 1`：序号是**文案的一部分**（它要显示成 01/02），
 *   交给渲染时的下标算，就等于允许"调一下顺序，编号跟着变"——而编号是给读者看的路标。
 *
 * ★ 每一步的 `desc` 讲**这一步干什么**，`caps` 里的 `desc` 讲**这个入口具体是什么**。
 *   两级口径不许倒过来：倒过来就变成"九宫格换了个排版"，还是并列，不是动线。
 */
export type WalkStep = {
  no: string;
  step: Bi;
  title: Bi;
  desc: Bi;
  caps: Array<{ icon: LandingIconKey; title: Bi; desc: Bi }>;
};

/** 学 → 练 → 析 → 忆 → 反馈，五步相扣；九个一级入口各自挂在自己那一步上 */
export const WALK: WalkStep[] = [
  {
    no: '01',
    step: { zh: '学', en: 'Learn' },
    title: { zh: '对话讲解', en: 'Chat tutoring' },
    desc: {
      zh: '提问即开讲：流式回答、思考链可见，长资料与联网结果先进上下文再作答',
      en: 'Ask and it teaches: streamed answers, visible chain of thought; long docs and web results enter the context before the reply',
    },
    caps: [
      {
        icon: 'search',
        title: { zh: '联网检索', en: 'Web search' },
        desc: {
          zh: '三家搜索按 key 并行聚合 + 免 key 兜底，出网带 SSRF 护栏',
          en: 'Three engines aggregated in parallel per key + a key-free fallback; outbound fetch guarded against SSRF',
        },
      },
      {
        icon: 'doc',
        title: { zh: '文档模式', en: 'Document mode' },
        desc: {
          zh: '绑定长资料走 BM25 检索注入，带段号可溯源，70 万字资料也能对答',
          en: 'Bind a long doc and it answers via BM25 retrieval with traceable section numbers — even for 700k-character material',
        },
      },
      {
        icon: 'flow',
        title: { zh: '学习流编排', en: 'Study-flow builder' },
        desc: {
          zh: '把「讲解 → 出题 → 判分 → 复盘」拖成一条自己的学习流水线，预制模板开箱即用',
          en: 'Drag explain → quiz → grade → review into your own pipeline; ready-made templates included',
        },
      },
    ],
  },
  {
    no: '02',
    step: { zh: '练', en: 'Practice' },
    title: { zh: '出题练习', en: 'Quiz practice' },
    desc: {
      zh: '围绕刚学的词现出一套题，四题型配比可调，判分与解析自动给',
      en: 'Fresh question sets built around what you just learned; mix of four question types is tunable; grading and explanations come free',
    },
    caps: [
      {
        icon: 'quiz',
        title: { zh: '智能出题', en: 'Smart quiz-making' },
        desc: {
          zh: '题型配比可配、AI 特化 SVG 配图、五级解析阶梯——模型犯错不塌整组',
          en: 'Tunable type mix, purpose-built SVG figures, a five-tier parsing ladder — one malformed model output never sinks the whole set',
        },
      },
      {
        icon: 'vs',
        title: { zh: 'AI 对战', en: 'AI versus mode' },
        desc: {
          zh: '和 AI 出题官双人对战答题，移动优先的独立页面',
          en: 'Answer off against an AI question-master in a two-player duel, on a mobile-first standalone page',
        },
      },
    ],
  },
  {
    no: '03',
    step: { zh: '析', en: 'Analyze' },
    title: { zh: '薄弱分析', en: 'Weak-spot analysis' },
    desc: {
      zh: '逐题正确率落表，薄弱点自动定位，学习趋势看得见',
      en: 'Per-question accuracy lands on the table, weak spots get located automatically, and the trend is visible',
    },
    caps: [
      {
        icon: 'stats',
        title: { zh: '长期记忆', en: 'Long-term memory' },
        desc: {
          zh: '会话内先摘要再丢弃 + 跨会话画像恒注入，越用越懂你',
          en: 'Summarize-then-drop inside a session + a cross-session profile always injected — it learns you as you use it',
        },
      },
    ],
  },
  {
    no: '04',
    step: { zh: '忆', en: 'Remember' },
    title: { zh: '记忆沉淀', en: 'Memory building' },
    desc: {
      zh: '该复习的词自己进队列，到期就排上——不用你记哪天该看什么',
      en: 'Terms due for review queue themselves as they mature — you never track what to revisit when',
    },
    caps: [
      {
        icon: 'cards',
        title: { zh: '词条高亮', en: 'Term highlighting' },
        desc: {
          zh: '回复里命中词条库的词自动标出：首现实线、复现虚点线，悬停即看释义与复习状态',
          en: 'Terms from your library auto-marked in replies: solid line on first hit, dotted on repeats; hover for meaning and review state',
        },
      },
      {
        icon: 'graph',
        title: { zh: '知识图谱', en: 'Knowledge graph' },
        desc: {
          zh: '学过的概念自动连成图，点任一节点看它的邻里关系，薄弱环节一眼可见',
          en: 'Learned concepts auto-link into a graph; click any node for its neighborhood and see weak spots at a glance',
        },
      },
    ],
  },
  {
    no: '05',
    step: { zh: '反馈', en: 'Feedback' },
    title: { zh: '反馈激励', en: 'Feedback & streaks' },
    desc: {
      zh: 'XP 连签、AI 主动督促——闭环的最后一步是把你拽回来',
      en: 'XP streaks and AI nudges — the loop closes by pulling you back in',
    },
    caps: [
      {
        icon: 'check',
        title: { zh: 'AI 主动督促', en: 'AI nudges' },
        desc: {
          zh: '欠几条复习、逾期几天、连续学了几天，督促小窗随时报——不用你自己盯着',
          en: 'Reviews due, days overdue, streak so far — the nudge dock keeps the count, you keep the topic',
        },
      },
    ],
  },
];

/** 工程上较真（README「核心优势」精选四条，给懂行的人看的底牌） */
export const ENGINEERING: Array<{ title: Bi; desc: Bi }> = [
  {
    title: { zh: 'AI 输出可靠性工程', en: 'Reliable AI output, engineered' },
    desc: {
      zh: '解析五级阶梯、丢图保题、流式空闲超时、两层并发闸门——每条对策都对应一次真实故障的根因登记',
      en: 'A five-tier parse ladder, drop-the-figure-keep-the-question, stream idle timeouts, two-layer concurrency gates — every countermeasure traces to a logged real incident',
    },
  },
  {
    title: { zh: '前端零第三方库', en: 'Zero third-party frontend libs' },
    desc: {
      zh: '无 UI 库、无 Markdown 库、无图表库：解析、高亮、图表、本页的演示动画全部自绘——供应链攻击面与包体积同时趋零',
      en: 'No UI kit, no Markdown lib, no chart lib: parsing, highlighting, charts and this page’s demo animations are all hand-drawn — supply-chain surface and bundle size both to zero',
    },
  },
  {
    title: { zh: '模型产出敢真跑', en: 'Model output you can run' },
    desc: {
      zh: '模型生成的网页在 CSP sandbox + iframe 双层沙箱里运行，页面源为 null，读不到应用数据',
      en: 'AI-generated web pages run in a CSP-sandbox + iframe double jail: origin is null, app data unreachable',
    },
  },
  {
    title: { zh: '不锁定供应商', en: 'No vendor lock-in' },
    desc: {
      zh: 'OpenAI 兼容 + Anthropic 双适配，搜索三家聚合——换模型、换服务商只动设置页',
      en: 'OpenAI-compatible + Anthropic dual adapters, three search engines aggregated — switching models or providers is a Settings-page affair',
    },
  },
];

/** 隐私与数据（README「安全与隐私设计」）：对上线的用户来说这是决策项不是装饰 */
export const PRIVACY_ITEMS: Bi[] = [
  {
    zh: '数据存你自己的服务器（SQLite 单文件），备份就是拷一个目录',
    en: 'Data lives on your own server (one SQLite file); backup = copy a directory',
  },
  {
    zh: '模型 API Key 加密入库、永不出接口；会话令牌只存哈希，拖库不可用',
    en: 'Model API keys are encrypted at rest and never leave via the API; session tokens stored as hashes — a DB dump is useless',
  },
  {
    zh: '登录态 HttpOnly cookie + 强制鉴权；口令 scrypt 派生、参数自描述',
    en: 'HttpOnly cookie sessions + enforced auth; passwords derived with scrypt, parameters self-describing',
  },
  {
    zh: '跨用户数据互相不可见，写操作校验 Origin，外部结果永不直接写库',
    en: 'User data isolated across accounts, Origin checked on writes, external results never written to the DB directly',
  },
];

/**
 * ★ 「**词条是主体**」的五个去向（2026-09-22 老板点单：主要要把词条讲成主体）。
 *
 * ★ ★ 位置（2026-09-22 二次点单）：本表是介绍段的**第二块**，排在「它是什么」之后。
 *   两段不许合并——合并的上一版把「词条」写进了整页第一句定义句里，
 *   读者在还不知道这是个什么东西的时候，先被塞了一个内部概念。
 *
 * ★ 为什么是「去向」而不是「流程」：`TermJourney` 讲的是**同一个词在时间轴上的五个阶段**
 *   （抽词 → 高亮 → 注入 → 复习 → 沉淀），那一屏一动已经把时间讲完了；
 *   这里讲的是**一个入库的词往哪些功能里去**，是两个不同的维度。
 *   两者都在页面上、都围绕同一个词，若口径再做成同一套，就成了用两种姿势讲同一件事——
 *   读者只会记住「这段刚才看过」。故本表刻意只写「它流向哪」，不写「它第几步」。
 *
 * ★ 四条逐条对得上代码，不是产品想象：
 *   - 驱动出题：`shared/content-blocks.ts` 的 `normalizeQuizMix` + PK 侧 `resolvePkTerms`（PK-SPEC §15.6）
 *   - 决定复习：`TermFlowDemo` 末帧写明 1/2/4/7/15/30/60 天档位，`routes/term-review.ts` 执行
 *   - 连成图谱：`GRAPH_FLOW` 演示「追问抽出的词自动连回源词条」（`emitTermNodes` 只产 term 节点）
 *   - 拿去对战：PK 出题区的 `PkTermPicker`（§15.6），指定词条即锁定出题范围
 *   （★ 原第五条「沉淀总结」指向 `daily_summaries`，随今日总结于 2026-09-25 下线一并摘除——
 *     落地页写着一个点不到的功能，比少写一条更伤。）
 */
export const TERM_SPINE: Array<{ icon: LandingIconKey; title: Bi; desc: Bi }> = [
  {
    icon: 'quiz',
    title: { zh: '驱动出题', en: 'Drives quizzes' },
    desc: {
      zh: '围绕这个词现出题，四题型配比可调；判完的分回到这个词身上',
      en: 'Questions generated around the term, four-type mix tunable; every graded point credits back to the term',
    },
  },
  {
    icon: 'cards',
    title: { zh: '决定复习', en: 'Schedules review' },
    desc: {
      zh: '按 1/2/4/7/15/30/60 天排期，到期自己进队列——不用你记',
      en: 'Spaced on 1/2/4/7/15/30/60-day nodes; due terms enter the queue on their own',
    },
  },
  {
    icon: 'graph',
    title: { zh: '连成图谱', en: 'Weaves the graph' },
    desc: {
      zh: '追问里抽出的新词自动连回它：一个词长出一个星，越问越密',
      en: 'New terms from follow-ups auto-link back: one term grows a star, denser with every question',
    },
  },
  {
    icon: 'vs',
    title: { zh: '拿去对战', en: 'Enters the duel' },
    desc: {
      zh: '指定几个词开一局，AI 出题官就照这份词条库考你',
      en: 'Pick a few terms for a match and the AI question-master quizzes you straight off your library',
    },
  },
];

/**
 * 「它是什么」的**三句话说清**（2026-09-22 二次点单：老板要求「它是什么要在最前面，
 * 讲完之后才是词条」⇒ 这三句**一律不许提词条**，词条由紧随其后的 `TERM_SPINE` 整段专讲）。
 *
 * ★ 为什么必须分家：上一版把「讲产品是什么」和「讲词条是主体」混在同一段、同一句话里
 *   （定义句第一句就是「把概念抽成词条」），结果是**读者在还没搞清这是什么的时候，
 *   先被塞了一个内部概念**。定义句讲类别与形态，词条段讲机制，顺序即理解顺序。
 *
 * ★ 三句是上限不是下限：本段之上就是 hero 演示窗，再多一句都是在跟它抢注意力。
 */
export const INTRO_THREE: Array<{ q: Bi; title: Bi; desc: Bi }> = [
  {
    q: { zh: '它是什么', en: 'What it is' },
    title: { zh: '一条自己往下跑的闭环', en: 'A loop that keeps itself running' },
    desc: {
      zh: '讲解、出题、判分、复习排期、每日总结各自都是一级功能，不是聊天框里的几个技巧。',
      en: 'Explaining, quiz-making, grading, review scheduling and daily summaries are each first-class features — not chatbot parlor tricks.',
    },
  },
  {
    q: { zh: '给谁用', en: 'Who it’s for' },
    title: { zh: '长期啃一块知识的人', en: 'People chewing on a subject for the long haul' },
    desc: {
      zh: '啃长资料、考前复盘、不想把学习记录交给别人——这三类最合适。',
      en: 'Best fit for: grinding long material, pre-exam review, and refusing to hand study records to someone else.',
    },
  },
  {
    q: { zh: '和普通 AI 聊天的区别', en: 'How it differs from plain AI chat' },
    title: { zh: '它记得住你', en: 'It actually remembers you' },
    desc: {
      zh: '通用聊天每轮从零开始；它有跨会话长期记忆，会主动回到你没吃透的地方。',
      en: 'Generic chat restarts from zero every session; this one keeps cross-session memory and circles back to what you haven’t mastered.',
    },
  },
];

/**
 * 信任标签条。★ 数字必须与 `node tools/metrics.mjs` 的实测一致——它是**唯一事实源**；
 *   精确的旧值比模糊表述更危险（它看起来像真的，而首屏是访客第一眼看到的地方）。
 *   2026-09-22 发版前实测：2682 自动化测试 / 150 REST 接口 / 6 运行时依赖
 *   （★ 149→150 就是同一批发版里 demo-login 新增的那条 `POST /api/auth/demo-login`——
 *     这类「代码加了一条端点、首屏标签没跟上」是**没有机器守护**的一类漂移，只能靠 metrics 对账抓）。
 *   ★ 中英两列同数：换语言不换账。
 */
export const INTRO_TAGS: Bi[] = [
  { zh: '自托管部署', en: 'Self-hosted' },
  { zh: '自己的模型 Key', en: 'Your own API key' },
  { zh: 'SQLite 单文件', en: 'Single SQLite file' },
  { zh: '零第三方 UI 库', en: 'Zero UI libraries' },
  { zh: '2600+ 自动化测试', en: '2600+ automated tests' },
  { zh: '150 个 REST 接口', en: '150 REST endpoints' },
];
