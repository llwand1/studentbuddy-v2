import { describe, expect, it } from 'vitest';
import { menuStatus } from './composer-status';

/**
 * 锁的是「把联网开关收进折叠菜单之后，状态还会不会丢」。
 * 这条值得单独测：它唯一的消费者是菜单标题行，写错了**界面不会报错、只是少一句提示**，
 * 而用户因此以为联网没开（或以为开着其实已关）——正是最难被发现的那类退化。
 */
describe('menuStatus（输入框「+」菜单的状态摘要）', () => {
  it('联网开着必须说——这是收进折叠菜单后唯一会失去可见性的状态', () => {
    expect(menuStatus({ online: true })).toBe('联网已开');
  });

  it('联网关着什么都不说：关掉是用户的主动选择，不是需要提醒的异常', () => {
    expect(menuStatus({ online: false })).toBeNull();
  });

  it('载入资料时报名字——这轮回答会依据资料，也是收进菜单后失去可见性的状态', () => {
    expect(menuStatus({ online: false, docBase: '复习讲义' })).toBe('资料 复习讲义');
    expect(menuStatus({ online: true, docBase: '复习讲义' })).toBe('联网已开 · 资料 复习讲义');
  });

  it('超长资料名截断加省略号：状态行要短，不能把「+」撑成一整行', () => {
    const r = menuStatus({ online: false, docBase: '物理化学复习讲义第二版修订稿' });
    expect(r).toBe('资料 物理化学复习讲义第二…');
    expect(r!.length).toBeLessThan(20);
  });

  it('刚好 10 字不截断（边界不多切一个字）', () => {
    expect(menuStatus({ online: false, docBase: '一二三四五六七八九十' })).toBe('资料 一二三四五六七八九十');
  });

  it('空串 / 纯空白的资料名按「没有」处理，不产出「资料 」这种半截状态', () => {
    expect(menuStatus({ online: false, docBase: '' })).toBeNull();
    expect(menuStatus({ online: false, docBase: '   ' })).toBeNull();
    expect(menuStatus({ online: false, docBase: null })).toBeNull();
    expect(menuStatus({ online: true, docBase: '' })).toBe('联网已开');
  });
});
