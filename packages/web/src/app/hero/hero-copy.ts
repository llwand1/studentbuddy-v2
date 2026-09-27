/**
 * hero-copy — 序章「词条即力量」的双语文案与演出常量。
 *
 * ★ 叙事主线：你是一名把知识词条化为力量的勇者，用知识的力量对抗怪物。
 *   怪物＝被遗忘/到期未复习的知识；谜题＝练习题；手牌＝词条卡。
 * ★ 词条与谜题取自落地页其它段落已经在用的示例领域（光合作用/细胞/能量、间隔重复），
 *   让首屏演出与下方「知识大陆」介绍说的是同一片大陆。
 * ★ 数值（hp / 伤害）只是演出常量，不代表产品数值。
 */
import type { Bi } from '../landing-lang';

export type HeroCard = { name: Bi; tag: Bi; color: string };
export type HeroWave = { kind: number; hp: number; answer: number; name: Bi; title: Bi; riddle: Bi };

export const CARDS: HeroCard[] = [
  { name: { zh: '光合作用', en: 'Photosynthesis' }, tag: { zh: '生物 · 光', en: 'Biology · Light' }, color: '#9be36b' },
  { name: { zh: '间隔重复', en: 'Spaced repetition' }, tag: { zh: '学习法 · 时', en: 'Method · Time' }, color: '#7fb5ff' },
  { name: { zh: '牛顿第二定律', en: "Newton's 2nd law" }, tag: { zh: '物理 · 力', en: 'Physics · Force' }, color: '#ffb347' },
  { name: { zh: '细胞呼吸', en: 'Cellular respiration' }, tag: { zh: '生物 · 能', en: 'Biology · Energy' }, color: '#ff6b8a' },
];

export const WAVES: HeroWave[] = [
  {
    kind: 0, hp: 1, answer: 0,
    name: { zh: '遗忘之影', en: 'Shade of Forgetting' },
    title: { zh: '逾期 3 天的词条', en: 'A term 3 days overdue' },
    riddle: { zh: '植物靠什么把阳光变成养分？', en: 'How do plants turn sunlight into food?' },
  },
  {
    kind: 1, hp: 1, answer: 1,
    name: { zh: '混淆魔', en: 'The Muddler' },
    title: { zh: '好几个答案都像对的', en: 'Every answer looks right' },
    riddle: { zh: '为什么隔几天再复习，反而记得更牢？', en: 'Why does reviewing after a gap make memory stick?' },
  },
  {
    kind: 2, hp: 2, answer: 2,
    name: { zh: '逾期巨像', en: 'The Overdue Colossus' },
    title: { zh: '领主 · 堆积如山的复习', en: 'Lord of the piled-up reviews' },
    riddle: { zh: '哪条定律说：力 = 质量 × 加速度？', en: 'Which law says force = mass × acceleration?' },
  },
];

/** 序章字幕：逐句打字，电影式黑边内播放 */
export const PROLOGUE: Bi[] = [
  { zh: '遗忘的潮水，漫过了知识大陆。', en: 'The tide of forgetting swept over the continent.' },
  { zh: '被忘记的知识，化作了怪物。', en: 'Knowledge left behind turned into monsters.' },
  { zh: '而你——能把词条化为力量。', en: 'But you can turn what you learn into power.' },
];

export const HERO_UI = {
  chapter: { zh: '序章 · 词条即力量', en: 'Prologue · Knowledge is power' },
  skip: { zh: '跳过序章', en: 'Skip prologue' },
  replay: { zh: '再战一次', en: 'Fight again' },
  handAria: { zh: '你的词条卡（按 1–4 打出）', en: 'Your term cards (press 1–4)' },
  handHint: { zh: '读懂谜题，打出对应的词条卡', en: 'Read the riddle, play the matching term' },
  wait: { zh: '……', en: '…' },
  hudLand: { zh: '知识大陆', en: 'Knowledge continent' },
  hudCards: { zh: '卡牌', en: 'Cards' },
  pops: {
    crit: { zh: '理解！暴击', en: 'Understood! Critical' },
    weak: { zh: '只是记住…伤害微弱', en: 'Memorised only… weak hit' },
    hurt: { zh: '遗忘侵蚀', en: 'Forgetting bites' },
    loot: { zh: '收复地块 · 词条卡 +1', en: 'Tile reclaimed · Card +1' },
  },
  victoryTitle: { zh: '领地已收复', en: 'Territory reclaimed' },
  victoryText: {
    zh: '这只是序章。在知识大陆，你和 AI 聊懂的每一个问题都会变成词条——它们就是你的武器。',
    en: 'This was only the prologue. On the continent, every question you work through with AI becomes a term — and terms are your weapons.',
  },
  stageAria: { zh: '可交互序章演示：打出词条卡击败遗忘怪物（玩法示意，不代表真实数值）', en: 'Interactive prologue: play term cards to defeat monsters of forgetting (illustration only)' },
  note: { zh: '玩法示意 · 你的大陆由自己的词条构成', en: 'Illustrated · your continent is made of your own terms' },
} satisfies Record<string, Bi | Record<string, Bi>>;
