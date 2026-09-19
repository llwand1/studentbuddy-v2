/**
 * entry — 启动渲染分支锁（2026-09-20 本地/线上形态分叉批，契约 AUTH-SPEC §2.9；纯函数零依赖）。
 * 钉的是四条产品口径，写错不报错、只是把错误的页面怼给用户：
 * · 已登录 → 应用壳（两种形态一致——本地也允许登录，只是不强制）；
 * · 未登录 + local → **免登录直进应用壳**（本地单人形态的核心承诺）；
 * · 未登录 + cloud → 落地页。
 */
import { describe, expect, it } from 'vitest';
import { entryFor } from './entry';

describe('app/entry — 启动渲染分支（AUTH-SPEC §2.9）', () => {
  it('已登录 → 应用壳，形态无关（cloud/local 一致）', () => {
    const user = { id: 'u-1', email: 'a@b.com', nickname: 'A', createdAt: '2026-09-20 00:00:00' };
    expect(entryFor(user, 'cloud')).toBe('app');
    expect(entryFor(user, 'local')).toBe('app');
  });

  it('未登录 + local 本地单人形态 → 免登录直进应用壳', () => {
    expect(entryFor(null, 'local')).toBe('app');
  });

  it('未登录 + cloud 线上形态 → 落地页', () => {
    expect(entryFor(null, 'cloud')).toBe('landing');
  });
});
