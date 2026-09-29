import { describe, expect, it, vi } from 'vitest';
import { emptyCollectCompleteness, type QuizQuestion } from '@sb/shared';
import { adjacentFigureBefore, markImages, materialCoverage, parseFigureNumbers, resolveCandidate, resolveImageUrl, stripMarkers, MAX_FIGURES_PER_PAGE } from './collect-figures.js';
import { normalizeForAnchor } from './collect.js';

const PAGE = 'https://exam.test/paper/1.html';

describe('markImages', () => {
  it('题图换成编号标记，相对地址按页面 URL 解析，懒加载属性优先', () => {
    const { html, figures } = markImages('<p>如图所示</p><img src="/p/a.png" alt="电路图"><img data-src="b.jpg" src="placeholder.gif">', PAGE, 0);
    expect(figures).toEqual([{ n: 1, url: 'https://exam.test/p/a.png', alt: '电路图' }, { n: 2, url: 'https://exam.test/paper/b.jpg', alt: '' }]);
    expect(html).toContain('[图1:电路图]');
    expect(html).toContain('[图2]');
  });
  it('编号从 startN 之后接着数（跨页全局唯一）', () => {
    expect(markImages('<img src="/a.png">', PAGE, 4).figures[0]?.n).toBe(5);
  });
  it.each([
    ['data URI', '<img src="data:image/png;base64,AAAA">'],
    ['svg', '<img src="/a.svg">'],
    ['gif', '<img src="/a.gif">'],
    ['过小', '<img src="/a.png" width="20" height="20">'],
    ['logo 类', '<img src="/a.png" class="site-logo">'],
    ['二维码', '<img src="/img/qrcode.png">'],
    ['javascript:', '<img src="javascript:alert(1)">'],
    ['nav 里的图', '<nav><img src="/n.png"></nav>'],
  ])('跳过 %s', (_n, tag) => {
    expect(markImages(tag, PAGE, 0).figures).toEqual([]);
  });
  it(`每页最多 ${MAX_FIGURES_PER_PAGE} 张`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `<img src="/i${i}.png">`).join('');
    expect(markImages(many, PAGE, 0).figures).toHaveLength(MAX_FIGURES_PER_PAGE);
  });
  it('resolveImageUrl 只认 http(s)', () => {
    expect(resolveImageUrl('//cdn.test/a.png', PAGE)).toBe('https://cdn.test/a.png');
    expect(resolveImageUrl('ftp://x/a.png', PAGE)).toBeNull();
  });
  it('标记不参与锚点：剥掉后题干前缀仍能连续命中', () => {
    const text = '5．如图所示[图3:电路图]，闭合开关后灯泡亮的是';
    expect(normalizeForAnchor(stripMarkers(text))).toContain(normalizeForAnchor('如图所示，闭合开关后灯泡亮的是'));
  });
});

describe('markImages 懒加载', () => {
  it('新浪博客式 real_src（src 是占位 gif）取真图', () => {
    const r = markImages('<img src="//x.test/sg_trans.gif" real_src ="https://s15.test/mw690/a.png" alt="食物网图片"> 题', PAGE, 0);
    expect(r.figures).toHaveLength(1);
    expect(r.figures[0]!.url).toBe('https://s15.test/mw690/a.png');
  });
});

describe('materialCoverage —— 材料必须逐字出自页面', () => {
  const page = normalizeForAnchor('材料一：一八七二年，李鸿章在奏折中写道，今日之事，实为三千年未有之变局。洋务运动由此展开，先办军工，后办民用企业。');
  it('逐字（标点/空白差异不算）≥ 门槛', () => {
    expect(materialCoverage('一八七二年，李鸿章在奏折中写道：“今日之事，实为三千年未有之变局。”', page, normalizeForAnchor)).toBe(1);
  });
  it('概述式改写命不中', () => {
    expect(materialCoverage('李鸿章认为当时中国面临着前所未有的巨大变化，需要办洋务来自强', page, normalizeForAnchor)).toBeLessThan(0.5);
  });
});

describe('resolveCandidate', () => {
  const norm = normalizeForAnchor;
  const mk = (over: Partial<QuizQuestion> & { figures?: unknown }): QuizQuestion & { figures?: unknown } => ({ type: 'single', question: '如图所示，图中②是什么（　）', options: ['叶绿体', '线粒体'], answer: [0], ...over });
  const png = new Uint8Array([137, 80, 78, 71]);
  const deps = (ok = true) => ({
    download: vi.fn(async () => (ok ? { ok: true as const, bytes: png, ext: 'png', mime: 'image/png' } : { ok: false as const, kind: 'error' as const, reason: 'x' })),
    save: vi.fn(() => ({ name: `${'b'.repeat(32)}.png`, created: true })),
    visionReady: () => false,
  });
  const ctx = (d: ReturnType<typeof deps>, normText = '') => ({
    page: { url: PAGE, title: 'P', normText, figures: [{ n: 3, url: 'https://exam.test/p/a.png', alt: '' }] },
    norm, ownerId: null, report: emptyCollectCompleteness(), deps: d,
  });

  it('题图搬到本站缓存，photo 指回原页面、标 essential ⇒ ok', async () => {
    const d = deps();
    const c = ctx(d);
    const r = await resolveCandidate(mk({ figures: [3] }), c);
    expect(r.ok).toBe(true);
    expect(r.question.photo).toMatchObject({ src: `/api/images/${'b'.repeat(32)}.png`, essential: true, pageUrl: PAGE });
    expect(r.question.photo?.credit).toContain('exam.test');
    expect(r.question).not.toHaveProperty('figures');
    expect(c.report.figuresAttached).toBe(1);
  });
  it('题干依赖图但模型没给编号 ⇒ ok:false 并说明', async () => {
    const c = ctx(deps());
    const r = await resolveCandidate(mk({}), c);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('依赖图');
    expect(c.report.rejectedIncomplete).toBe(1);
  });
  it('编号不属于本页（跨页/编造）⇒ 不搬，ok:false', async () => {
    const d = deps();
    const r = await resolveCandidate(mk({ figures: [9] }), ctx(d));
    expect(d.download).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });
  it('下载失败 ⇒ ok:false，计入 figuresFailed', async () => {
    const c = ctx(deps(false));
    const r = await resolveCandidate(mk({ figures: [3] }), c);
    expect(r.ok).toBe(false);
    expect(c.report.figuresFailed).toBe(1);
  });
  it('material 逐字出自页面 ⇒ 保留；编造的 material 丢弃，题仍依赖材料 ⇒ ok:false', async () => {
    const page = norm('材料：一八七二年，李鸿章在奏折中写道，今日之事，实为三千年未有之变局。洋务运动由此展开。');
    const real = '一八七二年，李鸿章在奏折中写道：今日之事，实为三千年未有之变局。洋务运动由此展开。';
    const okR = await resolveCandidate(mk({ question: '阅读材料可知，洋务运动由何展开（　）', material: real }), ctx(deps(), page));
    expect(okR.ok).toBe(true);
    expect(okR.question.material).toBe(real);
    const fake = await resolveCandidate(mk({ question: '阅读材料可知，洋务运动由何展开（　）', material: '这是模型自己编写的一段并不存在于任何网页中的材料文字内容。' }), ctx(deps(), page));
    expect(fake.ok).toBe(false);
    expect(fake.question.material).toBeUndefined();
  });
  it('模型把编号写成 "[图3]" / "图3" 字符串也认（实测 agnes-2.5-flash 就这么写）', async () => {
    for (const f of [['[图3]'], ['图3'], ['3'], [3]]) {
      const r = await resolveCandidate(mk({ figures: f }), ctx(deps()));
      expect(r.ok).toBe(true);
      expect(r.question.photo).toBeDefined();
    }
  });
  it('模型漏写 figures，但图紧贴在题干前面 ⇒ 兜底取那张；隔得远则不猜', async () => {
    const near = { ...ctx(deps()), page: { ...ctx(deps()).page, text: '试题详情 [图3] 如图所示，图中②是什么（ ）A．叶绿体' } };
    const r = await resolveCandidate(mk({}), near);
    expect(r.ok).toBe(true);
    expect(r.question.photo).toBeDefined();
    const far = { ...ctx(deps()), page: { ...ctx(deps()).page, text: `[图3] ${'无关内容。'.repeat(40)} 如图所示，图中②是什么（ ）` } };
    expect((await resolveCandidate(mk({}), far)).ok).toBe(false);
  });
  it('下载到的是 gif（占位图/加载动画）⇒ 不当题图，ok:false', async () => {
    const d = deps();
    d.download.mockResolvedValueOnce({ ok: true as const, bytes: png, ext: 'gif', mime: 'image/gif' });
    const r = await resolveCandidate(mk({ figures: [3] }), ctx(d));
    expect(r.ok).toBe(false);
    expect(r.question.photo).toBeUndefined();
    expect(d.save).not.toHaveBeenCalled();
  });
  it('本来就自包含的题不受影响', async () => {
    const r = await resolveCandidate(mk({ question: '光合作用的场所是（　）' }), ctx(deps()));
    expect(r.ok).toBe(true);
  });
});

describe('parseFigureNumbers / adjacentFigureBefore', () => {
  it('parseFigureNumbers：数字、数字串、带标记的串、去重、丢垃圾', () => {
    expect(parseFigureNumbers([1, '2', '[图3]', '图4', 'x', 2, 0, -1, null])).toEqual([1, 2, 3, 4]);
    expect(parseFigureNumbers('1')).toEqual([]);
    expect(parseFigureNumbers(undefined)).toEqual([]);
  });
  it('adjacentFigureBefore：取紧贴题干前的最后一个标记；空白差异不影响', () => {
    expect(adjacentFigureBefore('上一题 D．丁 [图1] 下一题\n[图2:电路]\n 1． 如图所示的电路中，开关闭合后', '如图所示的电路中，开关闭合后灯亮')).toBe(2);
  });
  it('adjacentFigureBefore：题干前没有图/隔得远/题干找不到 ⇒ null；题号前缀不干扰', () => {
    expect(adjacentFigureBefore('如图所示的电路中，开关闭合后', '如图所示的电路中，开关闭合后')).toBeNull();
    expect(adjacentFigureBefore(`[图1]${'字'.repeat(200)}如图所示的电路中，开关闭合后`, '如图所示的电路中，开关闭合后')).toBeNull();
    expect(adjacentFigureBefore('[图1]完全不同的文字', '如图所示的电路中，开关闭合后')).toBeNull();
    expect(adjacentFigureBefore('[图5] 12．如图所示的电路中，开关闭合后', '12. 如图所示的电路中，开关闭合后')).toBe(5);
  });
});
