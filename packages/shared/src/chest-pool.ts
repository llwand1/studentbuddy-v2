/**
 * shared/chest-pool — 每日宝箱的**初始词池**（2026-09-25 新建，契约 `docs/TERM-CARDS-SPEC.md` §6）。
 *
 * ★ **为什么放 shared**：抽中后前端面板要原样显示同一句释义，服务端落库的也是这一句。
 *   两边各存一份 = 「面板说 A、进库变 B」，与 `ebbinghaus.ts`／`task-list.ts` 进 shared 的理由同一条。
 *   本文件只放数据、**不碰 IO**，抽卡与落库都在 server 侧 `learning/chest.ts`。
 *
 * ★ **为什么它不是公开 SEO 语料的下游**（这是设计，不是巧合）：
 *   `packages/web/src/seo/term-corpus.ts` 那份是**对外页面**，文件头三条红线由 `term-corpus.test.ts`
 *   锁死（不写用户数／不引用真实账号词条／不承诺效果）。宝箱是**产品内玩法**，两者的
 *   修订节奏与风险面完全不同：语料改一句要过公开页审查，词池加一条只是多一个可抽项。
 *   ⇒ 让它们共享一份数据，等于给玩法侧装上发布闸门，或给公开侧拆掉闸门——两条都亏。
 *   而 web→server 的反向 import 在本仓不存在（server 不引 web 的任何东西），这堵墙本身就是证据。
 *   ★ 所以词池的**增长通道只有一条**：`term_pool_candidate` 里人工点过「通过」的 AI 候选（§6.2）。
 *     本文件是**冷启动底座**，不是池子的全部，也不是长期供给方。
 *
 * ★ 释义口径与 `demo-content.ts` 口径② 一致：写的是**一个人自己存的笔记**，不是讲解页文案。
 *   宝箱抽出来直接进用户词条库，读起来像 SEO 段落就会毁掉那一库的真实性。
 * ⚠️ 三条红线在本文件同样生效（不写用户数、不引用任何真实账号、不承诺「用了就提分」）：
 *   这些释义**会原样出现在用户的私人词条库里**，承诺式措辞等于把营销话术塞进用户的笔记。
 */

/** 词池里的一条：字段形状与 `term_pool_candidate` 的列一一对应，AI 候选通过后走同一条落库路 */
export interface ChestPoolEntry {
  term: string;
  definition: string;
  domain: string;
  /** 别名：抽卡去重时与用户库的 `term_library.aliases` 同规则比对（契约 §3 去重②） */
  aliases: readonly string[];
}

/**
 * 冷启动 16 条。挑词的判据不是"重要"，而是**一个用它的人大概率还没自己记过**——
 * 所以全是学习科学里的次级概念（`主动回忆`／`间隔重复`／`艾宾浩斯遗忘曲线` 那三个
 * 高频词刻意不收：`demo-content.ts` 的公账号里已有，抽到就是重复卡）。
 *
 * ★ 数量口径：16 条是"一个人天天开宝箱能撑两周多"的量级，配合 AI 候选的审批节奏。
 *   太少则第三天就没得抽（demo 实测公账号语料 9 条三轮抽干），太多则失去"抽到新东西"的惊喜。
 */
export const CHEST_POOL_SEED: readonly ChestPoolEntry[] = [
  {
    term: '必要难度',
    definition: '让练习稍微难点儿，当场看着差，事后记得反而久。太顺的那一遍基本是白读。',
    domain: '学习方法',
    aliases: ['合意困难'],
  },
  {
    term: '系列位置效应',
    definition: '一串东西里，开头和末尾的记得最牢，中间那段最先掉。所以中段要单独拎出来多过几遍。',
    domain: '记忆机制',
    aliases: ['序列位置效应'],
  },
  {
    term: '加工水平',
    definition: '想得深的那一层才留得住。盯着字复制五遍，不如问一句「它和哪个不一样」。',
    domain: '记忆机制',
    aliases: [],
  },
  {
    term: '组块',
    definition: '把零散信息打包成一个有意义的整体，工作记忆那点容量就不那么不够用了。',
    domain: '记忆机制',
    aliases: ['chunks'],
  },
  {
    term: '精细加工',
    definition: '给新东西接一个自己已有的钩子——举个自己的例子、连上上一章的内容。',
    domain: '记忆机制',
    aliases: ['精加工'],
  },
  {
    term: '双重编码',
    definition: '图和话各留一条路。到时候捞不回来，往往是只存了一条路。',
    domain: '记忆机制',
    aliases: [],
  },
  {
    term: '生成效应',
    definition: '自己产出来的东西比读进去的记得牢，哪怕产出来的过程很狼狈。',
    domain: '记忆机制',
    aliases: [],
  },
  {
    term: '前摄抑制',
    definition: '先前学的会来搅局，让后面新学的记不牢。两门相近的科目别连着背。',
    domain: '干扰与遗忘',
    aliases: ['前摄干扰'],
  },
  {
    term: '倒摄抑制',
    definition: '后学的把先学的挤掉。背完别马上开下一段，留几分钟什么都不干。',
    domain: '干扰与遗忘',
    aliases: ['倒摄干扰'],
  },
  {
    term: '学习错觉',
    definition: '「看懂了」那种流畅感是最不可靠的信号。判断标准是合上书能不能自己写出来。',
    domain: '学习方法',
    aliases: ['熟练度错觉'],
  },
  {
    term: '交错练习',
    definition: '不同题型混在一组里刷，而不是一口气把同一种刷二十道。认「该用哪招」本身就是在练。',
    domain: '复习策略',
    aliases: ['混合练习'],
  },
  {
    term: '间隔效应',
    definition: '同样十次，拆开排在几天里，比挤在一个下午记得久得多。',
    domain: '复习策略',
    aliases: [],
  },
  {
    term: '元认知校准',
    definition: '把自己的「我觉得我会」和「实际考出来多少」对一下。差得远的那一格才是该补的。',
    domain: '学习方法',
    aliases: [],
  },
  {
    term: '注意力残留',
    definition: '从数学切到英语，脑子里还有一半留在数学上。换科目前留五分钟把上一科收尾。',
    domain: '注意力管理',
    aliases: [],
  },
  {
    term: '睡眠巩固',
    definition: '睡下去那段不是在浪费时间，白天记的东西在夜里被重放了一遍。熬夜背的账第二天会还回去。',
    domain: '记忆机制',
    aliases: [],
  },
  {
    term: '起始阻力',
    definition: '最难的是坐下来那一下。把第一步缩到「只打开书」，通常就顺下去了。',
    domain: '动机与习惯',
    aliases: [],
  },
];

/** 池子里全部词条名 + 别名，给去重与测试用（★ 不含释义，比较时不依赖文案内容） */
export function chestPoolNames(): string[] {
  const out: string[] = [];
  for (const e of CHEST_POOL_SEED) {
    out.push(e.term);
    for (const a of e.aliases) out.push(a);
  }
  return out;
}
