import { describe, expect, it } from 'vitest';
import { splitDocName } from './doc-name';

/**
 * 这条锁的是「pill 截断时扩展名不丢」这件事的输入拆分，不是样式渲染。
 * 之所以值得单列一测：函数只有两行，但它的三个边界（无点、点在首位、多点号）
 * 恰好对应界面会真出现的三种名字，写错就是渲染时少一段文本、且不会报错——最难发现的那种。
 */
describe('splitDocName（文档 pill 的文件名拆分）', () => {
  it('常规中文名与英文名都拆出扩展名', () => {
    expect(splitDocName('复习讲义.txt')).toEqual({ base: '复习讲义', ext: '.txt' });
    expect(splitDocName('notes.md')).toEqual({ base: 'notes', ext: '.md' });
  });

  it('多个点号只认最后一个：中间带点的名字，扩展名仍取末段', () => {
    expect(splitDocName('物理化学复习讲义.v2.final.md')).toEqual({
      base: '物理化学复习讲义.v2.final',
      ext: '.md',
    });
  });

  it('无扩展名（粘贴资料的默认名）时 ext 是空串——调用方据此不渲染那个 span', () => {
    const r = splitDocName('粘贴资料');
    expect(r).toEqual({ base: '粘贴资料', ext: '' });
    expect(r.ext).toBeFalsy();
  });

  it('点号在首字符不算扩展名：`.gitignore` 整名就是文件名，拆了会剩个空 base', () => {
    expect(splitDocName('.gitignore')).toEqual({ base: '.gitignore', ext: '' });
  });

  it('空串进来不炸（返回空 base 与空 ext）', () => {
    expect(splitDocName('')).toEqual({ base: '', ext: '' });
  });

  it('往返不变量：base + ext 必须逐字还原原名，且 base 不为空时 ellipsis 才有东西可截', () => {
    for (const n of ['a.txt', '无扩展', '.env', 'x.y.z.md', '', '结尾有点.', '....']) {
      const { base, ext } = splitDocName(n);
      expect(base + ext).toBe(n);
    }
  });
});
