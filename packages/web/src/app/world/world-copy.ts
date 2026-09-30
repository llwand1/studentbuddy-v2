/**
 * world-copy — 落地页「冒险录」各章的双语文案（2026-09-28 大改：只讲游戏化玩法）。
 *
 * ★ 事实口径（门面不许替产品吹牛）：
 *   - 知识大陆：词条按创建顺序从中心铺格，世界半径由词条数派生、只增不减；到期/逾期词条生成怪物，
 *     逾期越久占领越多格（1～6）；靠近才开打，答对即收复（KNOWLEDGE-CONTINENT-SPEC）。
 *   - 伙伴：玩家在地图上点格创建，AI 起名与人设；就守的词条提问/给线索、遇怪派求救单、
 *     拿自己的卡换同领域没见过的词条；名额随世界半径 6～24（NPC-PARTNER-SPEC）。
 *   - 卡牌：卡数从流水派生（提及 + 复习日 + 宝箱 + 建卡），稀有度 N/R/SR/SSR 按卡数分档（TERM-CARDS-SPEC）。
 *   - Boss 战：由「对战（PK）」实现——与 AI 出题师或好友互出题、限时作答、积分定胜负；AI 也会主动约战（PK-SPEC）。
 * ★ 演示里的一切数字都是示意。
 */
import type { Bi } from '../landing-lang';

export type Domain = 'bio' | 'phy' | 'learn' | 'chem';
export type DemoTerm = { name: Bi; domain: Domain };

/** 大陆演示用的示例词条（按领域铺不同地砖） */
export const DEMO_TERMS: DemoTerm[] = [
  { name: { zh: '光合作用', en: 'Photosynthesis' }, domain: 'bio' },
  { name: { zh: '牛顿第二定律', en: "Newton's 2nd law" }, domain: 'phy' },
  { name: { zh: '间隔重复', en: 'Spaced repetition' }, domain: 'learn' },
  { name: { zh: '细胞呼吸', en: 'Cellular respiration' }, domain: 'bio' },
  { name: { zh: '化学键', en: 'Chemical bond' }, domain: 'chem' },
  { name: { zh: '动量守恒', en: 'Conservation of momentum' }, domain: 'phy' },
  { name: { zh: '费曼学习法', en: 'Feynman technique' }, domain: 'learn' },
  { name: { zh: '氧化还原', en: 'Redox' }, domain: 'chem' },
  { name: { zh: '线粒体', en: 'Mitochondria' }, domain: 'bio' },
  { name: { zh: '向心力', en: 'Centripetal force' }, domain: 'phy' },
  { name: { zh: '提取练习', en: 'Retrieval practice' }, domain: 'learn' },
  { name: { zh: '催化剂', en: 'Catalyst' }, domain: 'chem' },
  { name: { zh: '基因表达', en: 'Gene expression' }, domain: 'bio' },
  { name: { zh: '电磁感应', en: 'Electromagnetic induction' }, domain: 'phy' },
  { name: { zh: '遗忘曲线', en: 'Forgetting curve' }, domain: 'learn' },
  { name: { zh: '酸碱中和', en: 'Neutralisation' }, domain: 'chem' },
  { name: { zh: '酶', en: 'Enzyme' }, domain: 'bio' },
  { name: { zh: '能量守恒', en: 'Conservation of energy' }, domain: 'phy' },
  { name: { zh: '组块化', en: 'Chunking' }, domain: 'learn' },
  { name: { zh: '摩尔', en: 'Mole' }, domain: 'chem' },
];

export const DOMAIN_NAME: Record<Domain, Bi> = {
  bio: { zh: '生物 · 草原', en: 'Biology · meadow' },
  phy: { zh: '物理 · 岩地', en: 'Physics · rock' },
  learn: { zh: '学习法 · 沙原', en: 'Method · dunes' },
  chem: { zh: '化学 · 沼泽', en: 'Chemistry · marsh' },
};

export const CH_CONTINENT = {
  title: { zh: '知识大陆，', en: 'The continent grows ' },
  accent: { zh: '是你一块块学出来的', en: 'one term at a time' },
  lead: {
    zh: '平时，大陆是一张俯视的平面地图：你学会的每个词条都会落成一块地砖，按领域长成草原、岩地、沙原与沼泽。学得越多，世界越大。只有当你出发讨伐怪物时，镜头才会切进横版战场。',
    en: 'Day to day the continent is a top-down map: every term you learn drops in as a floor tile — meadow, rock, dunes or marsh by subject. The more you learn, the bigger the world. Only when you set out to hunt a monster does the camera cut to a side-scrolling battlefield.',
  },
  rules: [
    { k: { zh: '词条 = 地砖', en: 'Term = tile' }, v: { zh: '和 AI 聊懂一个概念，它就从天而降，铺在大陆边缘。', en: 'Understand a concept with AI and it lands on the edge of your map.' } },
    { k: { zh: '世界只增不减', en: 'The world only grows' }, v: { zh: '世界半径由词条数决定，屏幕只是视野，可拖拽探索；地块要维护——越靠边碎得越快，复习一次就原地重建。', en: 'Your world radius comes from your term count; the screen is just a viewport. Tiles need upkeep: the farther from the centre, the faster they crumble — one review rebuilds them in place.' } },
    { k: { zh: '遗忘 = 怪物', en: 'Forgetting = monsters' }, v: { zh: '到期没复习的词条化作怪物，逾期越久，吞掉的地块越多；对话里刚聊到的词条，当天也会冒出话题怪。', en: 'Due terms turn into monsters; the longer overdue, the more tiles they swallow. Terms you just discussed in chat spawn topic monsters the same day.' } },
    { k: { zh: '讨伐 = 转场', en: 'Hunt = cut scene' }, v: { zh: '走到怪物身边发起讨伐（或在导航里点「前往」，勇者自己走过去），平面地图转场成横版战斗，用词条答题击败它。', en: 'Walk up and hunt — or pick a target in the navigator and the hero walks there — and the map cuts to a side-view battle where terms are your spells.' } },
    { k: { zh: '收复 = 奖励', en: 'Reclaim = reward' }, v: { zh: '胜利解除占领、推进复习，地块重新亮起，卡牌也随之增加。', en: 'Victory frees the land, advances the review and adds to your cards.' } },
  ],
  learn: { zh: '学会一个新词条', en: 'Learn a new term' },
  decay: { zh: '让时间流逝', en: 'Let time pass' },
  hunt: { zh: '出发讨伐', en: 'Set out to hunt' },
  statTerms: { zh: '词条', en: 'Terms' },
  statRadius: { zh: '世界半径', en: 'Radius' },
  statFoe: { zh: '被占地块', en: 'Occupied' },
  viewMap: { zh: '俯视 · 大陆平面', en: 'Top-down · continent' },
  viewBattle: { zh: '横版 · 讨伐战', en: 'Side view · the hunt' },
  encounter: { zh: '遭遇战', en: 'Encounter' },
  foeName: { zh: '遗忘之影', en: 'Shade of Forgetting' },
  reclaimed: { zh: '领地已收复 · 卡牌 +1', en: 'Land reclaimed · Card +1' },
  hint: { zh: '提示：也可以直接点击地图上的怪物', en: 'Tip: you can also click the monster on the map' },
  aria: { zh: '知识大陆玩法演示：学习词条扩张地图，讨伐怪物时转场到横版战斗', en: 'Continent demo: learning grows the map; hunting cuts to a side-view battle' },
  note: { zh: '玩法示意 · 地砖与怪物来自示例词条，你的大陆由你自己的词条构成', en: 'Illustration · tiles come from sample terms; your continent is built from your own' },
};

export const CH_TERM = {
  title: { zh: '词条，', en: 'Terms: ' },
  accent: { zh: '一切力量的源头', en: 'where all power comes from' },
  lead: {
    zh: '对话里，AI 讲到的关键概念会被自动抽成词条、在回复里高亮；复现越多次，它越强。地砖、怪物、卡牌与对战题目，全都从这里长出来。',
    en: 'In conversation, key ideas are pulled out as terms and highlighted in replies; the more they recur, the stronger they get. Tiles, monsters, cards and battle questions all grow from here.',
  },
};

export const CH_NPC = {
  title: { zh: '招募你的', en: 'Recruit your ' },
  accent: { zh: 'AI 学习伙伴', en: 'AI companions' },
  lead: {
    zh: '在大陆上点一块地，安置一位伙伴。他由 AI 起名、定人设，守着一条词条：会就这条词条考你、给线索；遇到怪物会发来求救单；还能拿你的一张卡，换一条同领域你没见过的新词条。',
    en: 'Pick a tile and settle a companion there. AI gives them a name and a persona, and they guard one term: they quiz you on it and drop hints, send a rescue request when monsters come, and trade one of your cards for a new term from the same field.',
  },
  jobLabel: { zh: '职业', en: 'Class' },
  moodLabel: { zh: '性格', en: 'Persona' },
  termLabel: { zh: '守护词条', en: 'Guarded term' },
  jobs: [
    { id: 'mage', name: { zh: '法师', en: 'Mage' } },
    { id: 'knight', name: { zh: '骑士', en: 'Knight' } },
    { id: 'ranger', name: { zh: '游侠', en: 'Ranger' } },
    { id: 'bard', name: { zh: '吟游诗人', en: 'Bard' } },
  ],
  moods: [
    { id: 'stern', name: { zh: '严厉导师', en: 'Stern mentor' } },
    { id: 'warm', name: { zh: '热心学长', en: 'Warm senior' } },
    { id: 'snark', name: { zh: '毒舌搭档', en: 'Snarky partner' } },
  ],
  names: { mage: { zh: '洛雅', en: 'Loya' }, knight: { zh: '伽隆', en: 'Garron' }, ranger: { zh: '希尔', en: 'Syl' }, bard: { zh: '缪缪', en: 'Mimi' } } as Record<string, Bi>,
  actions: [
    { id: 'talk', name: { zh: '对话', en: 'Talk' } },
    { id: 'rescue', name: { zh: '求救单', en: 'Rescue' } },
    { id: 'trade', name: { zh: '交换卡牌', en: 'Trade' } },
  ],
  cap: { zh: '伙伴名额随世界变大而增加（6～24 位），招募新伙伴需要完成学习任务。', en: 'Companion slots grow with your world (6–24); recruiting more takes completed study tasks.' },
  aria: { zh: '伙伴招募演示', en: 'Companion recruitment demo' },
};

/** 伙伴台词模板：{t} 替换为守护词条 */
export const NPC_LINES: Record<string, Record<string, Bi>> = {
  talk: {
    stern: { zh: '「{t}」你说说看，它到底解决了什么问题？别背定义。', en: 'Explain "{t}" — what problem does it solve? No reciting definitions.' },
    warm: { zh: '我守着「{t}」这块地好久啦，要不要我先给你一条小线索？', en: "I've guarded \"{t}\" for ages — want a little hint first?" },
    snark: { zh: '又来了？上次「{t}」你可是答错两次的人。', en: 'Back again? You missed "{t}" twice last time.' },
  },
  rescue: {
    stern: { zh: '【求救】「{t}」附近出现了遗忘之影。限你今天之内处理。', en: '[Rescue] A shade appeared near "{t}". Deal with it today.' },
    warm: { zh: '【求救】救命！「{t}」那边来了怪物，我一个人守不住了……', en: '[Rescue] Help! A monster is at "{t}" and I can\'t hold it alone…' },
    snark: { zh: '【求救】怪物把「{t}」啃掉一角了，你再不来我就搬家。', en: '[Rescue] A monster is chewing on "{t}". Come now or I move out.' },
  },
  trade: {
    stern: { zh: '拿一张卡来。作为交换，我教你一个同领域的新词条。', en: 'Give me a card. In return, a new term from the same field.' },
    warm: { zh: '用一张卡换一个你还没见过的词条吧，我保证你会喜欢！', en: "Swap a card for a term you haven't met yet — you'll love it!" },
    snark: { zh: '卡给我，新词条给你。公平交易，别讨价还价。', en: 'Card for a new term. Fair deal. No haggling.' },
  },
};

export const CH_CARDS = {
  title: { zh: '每一次相遇，', en: 'Every encounter ' },
  accent: { zh: '都会凝成卡牌', en: 'becomes a card' },
  lead: {
    zh: '一个词条被你提起、复习、从宝箱里收下的每一次，都会变成一张卡。卡越多，星级越高，稀有度从 N、R、SR 一路升到 SSR。每日宝箱与 AI 派来的任务，会主动把你拉回来。',
    en: 'Every time a term is mentioned, reviewed or taken from a chest, it becomes a card. More cards, more stars — rarity climbs from N to R, SR and SSR. Daily chests and AI-assigned quests pull you back.',
  },
  open: { zh: '打开今日宝箱', en: 'Open today\'s chest' },
  again: { zh: '再开一次（示意）', en: 'Open again (demo)' },
  cards: [
    { r: 'N', name: { zh: '摩尔', en: 'Mole' }, n: 2 },
    { r: 'R', name: { zh: '向心力', en: 'Centripetal force' }, n: 5 },
    { r: 'SR', name: { zh: '间隔重复', en: 'Spaced repetition' }, n: 11 },
    { r: 'SSR', name: { zh: '光合作用', en: 'Photosynthesis' }, n: 24 },
  ],
  countLabel: { zh: '张', en: 'cards' },
};

export const CH_BOSS = {
  title: { zh: 'Boss 战，', en: 'Boss fights ' },
  accent: { zh: '就是对战', en: 'are duels' },
  lead: {
    zh: '首屏那场横版战斗不只是演出：Boss 战由「对战」功能实现。对手可以是 AI 出题师，也可以是通过邀请链接进来的好友——双方从各自的词条出题、限时作答，答对就是一次命中，积分即血量，先打空对方的一方获胜。AI 还会在你学得差不多时，主动来约战。',
    en: "The side-scrolling fight up top isn't just a show: boss fights run on the Duel feature. Your foe is either the AI question-master or a friend who joins by invite link — each side sets questions from their own terms, answers against the clock, and every correct answer is a hit. Score is HP. AI may even challenge you when you're ready.",
  },
  foes: [
    { id: 'ai', name: { zh: 'AI 出题师', en: 'AI question-master' }, boss: { zh: '逾期巨像', en: 'Overdue Colossus' } },
    { id: 'friend', name: { zh: '好友（邀请链接）', en: 'A friend (invite link)' }, boss: { zh: '宿敌 · 阿澈', en: 'Rival · Che' } },
  ],
  steps: [
    { zh: '你从自己的词条里出题', en: 'You set a question from your terms' },
    { zh: '对手限时作答', en: 'Your foe answers on the clock' },
    { zh: '判分：答对即命中', en: 'Judged: correct means a hit' },
    { zh: '攻守交换，轮到你答', en: 'Roles swap — your turn to answer' },
  ],
  you: { zh: '你', en: 'You' },
  aria: { zh: 'Boss 战（对战）流程演示', en: 'Boss fight (duel) demo' },
};

export const FINALE = {
  title: { zh: '你的冒险，', en: 'Your adventure ' },
  accent: { zh: '从一个问题开始', en: 'starts with a question' },
  lead: {
    zh: '带上一个你真正好奇的问题。和 AI 聊懂它，第一块地砖就会落下。',
    en: 'Bring a question you truly wonder about. Work it out with AI and your first tile drops.',
  },
  cta: { zh: '踏上大陆', en: 'Enter the continent' },
  facts: [
    { zh: '完全开源 · 可本地运行', en: 'Fully open source · runs locally' },
    { zh: '自带模型 Key，不锁定供应商', en: 'Bring your own model key' },
    { zh: '数据留在你自己的服务器', en: 'Your data stays on your server' },
  ],
  source: { zh: '源码与本地安装包版', en: 'Source & local install' },
};
