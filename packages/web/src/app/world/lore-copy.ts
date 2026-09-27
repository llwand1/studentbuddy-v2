/**
 * lore-copy — 冒险录新增两章的双语文案（2026-09-28）：「余烬笺 · 意外发现」与「副本 · 即将开启」。
 *
 * ★ 事实口径：
 *   - 意外发现：大陆探索时随机出现一簇异色篝火，走近揭开一张由真实玩家留下的词条笺（带留笺人名字）。
 *     演示里的留笺人与内容全部是示例，不连服务器。
 *   - 副本：尚未上线的未来玩法，页面标「即将开启」。AI 深度研读一个词条、把它的来龙去脉生成一整张地图；
 *     示例用「光合作用」的发现史，史实节点取教科书通行说法。
 */
import type { Bi } from '../landing-lang';

export type EmberNote = { term: Bi; body: Bi; who: Bi; when: Bi; hue: string };

export const CH_DISCOVER = {
  title: { zh: '荒野里的异火，', en: 'A strange fire in the wild: ' },
  accent: { zh: '是另一位旅人留下的', en: 'another traveler left it' },
  lead: {
    zh: '大陆上的篝火大多是你亲手点的。可偶尔，在你从未踏足的草丛边，会烧着一簇颜色不对的火——那是别的玩家弄懂一个词条时，留在世界里的余烬。走近它，读一读他们用自己的话写下的理解，再署上他们的名字。',
    en: 'Most campfires on your continent are ones you lit. But now and then, at the edge of grass you have never walked, a fire burns the wrong color — an ember another player left behind when a term finally clicked. Walk up to it and read their understanding, in their own words, signed with their name.',
  },
  move: { zh: '移动', en: 'Move' },
  reroll: { zh: '度过一夜（火会换个地方）', en: 'Pass the night (the fire moves)' },
  far: { zh: '远处有一簇{c}的火在跳动……用方向键或点击地块靠近它', en: 'A {c} fire flickers in the distance… walk closer with the arrows or by clicking tiles' },
  near: { zh: '火焰里浮出一张笺——', en: 'A note rises from the flames —' },
  sign: { zh: '留笺人', en: 'Left by' },
  keep: { zh: '收入卡册', en: 'Keep as a card' },
  kept: { zh: '已收入卡册 · 这张卡会记得它来自谁', en: 'Kept · the card remembers who it came from' },
  thank: { zh: '向火里添一根柴（致谢）', en: 'Add a log to their fire (thanks)' },
  thanked: { zh: '火焰旺了一下——对方会在他的大陆上看到', en: 'The fire flares — they will see it on their continent' },
  aria: { zh: '意外发现演示：在地图上靠近随机出现的异色篝火，揭开其他玩家留下的词条', en: 'Discovery demo: approach a randomly placed ember to reveal a term left by another player' },
  note: { zh: '玩法示意 · 留笺人与内容均为示例', en: 'Illustration · the players and notes shown are examples' },
  colors: { zh: { cyan: '青色', violet: '紫色', gold: '金色', green: '碧色' }, en: { cyan: 'cyan', violet: 'violet', gold: 'golden', green: 'green' } } as Record<string, Record<string, string>>,
};

export const EMBER_NOTES: EmberNote[] = [
  {
    term: { zh: '费曼学习法', en: 'Feynman technique' },
    body: { zh: '我考前把「熵」讲给我奶奶听，讲到第三遍她听懂了——我也是那一刻才真的懂。讲不出来的地方，就是你还没懂的地方。', en: 'Before the exam I explained "entropy" to my grandma. On the third try she got it — and that is when I finally did. Wherever you get stuck explaining is exactly what you have not understood.' },
    who: { zh: '夜读的阿柚', en: 'Yuzu-at-midnight' }, when: { zh: '3 天前', en: '3 days ago' }, hue: 'cyan',
  },
  {
    term: { zh: '机会成本', en: 'Opportunity cost' },
    body: { zh: '不是你花了多少钱，而是你为此放弃的「下一个最好的选择」。我决定今晚刷题而不打游戏，那局排位就是我的机会成本。', en: 'Not what you paid, but the next-best thing you gave up. I studied tonight instead of playing ranked — that match was my opportunity cost.' },
    who: { zh: '北坡的石头', en: 'Stone-of-the-north-slope' }, when: { zh: '昨夜', en: 'last night' }, hue: 'gold',
  },
  {
    term: { zh: '线粒体', en: 'Mitochondria' },
    body: { zh: '细胞里的发电厂，但它曾经是一个独立的细菌，被吞进去之后没被消化，反而留下来打工——十几亿年的合租。', en: 'The cell\'s power plant — but it was once a free-living bacterium, swallowed and never digested, that stayed to work. A billion-year roommate.' },
    who: { zh: '爱吃草莓的 Rin', en: 'Rin-who-loves-strawberries' }, when: { zh: '一周前', en: 'a week ago' }, hue: 'green',
  },
  {
    term: { zh: '递归', en: 'Recursion' },
    body: { zh: '想查「递归」的意思，字典写着：见「递归」。玩笑之外——关键是每次都把问题变小一点，并且知道什么时候停。', en: 'Look up "recursion" and the dictionary says: see "recursion". Jokes aside — shrink the problem a little each time, and know when to stop.' },
    who: { zh: '第七号守夜人', en: 'Night-watch-No.7' }, when: { zh: '2 小时前', en: '2 hours ago' }, hue: 'violet',
  },
];

export const CH_DUNGEON = {
  badge: { zh: '即将开启', en: 'Coming soon' },
  title: { zh: '副本：', en: 'Dungeons: ' },
  accent: { zh: '走进一个词条的历史', en: 'walk into a term\'s history' },
  lead: {
    zh: '有些词条太深，一张卡装不下。未来，你可以把一个词条交给 AI 深读——它会追溯这个概念是怎样一步步被人类发现的，再把整段历史锻造成一张可以走进去的地图：每个时代是一片区域，每个相关词条是一只怪物，每道难题是一道封印的门。',
    en: 'Some terms run too deep for one card. Soon you can hand a term to the AI for a deep read — it traces how humanity discovered the idea step by step, then forges that history into a map you can walk into: every era a region, every related term a monster, every hard question a sealed gate.',
  },
  seed: { zh: '种子词条', en: 'Seed term' },
  seedTerm: { zh: '光合作用', en: 'Photosynthesis' },
  forge: { zh: '让 AI 锻造副本', en: 'Let the AI forge the dungeon' },
  forging: [
    { zh: '研读词条「光合作用」……', en: 'Reading "photosynthesis"…' },
    { zh: '追溯源头：1640 年代，一棵柳树', en: 'Tracing its roots: the 1640s, a willow tree' },
    { zh: '梳理 5 个时代 · 召唤 5 只词条怪物', en: 'Mapping 5 eras · summoning 5 term-monsters' },
    { zh: '封印 5 道问题之门 · 副本成形', en: 'Sealing 5 question gates · dungeon formed' },
  ] as Bi[],
  enter: { zh: '进入区域', en: 'Enter region' },
  monster: { zh: '守关怪物', en: 'Guardian' },
  gate: { zh: '封印之门', en: 'Sealed gate' },
  answer: { zh: '回答以破除封印', en: 'Answer to break the seal' },
  right: { zh: '封印破除！下一个时代的道路亮了起来', en: 'Seal broken! The road to the next era lights up' },
  wrong: { zh: '门纹丝不动——再想想这个时代的人看到了什么', en: 'The gate holds — think about what people of this era actually saw' },
  cleared: { zh: '副本通关 · 你亲手走完了光合作用被发现的三百年', en: 'Dungeon cleared · you walked the three centuries it took to discover photosynthesis' },
  again: { zh: '再走一遍', en: 'Walk it again' },
  aria: { zh: '副本模式预告演示：AI 把「光合作用」的发现史生成一张可闯关的地图', en: 'Dungeon preview: the AI turns the history of photosynthesis into a playable map' },
  note: { zh: '未来玩法预告 · 尚未上线，地图与题目为示意', en: 'Future feature preview · not yet live; map and questions are illustrative' },
};

export type Era = {
  year: string; place: Bi; scene: Bi; monster: Bi; tile: string;
  q: Bi; opts: Bi[]; ok: number;
};

/** 光合作用发现史：五个时代，每个时代一只词条怪物 + 一道封印之门 */
export const ERAS: Era[] = [
  {
    year: '1640s', tile: 'soil', place: { zh: '海尔蒙特的花盆', en: 'Van Helmont\'s pot' },
    scene: { zh: '一棵柳苗种进称过重的土里，只浇雨水。五年后柳树重了七十多千克，土却几乎一点没少。', en: 'A willow sapling planted in weighed soil, given only rainwater. Five years later the tree had gained over 70 kg — the soil had barely lost any.' },
    monster: { zh: '土壤之疑', en: 'The Soil Doubt' },
    q: { zh: '海尔蒙特据此认为，柳树增加的重量主要来自？', en: 'From this, van Helmont concluded the willow\'s extra mass came mainly from?' },
    opts: [{ zh: '土壤', en: 'The soil' }, { zh: '水', en: 'Water' }, { zh: '阳光', en: 'Sunlight' }], ok: 1,
  },
  {
    year: '1771', tile: 'glass', place: { zh: '普里斯特利的钟罩', en: 'Priestley\'s bell jar' },
    scene: { zh: '密封钟罩里，蜡烛熄灭、小鼠窒息。放进一枝薄荷，几天后蜡烛又能点燃，小鼠也活了下来。', en: 'In a sealed bell jar the candle dies and the mouse suffocates. Add a sprig of mint, and days later the candle burns again and the mouse lives.' },
    monster: { zh: '浊气幽灵', en: 'Wraith of Foul Air' },
    q: { zh: '薄荷为钟罩里「修复」了什么？', en: 'What did the mint "restore" inside the jar?' },
    opts: [{ zh: '可供燃烧和呼吸的气体', en: 'A gas that supports burning and breathing' }, { zh: '热量', en: 'Heat' }, { zh: '水分', en: 'Moisture' }], ok: 0,
  },
  {
    year: '1779', tile: 'sun', place: { zh: '英格豪斯的日与夜', en: 'Ingenhousz\'s day and night' },
    scene: { zh: '五百多次实验后，他发现：只有在光下、只有植物的绿色部分，才能让空气变好；在黑暗里，植物反而和动物一样「弄脏」空气。', en: 'After 500-odd experiments he found only green parts, and only in light, freshen the air; in darkness plants foul it just like animals.' },
    monster: { zh: '暗夜蚀影', en: 'The Night Eclipse' },
    q: { zh: '植物「净化空气」必需的条件是？', en: 'What does a plant need to "purify the air"?' },
    opts: [{ zh: '温暖', en: 'Warmth' }, { zh: '光照', en: 'Light' }, { zh: '肥沃的土', en: 'Rich soil' }], ok: 1,
  },
  {
    year: '1862', tile: 'leaf', place: { zh: '萨克斯的碘液叶片', en: 'Sachs\' iodine leaf' },
    scene: { zh: '一片叶子一半遮光、一半见光。滴上碘液后，见光的那一半变成蓝黑色——光下的叶子造出了淀粉。', en: 'Half a leaf covered, half in light. After iodine, the lit half turns blue-black — the leaf made starch in the light.' },
    monster: { zh: '淀粉魔像', en: 'The Starch Golem' },
    q: { zh: '碘液让叶片变蓝，证明光合作用产生了？', en: 'Iodine turning the leaf blue shows photosynthesis produces?' },
    opts: [{ zh: '蛋白质', en: 'Protein' }, { zh: '氧气', en: 'Oxygen' }, { zh: '淀粉', en: 'Starch' }], ok: 2,
  },
  {
    year: '1950s', tile: 'lab', place: { zh: '卡尔文的放射性迷宫', en: 'Calvin\'s radioactive maze' },
    scene: { zh: '用带放射性的碳-14 标记二氧化碳，几秒一次地「定格」小球藻，终于追出碳在叶绿体里走过的完整环路。', en: 'Tagging CO₂ with radioactive carbon-14 and freezing algae seconds apart, they finally traced the full loop carbon travels in the chloroplast.' },
    monster: { zh: '卡尔文循环 · 轮回之蛇', en: 'Calvin Cycle · the Ouroboros' },
    q: { zh: '卡尔文循环里被固定、最终变成糖的是哪种原料？', en: 'In the Calvin cycle, which raw material gets fixed and ends up as sugar?' },
    opts: [{ zh: '二氧化碳', en: 'Carbon dioxide' }, { zh: '氧气', en: 'Oxygen' }, { zh: '氮气', en: 'Nitrogen' }], ok: 0,
  },
];
