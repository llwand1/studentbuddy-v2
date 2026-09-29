// 生成 complete-v1.json：33 个评测用例 + 「标杆」参考题（由人工——本轮为 Arena Agent——联网检索后手写）。
// 跑法：node tools/eval/datasets/complete-v1/build.mjs
// 只增不改：改已有用例＝升 v2（否则旧报告失去可比性）。
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);

const S = (title, url) => ({ title, url });
const attr = JSON.parse(fs.readFileSync(path.join(here, 'figures/ATTRIBUTION.json'), 'utf8'));
const fig = (id, alt) => ({ id, file: attr[id].file, alt, pageUrl: attr[id].pageUrl, license: attr[id].license, artist: attr[id].artist });

// —— 手绘 SVG（标杆里的「图」：几何题与曲线题没有合适的开源原图，就照题意画）——
const svgTriangle = `<svg viewBox='0 0 200 150' xmlns='http://www.w3.org/2000/svg'><polygon points='30,120 30,30 150,120' fill='none' stroke='#333' stroke-width='2'/><rect x='30' y='108' width='12' height='12' fill='none' stroke='#333'/><text x='14' y='128'>C</text><text x='14' y='30'>A</text><text x='154' y='128'>B</text><text x='10' y='78'>3</text><text x='84' y='138'>4</text></svg>`;
const kno3 = [[0, 13.3], [20, 31.6], [40, 63.9], [60, 110], [80, 169]];
const px = (t) => 40 + t * 2.2, py = (s) => 130 - s * 0.7;
const svgSolub = `<svg viewBox='0 0 240 150' xmlns='http://www.w3.org/2000/svg'><line x1='40' y1='130' x2='230' y2='130' stroke='#333'/><line x1='40' y1='130' x2='40' y2='10' stroke='#333'/><polyline fill='none' stroke='#c33' stroke-width='2' points='${kno3.map(([t, s]) => `${px(t)},${py(s)}`).join(' ')}'/>${kno3.map(([t, s]) => `<circle cx='${px(t)}' cy='${py(s)}' r='2.5' fill='#c33'/><text x='${px(t) - 8}' y='143' font-size='9'>${t}</text>`).join('')}<text x='6' y='14' font-size='9'>溶解度/g</text><text x='196' y='143' font-size='9'>温度/℃</text><text x='${px(60) + 4}' y='${py(110) - 4}' font-size='9'>60℃: 110</text><text x='150' y='30' font-size='10'>KNO₃</text></svg>`;

const cases = [
  // ───────── 阅读材料类（need=passage）─────────
  { id: 'P01-zh-beiying', category: '语文·现代文阅读', need: 'passage', topic: '初中语文 朱自清《背影》选段 阅读理解',
    reference: { type: 'single',
      material: '我看见他戴着黑布小帽，穿着黑布大马褂，深青布棉袍，蹒跚地走到铁道边，慢慢探身下去，尚不大难。可是他穿过铁道，要爬上那边月台，就不容易了。他用两手攀着上面，两脚再向上缩；他肥胖的身子向左微倾，显出努力的样子，这时我看见他的背影，我的泪很快地流下来了。……到这边时，我赶紧去搀他。他和我走到车上，将橘子一股脑儿放在我的皮大衣上。于是扑扑衣上的泥土，心里很轻松似的。',
      question: '（选自朱自清《背影》）文中“于是扑扑衣上的泥土，心里很轻松似的”，最恰当的理解是：',
      options: ['因为父亲尽到了关怀照顾儿子的心意，所以感到轻松', '因为衣服上的泥土拍干净了，所以感到轻松', '因为儿子长大了，能自谋生路，所以感到轻松', '因为橘子放在了大衣上，可以早点回家'], answer: [0],
      explanation: '“轻松”指心情：越是为儿子尽了做父亲的责任，心里越踏实，表现出父亲含蓄深沉的爱子之心。', sources: [S('朱自清《背影》阅读理解题及答案(二)', 'https://www.xsc.cn/yuedu/202203/40660.html'), S('朱自清《背影》阅读练习及答案', 'https://www.ruiwen.com/wenxue/beiying/696905.html')] } },
  { id: 'P02-zh-yueyanglou', category: '语文·文言文阅读', need: 'passage', topic: '初中语文 《岳阳楼记》 文言文阅读 练习',
    reference: { type: 'single',
      material: '嗟夫！予尝求古仁人之心，或异二者之为，何哉？不以物喜，不以己悲；居庙堂之高则忧其民；处江湖之远则忧其君。是进亦忧，退亦忧。然则何时而乐耶？其必曰“先天下之忧而忧，后天下之乐而乐”乎。噫！微斯人，吾谁与归？',
      question: '（选自范仲淹《岳阳楼记》）“不以物喜，不以己悲”中的“以”，意思是：', options: ['因为', '用', '把', '来'], answer: [0],
      explanation: '“不以物喜，不以己悲”意为不因外物（好坏）和自己（得失）而或喜或悲，“以”是“因为”。', sources: [S('《岳阳楼记》中考文言文精细阅读', 'https://m.diyifanwen.com/jiaoan/jiunianjiyuwenjiaoan/720582.html')] } },
  { id: 'P03-zh-suzhou', category: '语文·说明文阅读', need: 'passage', topic: '初中语文 叶圣陶《苏州园林》 选段阅读题',
    reference: { type: 'single',
      material: '游览苏州园林必然会注意到花墙和廊子。有墙壁隔着，有廊子界着，层次多了，景致就见得深了。可是墙壁上有砖砌的各式镂空图案，廊子大多是两边无所依傍的，实际是隔而不隔，界而未界，因而更增加了景致的深度。',
      question: '（选自叶圣陶《苏州园林》）苏州园林的花墙和普通的墙壁有什么不同？', options: ['墙壁上有砖砌的各式镂空图案', '墙壁比普通的墙壁更高', '墙壁全部用太湖石堆叠', '墙壁上绘有彩色壁画'], answer: [0],
      explanation: '原文：“墙壁上有砖砌的各式镂空图案”，所以隔而不隔。', sources: [S('《苏州园林》选段_阅读理解,答案', 'https://www.yuzhenhai.com/view/201308/11399.html')] } },
  { id: 'P04-zh-chunwang', category: '语文·古诗鉴赏', need: 'passage', topic: '初中语文 杜甫《春望》 诗歌鉴赏 练习题',
    reference: { type: 'single',
      material: '国破山河在，城春草木深。感时花溅泪，恨别鸟惊心。烽火连三月，家书抵万金。白头搔更短，浑欲不胜簪。',
      question: '（杜甫《春望》）“感时花溅泪，恨别鸟惊心”表达了诗人怎样的感情？', options: ['忧国伤时、思念亲人的悲痛', '对春天景色的喜爱', '对隐居生活的向往', '对战争胜利的喜悦'], answer: [0],
      explanation: '花鸟本是可爱之物，诗人见了反而落泪惊心，是因感伤时局、痛恨离别，情由景生。', sources: [] } },
  { id: 'P05-en-blackbeauty', category: '英语·阅读理解', need: 'passage', topic: '初中英语 阅读理解 名著介绍 Black Beauty',
    reference: { type: 'single',
      material: 'My favourite book is called Black Beauty, written by British writer Anna Sewell. The book came out in 1877. The hero is a horse. His name is Beauty. In the book, we can see the world through a horse’s eyes. His first owner raises him with love. But when he grows up, he is sold. His new owner does very bad things to him, and his life gets hard.',
      question: 'Who wrote the book Black Beauty?', options: ['Anna Sewell', 'Mark Twain', 'Charles Dickens', 'Beauty'], answer: [0],
      explanation: 'The passage says the book was written by British writer Anna Sewell.', sources: [S('2023 年广西初中学业水平考试 英语样卷', 'http://jyt.gxzf.gov.cn/zntj/W020230131636743735303.pdf')] } },
  { id: 'P06-en-marktwain', category: '英语·阅读理解', need: 'passage', topic: '初中英语 阅读理解 Mark Twain 幽默小故事',
    reference: { type: 'single',
      material: 'Mark Twain, a famous writer in America, liked to play jokes on his friends. One day, his friend lost his wallet and asked Mark Twain to pay for his ticket. “But I don’t have enough money,” Mark Twain said. After a while he said, “I’ve got a good idea. You can hide under my seat.” When the conductor came to check the tickets, Mark Twain gave him two tickets—one for his friend, one for himself. Then he explained in a loud voice, “My friend is a nice person, but a little strange. When he travels by train, he hates sitting on the seat, so he always lies on the floor under the seat.” Of course all the people on the train looked at his poor friend under the seat and laughed at him loudly.',
      question: 'Why did all the people on the train laugh at Mark Twain’s friend?', options: ['Because he was lying under the seat as Mark Twain said he liked doing.', 'Because he had lost his wallet.', 'Because he could not find his ticket.', 'Because he fell off the seat.'], answer: [0],
      explanation: 'Mark Twain told everyone his friend always lies under the seat, and they saw him there.', sources: [S('2004年中考英语模拟试题(六)', 'https://edu.sina.com.cn/en/2004-08-30/25502.html')] } },
  { id: 'P07-his-liang', category: '历史·材料题', need: 'passage', topic: '高中历史 辛亥革命 评价 材料选择题',
    reference: { type: 'single',
      question: '梁启超评价辛亥革命具有“空前巨大的意义”。“第一、觉得凡不是中国人都没有权来管中国人的事；第二、觉得凡是中国人都有权来管中国人的事”。由此可见，梁启超认为辛亥革命的作用是',
      options: ['增强了国民的民族民主意识', '打击了帝国主义侵略势力', '使民主共和的观念深入人心', '开启了思想解放的闸门'], answer: [0], explanation: '材料强调“管中国人的事”的权利归属，指向民族民主意识的增强。', sources: [S('辛亥革命练习题及答案', 'https://www.yongkao.com/gaokao/lishi/95847.html')] } },
  { id: 'P08-his-yangwu', category: '历史·材料题', need: 'passage', topic: '初中历史 洋务运动 材料分析 李鸿章 主张',
    reference: { type: 'single',
      material: '中国文武制度，事事远出西人之上，独火器万不能及。……中国欲自强，则莫如学习外国利器，欲学习外国利器，则莫如觅制器之器，师其法而不必尽用其人。——《江苏巡抚李鸿章致总理衙门原函》',
      question: '上述材料反映了洋务派的主张是', options: ['学习西方先进的军事技术以“自强”', '实行君主立宪制', '建立民主共和国', '全面否定中国传统制度'], answer: [0], explanation: '材料强调“学习外国利器”“觅制器之器”，即学习西方军事技术。', sources: [S('第4课 洋务运动 教学设计', 'https://research.bakclass.com/listen/courseDetail?lesson_id=716168')] } },
  { id: 'P09-his-xinwenhua', category: '历史·材料题', need: 'passage', topic: '初中历史 新文化运动 陈独秀 《敬告青年》 材料题',
    reference: { type: 'single',
      material: '周礼崇尚虚文，汉则罢黜百家而尊儒重道，名教之所昭垂，人心之所祈向，无一不与社会现实生活背道而驰。——陈独秀《敬告青年》（1915年）',
      question: '材料表明陈独秀在《新青年》上的立场是', options: ['批判尊孔复古思想', '主张君主立宪', '宣传马克思主义', '提倡科学救国、发展实业'], answer: [0], explanation: '陈独秀在创刊号即批判儒家礼教与尊孔，表明反孔教立场。', sources: [S('新文化运动 - 维基百科', 'https://zh.wikipedia.org/zh-hans/%E6%96%B0%E6%96%87%E5%8C%96%E8%BF%90%E5%8A%A8')] } },
  { id: 'P10-pol-dianshang', category: '政治·材料分析', need: 'passage', topic: '高中政治 乡村振兴 农村电商 材料分析题',
    reference: { type: 'essay',
      material: '2022年中央一号文件对农村电商领域再次提出新要求，指出实施“数商兴农”工程，推进电子商务进乡村。',
      question: '结合材料，简述推进电子商务进乡村对乡村振兴的意义。', answer: '畅通农产品销售渠道；促进农民增收；推动电子商务与农村产业融合发展；培育新型职业农民、促进创新创业。',
      solution: '①畅通农产品销售渠道，解决卖难；②促进农民增收，缩小城乡差距；③推动产业融合，发展现代农业；④培育人才，助力乡村振兴。', sources: [S('2023年高考政治二轮复习 热点3 巩固脱贫成果，推进乡村振兴', 'https://wenku.sucaisucai.com/p/228470.html')] } },
  { id: 'P11-pol-fupin', category: '政治·材料选择', need: 'passage', topic: '初中道德与法治 脱贫攻坚 全面胜利 材料选择题',
    reference: { type: 'single',
      question: '2021年，我国现行标准下9899万农村贫困人口全部脱贫，832个贫困县全部摘帽，12.8万个贫困村全部出列，脱贫攻坚战取得全面胜利。这体现了',
      options: ['我国社会主要矛盾得以解决', '党和政府坚持以人民为中心的发展思想', '我国社会主义初级阶段的基本国情已经改变', '我国经济已由高质量发展阶段转向高速增长阶段'], answer: [1], explanation: '脱贫攻坚是以人民为中心发展思想的体现；其余三项表述错误。', sources: [S('初中《道德与法治》九年级上册第一单元作业', 'https://25109250.s21i.faiusr.com/61/ABUIABA9GAAgrrmjiwYonMv4cg.pdf')] } },
  { id: 'P12-his-shanghai', category: '历史·材料题', need: 'passage', topic: '高中历史 辛亥革命 上海 城市 材料分析题',
    reference: { type: 'single',
      material: '众所周知，1900年至1911年期间，上海连续演绎了许多有声有色的政治剧，比如爱国学社、张园国会、苏报案、民立报，还有同盟会中部总会等等，这些剧目均具有全国影响和重大意义。——廖大伟《辛亥革命与上海政治地位的提升》',
      question: '根据材料，有人选择上海作为最能代表辛亥革命的城市，主要理由是', options: ['上海在此期间发生了多起具有全国影响的政治事件', '武昌起义在上海爆发', '中国同盟会总部设在上海', '中华民国临时政府定都上海'], answer: [0], explanation: '材料列举爱国学社、苏报案等事件，强调其全国影响。', sources: [S('黄花岗起义_章节学习_百度题库', 'https://tiku.baidu.com/tikupc/chapterdetail/90e6ba0d4a7302768e993914-1-5-jiaocai')] } },
  { id: 'P13-en-dialogue', category: '英语·听力文本', need: 'passage', topic: '初中英语 对话理解 职业 未来 want to be',
    reference: { type: 'single',
      material: 'W: Jeff, do you want to be a doctor or a teacher when you grow up?\nM: Neither. I want to be a policeman.',
      question: 'Read the dialogue. What does Jeff want to be when he grows up?', options: ['A doctor.', 'A teacher.', 'A policeman.', 'A driver.'], answer: [2], explanation: 'Jeff says “Neither. I want to be a policeman.”', sources: [S('2004年中考英语模拟试题(六)', 'https://edu.sina.com.cn/en/2004-08-30/25502.html')] } },

  // ───────── 图类（need=figure）：6 张 Commons 原图 + 2 张手绘 SVG ─────────
  { id: 'F01-geo-climate', category: '地理·气候图', need: 'figure', topic: '初中地理 气温曲线和降水量柱状图 判断气候类型 孟买',
    reference: { type: 'single', question: '读图（孟买气温曲线和降水量图），该城市的气候特征是', options: ['全年高温，降水集中在6—9月', '全年温和多雨', '夏季炎热干燥，冬季温和多雨', '全年寒冷，降水稀少'], answer: [0],
      explanation: '气温全年在24℃以上，降水集中在6—9月、冬春几乎无雨，属热带季风气候。', figure: fig('F01-climate', '孟买月平均气温与降水量图'), sources: [S('Wikimedia Commons: Mumbai climate chart', attr['F01-climate'].pageUrl)] } },
  { id: 'F02-phy-circuit', category: '物理·电路图', need: 'figure', topic: '初中物理 串联电路和并联电路 电路图 三盏灯',
    reference: { type: 'single', question: '如图所示，上、下两个电路中三盏灯的连接方式分别是', options: ['上图并联、下图串联', '上图串联、下图并联', '上、下两图均为串联', '上、下两图均为并联'], answer: [0],
      explanation: '上图三盏灯各在一条支路上，为并联；下图三盏灯首尾依次相连，为串联。', figure: fig('F02-circuit', '三盏灯并联（上）与串联（下）的电路图'), sources: [S('Wikimedia Commons: Series and Parallel Circuit', attr['F02-circuit'].pageUrl)] } },
  { id: 'F03-bio-foodweb', category: '生物·食物网图', need: 'figure', topic: '初中生物 食物链 食物网 消费者 营养级 图',
    reference: { type: 'single', question: '读图（切萨皮克湾水鸟食物网），图中的白头海雕（Bald Eagle）属于', options: ['三级消费者', '初级消费者', '次级消费者', '生产者'], answer: [0],
      explanation: '图中把 Osprey 和 Bald Eagle 标注为 Tertiary Consumers（三级消费者）。', figure: fig('F03-foodweb', '切萨皮克湾水鸟食物网，按营养级分层标注'), sources: [S('Wikimedia Commons: Chesapeake Waterbird Food Web', attr['F03-foodweb'].pageUrl)] } },
  { id: 'F04-bio-cell', category: '生物·细胞结构图', need: 'figure', topic: '初中生物 植物细胞结构示意图 叶绿体 细胞壁',
    reference: { type: 'single', question: '读图（植物细胞结构图），进行光合作用的场所是图中标注的', options: ['Chloroplast（叶绿体）', 'Ribosomes（核糖体）', 'Mitochondria（线粒体）', 'Golgi apparatus（高尔基体）'], answer: [0],
      explanation: '叶绿体含叶绿素，是光合作用的场所。', figure: fig('F04-plantcell', '植物细胞结构图，标注叶绿体、细胞壁、液泡等'), sources: [S('Wikimedia Commons: Plant cell structure', attr['F04-plantcell'].pageUrl)] } },
  { id: 'F05-his-ding', category: '历史·文物图', need: 'figure', topic: '初中历史 商朝 青铜器 文物图片 识图题',
    reference: { type: 'single', question: '图中所示青铜器是我国目前已发现的最重的商代青铜礼器，它是', options: ['后母戊鼎（原称司母戊鼎）', '四羊方尊', '大盂鼎', '毛公鼎'], answer: [0],
      explanation: '后母戊鼎重约832.84千克，商代晚期青铜礼器，出土于河南安阳。', figure: fig('F05-ding', '后母戊鼎全景'), sources: [S('Wikimedia Commons: HouMuWuDingFullView', attr['F05-ding'].pageUrl)] } },
  { id: 'F06-his-warriors', category: '历史·文物图', need: 'figure', topic: '初中历史 秦朝 陕西 出土文物 图片 识图题',
    reference: { type: 'single', question: '图中的陶俑坑出土于陕西临潼，它属于哪位帝王的陵园？', options: ['秦始皇', '汉武帝', '唐太宗', '明太祖'], answer: [0],
      explanation: '秦始皇陵兵马俑坑位于陕西临潼，被誉为“世界第八大奇迹”。', figure: fig('F06-warriors', '秦始皇陵一号坑兵马俑'), sources: [S('Wikimedia Commons: Qin Terracotta Warriors, Pit 1', attr['F06-warriors'].pageUrl)] } },
  { id: 'F07-math-triangle', category: '数学·几何图', need: 'figure', topic: '初中数学 勾股定理 直角三角形 求斜边 如图',
    reference: { type: 'fill', question: '如图，在 Rt△ABC 中，∠C＝90°，AC＝3，BC＝4，则 AB＝____。', answer: ['5'], explanation: 'AB²＝AC²＋BC²＝9＋16＝25，故 AB＝5。', svg: svgTriangle, sources: [] } },
  { id: 'F08-chem-solub', category: '化学·溶解度曲线', need: 'figure', topic: '初中化学 溶解度曲线 硝酸钾 读图 60℃',
    reference: { type: 'fill', question: '如图是硝酸钾（KNO₃）的溶解度曲线，60℃时 KNO₃ 的溶解度是____g。', answer: ['110'], explanation: '曲线上60℃对应的纵坐标为110，即100 g水最多溶解110 g KNO₃。', svg: svgSolub, sources: [] } },

  // ───────── 表格数据类（need=table）─────────
  { id: 'T01-gdp', category: '地理·统计表', need: 'table', topic: '初中地理 2023年 国内生产总值 三次产业 统计表 比重',
    reference: { type: 'fill', material: '2023年全国国内生产总值 1260582 亿元。其中：第一产业增加值 89755 亿元；第二产业增加值 482589 亿元；第三产业增加值 688238 亿元。',
      question: '根据上表数据，2023年第三产业增加值占国内生产总值的比重约为____%（保留一位小数）。', answer: ['54.6'], explanation: '688238÷1260582≈54.6%。', sources: [S('2023年国民经济和社会发展统计公报', 'https://www.stats.gov.cn/sj/zxfb/202402/t20240228_1947915.html')] } },
  { id: 'T02-census', category: '政治·统计表', need: 'table', topic: '初中道德与法治 第七次全国人口普查 年龄构成 表格 人口老龄化',
    reference: { type: 'single', material: '第七次全国人口普查（2020年）年龄构成：0—14岁 25338万人，占17.95%；15—59岁 89438万人，占63.35%；60岁及以上 26402万人，占18.70%（其中65岁及以上19064万人，占13.50%）。',
      question: '据表中数据，60岁及以上人口占比达18.70%，这反映我国面临的人口问题之一是', options: ['人口老龄化程度加深', '人口增长过快', '性别比严重失调', '青少年人口占绝大多数'], answer: [0], explanation: '60岁及以上占比接近两成，65岁及以上占13.5%，老龄化加深。', sources: [S('第七次全国人口普查公报（第五号）', 'https://www.stats.gov.cn/zt_18555/zdtjgz/zgrkpc/dqcrkpc/ggl/202302/t20230215_1904001.html')] } },
  { id: 'T03-chem-periodic', category: '化学·元素周期表', need: 'table', topic: '初中化学 元素周期表 第二周期 原子序数 表格',
    reference: { type: 'fill', material: '元素周期表（第二周期）：\n原子序数 3 4 5 6 7 8 9 10\n元素符号 Li Be B C N O F Ne\n元素名称 锂 铍 硼 碳 氮 氧 氟 氖',
      question: '根据上表，氧元素的原子序数是____。', answer: ['8'], explanation: '表中 O（氧）对应原子序数 8。', sources: [] } },
  { id: 'T04-math-freq', category: '数学·频数分布表', need: 'table', topic: '初中数学 频数分布表 成绩统计 百分比 计算',
    reference: { type: 'single', material: '某班40名学生数学测验成绩频数分布：\n分数段 60～70 | 70～80 | 80～90 | 90～100\n人数 4 | 10 | 18 | 8',
      question: '该班成绩在80分及以上的学生占全班的百分比是', options: ['65%', '45%', '55%', '26%'], answer: [0], explanation: '(18＋8)÷40＝65%。', sources: [] } },
  { id: 'T05-phy-ohm', category: '物理·实验数据表', need: 'table', topic: '初中物理 欧姆定律 探究电流与电压关系 实验数据表',
    reference: { type: 'fill', material: '某导体两端电压 U 与通过的电流 I 的实验数据：\nU/V 1.0 2.0 3.0\nI/A 0.10 0.20 0.30',
      question: '根据表中数据，该导体的电阻 R＝____Ω。', answer: ['10'], explanation: 'R＝U/I＝1.0÷0.10＝10 Ω。', sources: [] } },

  // ───────── 其它依赖类 ─────────
  { id: 'M01-pol-cartoon', category: '政治·漫画题', need: 'figure', topic: '初中道德与法治 漫画题 光盘行动 节约粮食 漫画',
    reference: { type: 'single', material: '漫画描述：一个人一手举着“厉行节约、光盘行动”的牌子，另一手把刚吃了两口的一整盘菜倒进垃圾桶。',
      question: '这幅漫画讽刺的现象是', options: ['言行不一、浪费粮食', '生产粮食的艰辛', '食品安全问题', '垃圾分类回收'], answer: [0], explanation: '口号与行为相反，讽刺言行不一与浪费。', sources: [] } },
  { id: 'M02-geo-daylength', category: '地理·数据推理', need: 'table', topic: '初中地理 昼夜长短 二分二至 昼长 数据 判断半球',
    reference: { type: 'single', material: '某地不同节气的昼长：春分日 12 小时；夏至日 15 小时；秋分日 12 小时；冬至日 9 小时。',
      question: '据上述数据判断，该地位于', options: ['北半球中纬度', '南半球中纬度', '赤道', '极点'], answer: [0], explanation: '夏至昼长、冬至昼短，说明位于北半球，且昼长变化明显，属中纬度。', sources: [] } },

  // ───────── 对照组（need=none）：本来就不依赖外部材料，检查审查闸不误杀 ─────────
  { id: 'C01-newton3', category: '物理·概念', need: 'none', topic: '牛顿第三定律', reference: { type: 'single', question: '关于牛顿第三定律，下列说法正确的是', options: ['作用力与反作用力大小相等、方向相反、作用在不同物体上', '作用力与反作用力作用在同一物体上', '作用力大于反作用力', '只有物体静止时才成立'], answer: [0], explanation: '作用力与反作用力等大反向，作用在两个不同物体上。', sources: [] } },
  { id: 'C02-photosynthesis', category: '生物·概念', need: 'none', topic: '光合作用 原料 产物', reference: { type: 'single', question: '光合作用的产物是', options: ['有机物和氧气', '二氧化碳和水', '淀粉和二氧化碳', '氧气和水'], answer: [0], explanation: '光合作用以二氧化碳和水为原料，产生有机物并释放氧气。', sources: [] } },
  { id: 'C03-pythagoras', category: '数学·概念', need: 'none', topic: '勾股定理 公式', reference: { type: 'fill', question: '直角三角形两直角边分别为6和8，则斜边长为____。', answer: ['10'], explanation: '√(6²＋8²)＝10。', sources: [] } },
  { id: 'C04-civil-code', category: '政治·概念', need: 'none', topic: '民法典 成年人年龄 民事行为能力', reference: { type: 'single', question: '我国民法典规定，成年人是指年满多少周岁的自然人？', options: ['18周岁', '16周岁', '20周岁', '14周岁'], answer: [0], explanation: '民法典第十七条：十八周岁以上的自然人为成年人。', sources: [] } },
  { id: 'C05-yueyanglou-fill', category: '语文·识记', need: 'none', topic: '语文 名句出处 先天下之忧而忧', reference: { type: 'fill', question: '“先天下之忧而忧，后天下之乐而乐”出自宋代范仲淹的《____》。', answer: ['岳阳楼记'], explanation: '出自《岳阳楼记》。', sources: [] } },
];

const out = {
  version: 'complete-v1',
  spec: '出题自包含评测集（判据见 docs/eval/complete.md、契约 docs/QUIZ-COMPLETE-SPEC.md）',
  provenance: 'agent-hand-with-web-search',
  note: [
    '33 个用例：13 阅读材料 / 9 图类（6 张 Wikimedia Commons 开源原图＋2 张手绘 SVG＋1 幅文字描述漫画）/ 6 表格数据 / 5 对照（不依赖外部材料，量误杀）。',
    '每例的 reference 是「标杆」：由人（本轮为 Arena Agent）先联网检索、再手写的一道自包含题；references[].sources 记检索到的来源，无来源者标明是自编。',
    'need=none 的对照组用来检验审查闸不会把正常题当无头题误杀。',
    '只增行、不改已有条目——改已有条目＝升 v2，旧报告才保住可比性。',
  ],
  cases,
};
fs.writeFileSync(path.join(here, '..', 'complete-v1.json'), JSON.stringify(out, null, 2));
const c = (n) => cases.filter((x) => x.need === n).length;
console.log(`cases=${cases.length} passage=${c('passage')} figure=${c('figure')} table=${c('table')} none=${c('none')}`);
