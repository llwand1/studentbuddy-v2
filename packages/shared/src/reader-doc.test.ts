/**
 * reader-doc：阅读页块模型的纯函数（契约 `docs/SOURCE-TRACE-SPEC.md` §14.3）。
 *
 * 最要紧的是 `sectionForBlock`——划线之后送给模型的上下文全靠它。钉三件事：
 *   ① 章节边界按**标题级别**算：h2 的章节在下一个 h2 / h1 处断，h3 不打断它
 *      （算错 = 要么把整页塞进去，要么只给一句话，两头都让 AI 讲偏）；
 *   ② **无标题页**不能返回空：很多博客正文就是一串 p，退回邻域；
 *   ③ 章节里**一定包含划线那段**（它本来就在章节内）。
 */
import { describe, expect, it } from 'vitest';
import {
  READER_SECTION_MAX,
  READER_SELECTION_MAX,
  blockText,
  buildReaderSelection,
  clipText,
  isUsableSelection,
  readerPlainText,
  sectionForBlock,
  type ReaderBlock,
} from './reader-doc.js';

const h = (id: string, level: 1 | 2 | 3, v: string): ReaderBlock => ({ t: 'h', id, level, spans: [{ t: 'text', v }] });
const p = (id: string, v: string): ReaderBlock => ({ t: 'p', id, spans: [{ t: 'text', v }] });

/** h1 总 / h2 甲（p1 p2）/ h3 甲一（p3）/ h2 乙（p4） */
const doc: ReaderBlock[] = [h('b0', 1, '总标题'), h('b1', 2, '甲'), p('b2', '甲的第一段'), p('b3', '甲的第二段'), h('b4', 3, '甲一'), p('b5', '甲一的段'), h('b6', 2, '乙'), p('b7', '乙的段')];

describe('sectionForBlock：章节边界按标题级别算', () => {
  it('① h2「甲」的章节收到下一个 h2 为止，中间的 h3 不打断', () => {
    const s = sectionForBlock(doc, 'b2');
    expect(s.heading).toBe('甲');
    expect(s.text).toContain('甲的第一段');
    expect(s.text).toContain('甲一的段'); // h3 是子节，仍属于甲
    expect(s.text).not.toContain('乙的段'); // 下一个 h2 处断开
  });

  it('① 划在 h3 底下 ⇒ 归最近的标题 h3「甲一」，不是 h2', () => {
    const s = sectionForBlock(doc, 'b5');
    expect(s.heading).toBe('甲一');
    expect(s.text).not.toContain('甲的第一段');
  });

  it('③ 章节一定含划线那段自己', () => {
    expect(sectionForBlock(doc, 'b7').text).toContain('乙的段');
  });

  it('② 无标题页退回邻域，不返回空（否则 AI 没上下文会讲偏）', () => {
    const flat = [p('b0', '一'), p('b1', '二'), p('b2', '三'), p('b3', '四'), p('b4', '五')];
    const s = sectionForBlock(flat, 'b2');
    expect(s.heading).toBe('');
    expect(s.text).toContain('三');
    expect(s.text.length).toBeGreaterThan(0);
  });

  it('找不到的块 id ⇒ 空而不是抛', () => {
    expect(sectionForBlock(doc, 'nope')).toEqual({ heading: '', text: '' });
  });
});

describe('buildReaderSelection：三个动作共用同一份预算', () => {
  it('组出 text / heading / section / 出处四件套', () => {
    const sel = buildReaderSelection({
      blocks: doc,
      blockIds: ['b2'],
      selected: '  甲的第一段  ',
      sourceTitle: '某篇文章',
      sourceUrl: 'https://example.com/a',
    });
    expect(sel.text).toBe('甲的第一段');
    expect(sel.heading).toBe('甲');
    expect(sel.section).toContain('甲的第一段');
    expect(sel.sourceUrl).toBe('https://example.com/a');
  });

  it('选区与章节各自截断（预算集中在这里，不让各动作自己发挥）', () => {
    const long = 'x'.repeat(READER_SELECTION_MAX + 500);
    const sel = buildReaderSelection({ blocks: [p('b0', 'y'.repeat(READER_SECTION_MAX + 900))], blockIds: ['b0'], selected: long, sourceTitle: 't', sourceUrl: 'https://e.com' });
    expect(sel.text.length).toBeLessThanOrEqual(READER_SELECTION_MAX + 1);
    expect(sel.section.length).toBeLessThanOrEqual(READER_SECTION_MAX + 1);
  });

  it('没有块 id（选区落在块外）也不炸，只是没有章节', () => {
    const sel = buildReaderSelection({ blocks: doc, blockIds: [], selected: '随便', sourceTitle: 't', sourceUrl: 'https://e.com' });
    expect(sel.text).toBe('随便');
    expect(sel.section).toBe('');
  });
});

describe('工具函数', () => {
  it('clipText 断在边界并加省略号，短文本原样', () => {
    expect(clipText('短', 100)).toBe('短');
    expect(clipText('  多   空白  折叠 ', 100)).toBe('多 空白 折叠');
    expect(clipText('a'.repeat(50), 10)).toHaveLength(11);
    expect(clipText('a'.repeat(50), 10).endsWith('…')).toBe(true);
  });

  it('blockText 取得到各种块的文字；图片取 alt、分隔线为空', () => {
    expect(blockText(p('b0', '文'))).toBe('文');
    expect(blockText({ t: 'pre', id: 'b1', v: 'code()' })).toBe('code()');
    expect(blockText({ t: 'img', id: 'b2', src: 'https://e.com/a.png', alt: '图说' })).toBe('图说');
    expect(blockText({ t: 'hr', id: 'b3' })).toBe('');
  });

  it('readerPlainText 跳过空块', () => {
    expect(readerPlainText([p('b0', '一'), { t: 'hr', id: 'b1' }, p('b2', '二')])).toBe('一\n二');
  });

  it('isUsableSelection：点一下选中一个标点不该让按钮亮起来', () => {
    expect(isUsableSelection('。')).toBe(false);
    expect(isUsableSelection('   ')).toBe(false);
    expect(isUsableSelection('闭包')).toBe(true);
  });
});
