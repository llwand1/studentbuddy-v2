/**
 * composer-placeholder（契约 docs/MOBILE-SPEC.md §3.1）：状态优先级两端一致；手机版短句、桌面版带快捷键说明。
 */
import { describe, expect, it } from 'vitest';
import { composerPlaceholder } from './composer-placeholder';

describe('composerPlaceholder', () => {
  it.each([
    [false, '问点什么，发送就会开一个新对话（Enter 发送 / Shift+Enter 换行，可直接粘贴图片）'],
    [true, '问点什么，发送就开一个新对话'],
  ])('未选会话（narrow=%s）', (narrow, text) => {
    expect(composerPlaceholder({ sessionId: null, blocked: false, busy: false, narrow })).toBe(text);
  });
  it('开新对话中 / 生成中 / 未就绪：三种阻塞态两端同一句，不被手机短句覆盖', () => {
    for (const narrow of [false, true]) {
      expect(composerPlaceholder({ sessionId: null, blocked: true, busy: false, narrow })).toBe('正在开新对话…');
      expect(composerPlaceholder({ sessionId: 's', blocked: true, busy: true, narrow })).toBe('生成中…（Esc 停止）');
      expect(composerPlaceholder({ sessionId: 's', blocked: true, busy: false, narrow })).toBe('连接未就绪…');
    }
  });
  it('会话内可输入：桌面带快捷键说明、手机只有一句；手机句长 ≤ 16 字', () => {
    expect(composerPlaceholder({ sessionId: 's', blocked: false, busy: false, narrow: false })).toContain('Shift+Enter');
    const m = composerPlaceholder({ sessionId: 's', blocked: false, busy: false, narrow: true });
    expect(m).not.toContain('Enter');
    expect(Array.from(m).length).toBeLessThanOrEqual(16);
  });
});
