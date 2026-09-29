import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '@sb/shared';
import { assessQuestion, findDependencies, sanitizePhoto } from './quiz-completeness.js';

const q = (over: Partial<QuizQuestion>): QuizQuestion => ({ type: 'single', question: '题干', options: ['甲', '乙'], answer: [0], ...over });
const PASSAGE = '我说道：“爸爸，你走吧。”他往车外看了看，说：“我买几个橘子去。你就在此地，不要走动。”我看见他戴着黑布小帽，穿着黑布大马褂，深青布棉袍，蹒跚地走到铁道边。';

describe('findDependencies —— 悬空引用识别', () => {
  it.each([
    ['阅读材料可知，作者的态度是（　）', 'passage'],
    ['根据材料一，下列说法正确的是', 'passage'],
    ['结合材料，分析洋务运动的性质', 'passage'],
    ['由上述材料可知，该观点主张', 'passage'],
    ['What can we learn from the passage?', 'passage'],
    ['52. The writer thinks that________.', 'passage'],
    ['Paragraph One tells us that ________.', 'passage'],
    ['文中画线句“于是扑扑衣上的泥土”的理解是', 'passage'],
    ['对文中加点字的解释正确的是', 'passage'],
    ['如图所示，电路中开关闭合后灯亮的是', 'figure'],
    ['读图，甲地的气候类型是', 'figure'],
    ['图中②所示结构是', 'figure'],
    ['下图为某地气温曲线，该地位于', 'figure'],
    ['根据下表数据，第三产业占比为', 'table'],
    ['表中数据说明了什么', 'table'],
    ['据上述数据判断，该地位于', 'table'],
  ])('%s → %s', (question, kind) => {
    expect(findDependencies({ question }).map((d) => d.kind)).toContain(kind);
  });

  it.each([
    '根据牛顿第三定律，作用力与反作用力大小相等',
    '光合作用的场所是叶绿体，表面积越大越有利于吸收',
    '如图书馆案例所述的做法不属于……'.replace('如图书馆案例所述的', '图书馆里的'),
    '下列材料中，属于导体的是',
    '中国古代地图学的代表人物是谁',
    '“不以物喜，不以己悲”的“以”是什么意思',
    '在直角三角形中，勾股定理的内容是',
    'Charles Dickens was a famous writer. He wrote ________.',
    'Lu Xun is the author of ________.',
    '在横线上填写正确的答案：光合作用的产物是____',
  ])('概念题不误杀：%s', (question) => {
    expect(findDependencies({ question, options: ['甲', '乙'] })).toEqual([]);
  });

  it('选项里的引用也算（「材料中提到的是」）', () => {
    expect(findDependencies({ question: '下列说法正确的是', options: ['材料中提到的措施是改革', '其他'] }).map((d) => d.kind)).toContain('passage');
  });
});

describe('assessQuestion —— 引用了，但给没给', () => {
  it('引用材料却没给 ⇒ 悬空', () => {
    const a = assessQuestion(q({ question: '阅读材料可知，作者的态度是（　）' }));
    expect(a.complete).toBe(false);
    expect(a.missing[0]?.kind).toBe('passage');
  });
  it('material 字段给了材料 ⇒ 放行', () => {
    expect(assessQuestion(q({ question: '阅读材料可知，作者的态度是（　）', material: PASSAGE })).complete).toBe(true);
  });
  it('material 太短（「见上」）不算给了', () => {
    expect(assessQuestion(q({ question: '阅读材料可知……', material: '见上文' })).complete).toBe(false);
  });
  it('选项黏在题干后面不算内联材料（评测抓到的 According to the passage 漏网）', () => {
    const glued = 'According to the passage, why did Columbus go to Lisbon? -A. In order to learn chart making. -B. For no particular reason and without planning to do so. -C. Because he could not find work in Genoa. -D. Because he needed to recruit sailors for a voyage.';
    expect(assessQuestion(q({ question: glued, options: [] })).complete).toBe(false);
  });
  it('材料内联在题干里 ⇒ 放行（引用句之外的实质内容够长）', () => {
    expect(assessQuestion(q({ question: `${PASSAGE}\n根据上述材料，作者写了什么？` })).complete).toBe(true);
  });
  it('图：有 svg / photo 放行，只有一句「如图」不放行', () => {
    expect(assessQuestion(q({ question: '如图所示，求 x' })).complete).toBe(false);
    expect(assessQuestion(q({ question: '如图所示，求 x', svg: '<svg viewBox="0 0 10 10"></svg>' })).complete).toBe(true);
    expect(assessQuestion(q({ question: '如图所示，求 x', photo: { src: '/api/images/a.png', alt: '', credit: '' } })).complete).toBe(true);
  });
  it('图：material 是一段普通文段不算图；以「漫画描述：」开头的文字转述才算', () => {
    expect(assessQuestion(q({ question: '如图所示，作者的态度是', material: PASSAGE })).complete).toBe(false);
    expect(assessQuestion(q({ question: '如图所示，漫画反映的现象是', material: '漫画描述：一个人正在给已经枯死的树浇水，旁边的小树苗无人问津。' })).complete).toBe(true);
  });
  it('表：material 里得有数据（≥3 个数字或多行），一句话描述不行', () => {
    expect(assessQuestion(q({ question: '根据下表，占比最大的是', material: '这是一张各产业占比的统计表格' })).complete).toBe(false);
    expect(assessQuestion(q({ question: '根据下表，占比最大的是', material: '第一产业 7.1%\n第二产业 38.3%\n第三产业 54.6%' })).complete).toBe(true);
  });
  it('没有任何引用的题天然完整', () => {
    expect(assessQuestion(q({ question: '光合作用的场所是（　）' })).complete).toBe(true);
  });
});

describe('sanitizePhoto —— commit 不信任客户端的图', () => {
  const name = `${'a'.repeat(32)}.png`;
  it('本站缓存图放行并规范字段', () => {
    expect(sanitizePhoto({ src: `/api/images/${name}`, alt: 'x', credit: 'c', pageUrl: 'https://a.test/p', essential: true, evil: 1 })).toEqual({
      src: `/api/images/${name}`, alt: 'x', credit: 'c', pageUrl: 'https://a.test/p', essential: true,
    });
  });
  it.each(['https://evil.test/a.png', '/api/images/../../etc/passwd', 'javascript:alert(1)', `/api/images/${'a'.repeat(32)}.svg`, ''])('拒绝 %s', (src) => {
    expect(sanitizePhoto({ src, alt: '', credit: '' })).toBeUndefined();
  });
  it('pageUrl 只认 http(s)', () => {
    expect(sanitizePhoto({ src: `/api/images/${name}`, alt: '', credit: '', pageUrl: 'javascript:1' })?.pageUrl).toBeUndefined();
  });
});
