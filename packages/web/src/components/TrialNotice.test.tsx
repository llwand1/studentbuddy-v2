// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrialNotice } from './TrialNotice';

/**
 * 侧栏底部线上版定位提醒（TrialNotice）的锁。
 * 这条提醒是「说给长期使用者听」的承诺——写错链接（指到别处/丢了锚点）
 * 或整行不再渲染，都只有在这里拦得住：gates 不查文案，落地页测试不覆盖应用壳。
 */
describe('TrialNotice — 侧栏底部线上版定位提醒', () => {
  it('口径完整：演示/试用定位 + 本地安装包版引导，链接与落地页 GitHub 横幅同目标（README 快速开始）', () => {
    const { container, getByText } = render(<TrialNotice />);
    expect(container.textContent).toContain('功能演示与试用');
    expect(container.textContent).toContain('长期使用建议装');
    const link = getByText('本地安装包版');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/llwand1/studentbuddy-v2#快速开始',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
